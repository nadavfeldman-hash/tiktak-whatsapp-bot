// The safety tests.
//
// Everything here is about one question: can a message reach a real customer
// when it should not? Nothing else is tested, because nothing else has ever
// caused damage. A broken report is an annoyance; a message sent twice is a
// customer who stops trusting the gym.
//
// These run offline against a throwaway data directory, with fetch replaced, so
// running them can never send anything. `npm test` runs them, and predeploy.js
// refuses to push if any of them fail.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

// Point the store at a fresh empty directory before anything requires it, so
// the tests can never see or touch real production state.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiktak-test-"));
process.env.DATA_DIR = tmp;
delete process.env.ADMIN_PHONE; // no admin alerts out of a test run

const store = require("../src/store");
const fuse = require("../src/fuse");
const whatsapp = require("../src/whatsapp");

let sentCount = 0;
global.fetch = async () => {
  sentCount++;
  return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
};

function reset() {
  store.setArboxState({ sentTemplateLog: {}, recentSendTimes: [], fuse: {} });
  // setArboxState merges sentTemplateLog rather than replacing it (a check that
  // wrote back stale state once erased 230 people's protection), so clear it
  // through the file itself.
  fs.writeFileSync(path.join(tmp, "arbox-state.json"), JSON.stringify({}));
  sentCount = 0;
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// ---------------------------------------------------------------------------

test("the same template never reaches the same person twice", async () => {
  reset();
  await whatsapp.sendTemplate("972500000001", "welcome_new_member_v2", ["דנה"]);
  await whatsapp.sendTemplate("972500000001", "welcome_new_member_v2", ["דנה"]);
  assert.strictEqual(sentCount, 1, "second identical send must be blocked");
});

test("two different templates never reach the same person in one day", async () => {
  reset();
  // Einat got both trial reminders within the hour because they are two
  // different template names and the guard was per template.
  await whatsapp.sendTemplate("972500000002", "trial_reminder_day_before_v2", ["עינת"]);
  await whatsapp.sendTemplate("972500000002", "trial_reminder_same_day_v2", ["עינת"]);
  assert.strictEqual(sentCount, 1, "the daily limit belongs to the person, not the template");
});

test("a status Nadav moved by hand still gets through the daily limit", async () => {
  reset();
  await whatsapp.sendTemplate("972500000003", "welcome_new_member_v2", ["רון"]);
  await whatsapp.sendTemplate("972500000003", "lead_no_response_1_v2", ["רון"], { deliberate: true });
  assert.strictEqual(sentCount, 2, "a message he triggered himself is expected by him");
});

test("even a deliberate message never repeats the same words", async () => {
  reset();
  await whatsapp.sendTemplate("972500000004", "lead_no_response_1_v2", ["גל"], { deliberate: true });
  await whatsapp.sendTemplate("972500000004", "lead_no_response_1_v2", ["גל"], { deliberate: true });
  assert.strictEqual(sentCount, 1);
});

test("the fuse stops a flood at the limit, whoever asked for it", async () => {
  reset();
  // Every message here is to a different person and a different template, so
  // every per-person and per-template guard waves it through. This is the case
  // that has actually happened, twice, and the fuse is the only thing that
  // catches it.
  for (let i = 0; i < 40; i++) {
    await whatsapp.sendTemplate(`97250000${1000 + i}`, "lost_lead_goodbye_v2", ["x"]);
  }
  assert.strictEqual(
    sentCount,
    fuse.MAX_PER_HOUR,
    `at most ${fuse.MAX_PER_HOUR} may leave; ${sentCount} did`
  );
  assert.ok(fuse.isTripped(), "and the fuse must latch, not merely throttle");
});

test("once the fuse has tripped nothing more goes out at all", async () => {
  // No reset - continues from the tripped state above.
  const before = sentCount;
  await whatsapp.sendTemplate("972509999999", "birthday_1_v2", ["מישהו"]);
  await whatsapp.sendTemplate("972509999998", "welcome_new_member_v2", ["אחר"], { deliberate: true });
  assert.strictEqual(sentCount, before, "a tripped fuse ignores deliberate too");
});

test("a tripped fuse survives a restart", async () => {
  assert.ok(fuse.status().tripped, "it lives on disk, not in memory");
  assert.ok(fuse.status().reason, "and says why");
});

test("resetting the fuse by hand lets messages flow again", async () => {
  fuse.reset();
  assert.ok(!fuse.isTripped());
  const before = sentCount;
  await whatsapp.sendTemplate("972508888888", "birthday_1_v2", ["מישהי"]);
  assert.strictEqual(sentCount, before + 1);
});

test("shadow mode works everything out and sends nothing", async () => {
  reset();
  process.env.SHADOW_MODE = "true";
  await whatsapp.sendTemplate("972507777777", "welcome_new_member_v2", ["בדיקה"]);
  delete process.env.SHADOW_MODE;
  assert.strictEqual(sentCount, 0, "shadow mode must not reach the network");
});

test("the send log is never lost when other state is written", async () => {
  reset();
  await whatsapp.sendTemplate("972506666666", "welcome_new_member_v2", ["יעל"]);
  // A check writing back its own state used to replace the whole log, which is
  // how a customer who had already been messaged got messaged four more times.
  store.setArboxState({ lastDebtReportDate: "2026-08-26" });
  const log = store.getArboxState().sentTemplateLog || {};
  assert.ok(log["972506666666:welcome_new_member_v2"], "the log must only ever grow");
});

test("state is written somewhere that survives a deploy", async () => {
  // The root cause of the worst day: DATA_DIR was unset in production, so every
  // deploy wiped the record of who had been messaged, and each fix caused a
  // deploy caused a wipe caused more messages.
  const dir = store.dataDir;
  assert.ok(dir, "the store must say where it keeps things");
  assert.ok(fs.existsSync(dir), "and that place must exist");
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n      ${e.message}`);
    }
  }
  console.log("");
  if (failed) {
    console.log(`${failed} מתוך ${tests.length} בדיקות נכשלו - אסור לפרוס.`);
    process.exit(1);
  }
  console.log(`כל ${tests.length} בדיקות הבטיחות עברו.`);
})();
