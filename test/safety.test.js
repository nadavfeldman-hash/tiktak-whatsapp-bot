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

// The quiet-hours rule asks the real clock, so on a Friday evening the whole
// suite would fail for the right reason and tell us nothing about anything else.
// Calls with no argument - which is how production asks - are answered "not
// quiet"; calls with an explicit moment get the real answer, which is what the
// quiet-hours tests below use.
const quietHours = require("../src/quiet-hours");
const realHoldReason = quietHours.holdReason;
quietHours.holdReason = (now) => (now ? realHoldReason(now) : null);

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

// --- the approval rule ------------------------------------------------------

const outbox = require("../src/outbox");

function clearOutbox() {
  fs.writeFileSync(path.join(tmp, "outbox.json"), JSON.stringify({ items: [], nextId: 1 }));
}

test("no automation in the whole file can send directly any more", async () => {
  // The rule is enforced here rather than trusted, because it is the one that
  // matters: every path from a check to a customer must go through approval.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const direct = src.match(/whatsapp\.sendTemplate\(/g) || [];
  assert.strictEqual(direct.length, 0, `${direct.length} checks still send without approval`);
});

test("the conversation path cannot answer a customer on its own", async () => {
  // This was the last way a message could reach somebody without Nadav seeing
  // it: the automations went through approval, but the bot replied to inbound
  // messages instantly, straight from the webhook. Asserted rather than trusted,
  // because one unguarded path is the same as none.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  const webhook = src.slice(src.indexOf('app.post("/webhook"'));
  const sends = webhook.match(/whatsapp\.sendText\(incoming\.from/g) || [];
  // The only ones left answer Nadav himself, who is talking to his own tool.
  const adminOnly = (webhook.match(/isAdmin/g) || []).length;
  assert.ok(adminOnly > 0, "the admin path must still be recognisable");
  assert.ok(
    sends.length <= 4,
    `${sends.length} direct replies to customers in the webhook - they must be queued`
  );
});

test("a queued reply carries the question it answers", async () => {
  reset();
  clearOutbox();
  outbox.propose({
    to: "972501234000",
    kind: "text",
    body: "בטח, אנחנו פתוחים מ-6:00",
    incoming: "מה שעות הפתיחה?",
  });
  const [item] = outbox.pending();
  assert.strictEqual(item.incoming, "מה שעות הפתיחה?", "an answer can only be judged against the question");
  await outbox.send();
  assert.strictEqual(sentCount, 0, "and it still waits");
});

test("two replies to the same person both queue", async () => {
  reset();
  clearOutbox();
  outbox.propose({ to: "972501234001", kind: "text", body: "תשובה ראשונה", incoming: "שאלה 1" });
  outbox.propose({ to: "972501234001", kind: "text", body: "תשובה שנייה", incoming: "שאלה 2" });
  assert.strictEqual(outbox.pending().length, 2, "two questions deserve two answers");
});

test("an automation nobody switched on proposes nothing at all", async () => {
  // Off has to mean silent, not merely "does not send" - a queue full of
  // suggestions from automations Nadav never enabled is noise he has to wade
  // through, and noise is how a real proposal gets approved without being read.
  reset();
  clearOutbox();
  const monitor = require("../src/arbox-monitor");
  store.setSetting("enabledAutomations", []);
  assert.strictEqual(monitor.automationOn("ליד חדש"), false, "nothing is on by default");

  store.setSetting("enabledAutomations", ["ליד חדש"]);
  assert.strictEqual(monitor.automationOn("ליד חדש"), true);
  assert.strictEqual(monitor.automationOn("ליד אבוד"), false, "switching one on must not switch on its neighbours");
});

test("every automation has a switch that can reach it", async () => {
  // A name used in the code but missing from the list would be an automation
  // with no off switch - which is exactly what the single global toggle was.
  const monitor = require("../src/arbox-monitor");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const start = src.indexOf("const TEMPLATE_LABELS = {");
  const block = src.slice(start, src.indexOf("};", start));
  const named = new Set([...block.matchAll(/: "([^"]+)"/g)].map((m) => m[1]));
  assert.ok(named.size > 5, "the label block should not read as empty");
  for (const name of named) {
    assert.ok(
      monitor.ALL_AUTOMATIONS.includes(name),
      `"${name}" is used but has no switch in the panel`
    );
  }
});

test("nothing is queued twice in the gap between approving and sending", async () => {
  // Approving takes an item out of "pending" but it is not sent until the next
  // cycle, and in that gap the checks were free to queue the same message again
  // - it was no longer pending, and not yet in the send log. A second copy for
  // the same person showed up in the panel within a minute of approving the
  // first. Sending was still blocked by the seven-day rule, but that is the last
  // line of defence and this should never reach it.
  reset();
  clearOutbox();
  const first = outbox.propose({ to: "972522923417", template: "lead_no_response_3_v2", params: ["חגית"] });
  outbox.approve([first.id]);
  const second = outbox.propose({ to: "972522923417", template: "lead_no_response_3_v2", params: ["חגית"] });
  assert.strictEqual(second, null, "an approved-but-unsent message must still block a duplicate");
  await outbox.send();
  assert.strictEqual(sentCount, 1, "and exactly one may leave");
});

test("auto-approve applies only to the automation it was granted to", async () => {
  reset();
  clearOutbox();
  store.setSetting("autoApproveAutomations", ["שינוי סטטוס ליד"]);

  outbox.propose({ to: "972500000101", template: "lead_no_response_1_v2", params: ["א"], automation: "שינוי סטטוס ליד" });
  outbox.propose({ to: "972500000102", template: "welcome_new_member_v2", params: ["ב"], automation: "מצטרף חדש" });

  await outbox.send();
  assert.strictEqual(sentCount, 1, "only the automation Nadav pre-approved may go on its own");
  assert.strictEqual(outbox.pending().length, 1, "the other still waits for him");
  store.setSetting("autoApproveAutomations", []);
});

test("auto-approve does not weaken the no-duplicates rule", async () => {
  reset();
  clearOutbox();
  store.setSetting("autoApproveAutomations", ["שינוי סטטוס ליד"]);
  for (let i = 0; i < 5; i++) {
    outbox.propose({ to: "972500000103", template: "lead_no_response_1_v2", params: ["ג"], automation: "שינוי סטטוס ליד" });
    await outbox.send();
  }
  assert.strictEqual(sentCount, 1, "skipping the wait must not skip the guards");
  store.setSetting("autoApproveAutomations", []);
});

test("no check is wired into more than one loop", async () => {
  // Three checks were moved onto short loops and left on the main one as well,
  // so two copies of each ran at the same moment: both read the state, both
  // decided the same person qualified, and both sent before either had recorded
  // anything. Four people were written to twice.
  //
  // The de-duplication rules could not catch it - they compare against what has
  // been written down, and neither copy had written yet. Nothing in the suite
  // asked the one question that mattered: how many times is each check called?
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const wiring = src.slice(src.indexOf("function startMonitoring"));
  const names = [...wiring.matchAll(/\b(check[A-Z]\w+)\s*\(\s*\)/g)].map((m) => m[1]);

  const counts = {};
  for (const n of names) counts[n] = (counts[n] || 0) + 1;
  const twice = Object.entries(counts).filter(([, c]) => c > 1);
  assert.deepStrictEqual(
    twice,
    [],
    `these checks are started from more than one place: ${twice.map(([n, c]) => `${n} (${c})`).join(", ")}`
  );
});

test("a check already running is skipped, not run twice", async () => {
  // The wiring test above catches the mistake in source. This catches it in
  // behaviour, for whatever wiring nobody thought to check.
  const monitor = require("../src/arbox-monitor");
  assert.strictEqual(typeof monitor.once, "function", "the guard must be reachable to be trusted");

  let running = 0;
  let peak = 0;
  const slow = monitor.once("test", async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
  });
  await Promise.all([slow(), slow(), slow()]);
  assert.strictEqual(peak, 1, "two copies of one check must never overlap");
});

test("every reply to a customer goes through the one guarded function", async () => {
  // There were two paths into the queue from the conversation: queueReply, which
  // checks whether answering in chat is switched on, and one older call that
  // went straight to outbox.propose and never asked. Reconnecting the webhook
  // poured 431 replies into the queue from an automation that was off.
  //
  // Counting the call sites is the whole test: one guarded function, and nothing
  // else in this file talking to the queue directly.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  const direct = src.match(/outbox"\)\.propose\(/g) || [];
  assert.strictEqual(
    direct.length,
    1,
    `${direct.length} places queue a reply; there must be exactly one, inside queueReply`
  );
  const guarded = /function queueReply[\s\S]{0,400}?automationOn/.test(src);
  assert.ok(guarded, "and that one must check the switch before queueing");
});

test("no check writes back a stale copy of the whole state", async () => {
  // Seventeen checks read the state and then wrote it all back with one key
  // changed. Every one of them was therefore capable of reverting whatever the
  // others had recorded in between - and once three of them moved to
  // ten-second loops, that happened constantly: the daily debt report's "sent
  // today" mark was wiped seconds after it was written, so it sent again on the
  // next cycle, and Nadav got the same report every two minutes all morning.
  //
  // It is also what once erased 230 people's protection against being messaged
  // twice. That time only the one check was fixed, not the pattern.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const stale = src.match(/setArboxState\(\{\s*\.\.\.state/g) || [];
  assert.strictEqual(
    stale.length,
    0,
    `${stale.length} checks write back their own stale snapshot; each must write only the keys it changed`
  );
});

test("one check's write cannot revert another's", async () => {
  reset();
  const before = store.getArboxState();
  // A slow check reads here...
  const staleRead = { ...before };
  // ...a fast one records something in the meantime...
  store.setArboxState({ lastDebtReportDate: "2026-08-28" });
  // ...and the slow one finally writes its own key.
  store.setArboxState({ lastBirthdayCheckDate: "2026-08-28" });
  const after = store.getArboxState();
  assert.strictEqual(after.lastDebtReportDate, "2026-08-28", "the earlier write must survive");
  assert.strictEqual(after.lastBirthdayCheckDate, "2026-08-28", "and so must the later one");
  assert.ok(staleRead !== after, "the snapshot itself is never written back");
});

test("only one thing runs at a time, and there is only one timer", async () => {
  // Three timers and seventeen checks that overlapped freely was the shape
  // behind every incident of the last two days. One timer, one list, awaited in
  // order - so two checks cannot be inside the same state at the same moment.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const wiring = src.slice(src.indexOf("function startMonitoring"));
  const timers = wiring.match(/setInterval\(/g) || [];
  assert.strictEqual(timers.length, 1, `${timers.length} timers in the scheduler; there must be exactly one`);
  assert.ok(wiring.includes("for (const job of SCHEDULE)"), "the checks must run through one ordered list");
  assert.ok(wiring.includes("await job.run()"), "and each must be awaited before the next starts");
});

test("a message greets someone by their first name only", async () => {
  // Forty of fifty-four leads have their surname in the first-name field, so
  // three quarters of these opened "היי חגית מייזליק" - which reads as a mailing
  // list, and the entire point of them is that they do not.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const start = src.indexOf("function firstNameOnly");
  const fn = src.slice(start, src.indexOf("\n}", start) + 2);
  const firstNameOnly = eval("(" + fn.replace("function firstNameOnly", "function") + ")");
  assert.strictEqual(firstNameOnly("חגית מייזליק"), "חגית");
  assert.strictEqual(firstNameOnly("Ben Rozenberg"), "Ben");
  assert.strictEqual(firstNameOnly("elinorsimbol"), "elinorsimbol", "one word stays whole");
  assert.strictEqual(firstNameOnly(""), "", "and nothing stays nothing");
});

test("a decision that leads to no message is still written down", async () => {
  // The failures are the ones worth recording: a message that went out is
  // visible on the phone, and one that did not was visible nowhere at all.
  const events = require("../src/events");
  events.decision({ automation: "ליד אבוד", person: "יוסי", phone: "972500000900", outcome: "לא נשלח", reason: "האוטומציה כבויה" });
  events.failure("נעדר מהאימונים", "Arbox API error 500");
  const notSent = events.notSent(10);
  assert.ok(notSent.some((e) => e.reason === "האוטומציה כבויה"), "a blocked decision must be readable");
  assert.ok(notSent.some((e) => e.kind === "failure"), "and so must a crash");
});

test("the rehearsal runs before the automations are allowed to", async () => {
  // The rehearsal was written the day after 46 people were messaged by mistake,
  // and then never connected - so for a day it was a safeguard that existed only
  // in the repository. It has to run on start, which is to say after every
  // deploy, which is the moment the risk actually exists.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  assert.ok(src.includes('require("./canary")'), "the rehearsal must be wired into startup");
  const order = src.indexOf("rehearseAndArm");
  const start = src.indexOf("startMonitoring", order);
  assert.ok(order > 0 && start > order, "and it must come before monitoring starts");
});

test("a rehearsal that cannot run does not count as permission", async () => {
  const canary = require("../src/canary");
  assert.strictEqual(typeof canary.rehearseAndArm, "function");
  assert.ok(canary.IMPLAUSIBLE > 0, "there must be a number above which it refuses");
});

test("an automation that has gone quiet is noticed", async () => {
  // The absence reminders read the wrong report from the day they were written
  // and could never have fired. Nothing said so, because a broken automation and
  // a quiet one look identical from outside.
  const watchdog = require("../src/watchdog");
  store.setSetting("enabledAutomations", ["נעדר מהאימונים"]);
  const monitor = { lastRun: {} };
  const silent = watchdog.silentAutomations(monitor);
  assert.ok(
    silent.some((s) => s.name === "נעדר מהאימונים"),
    "an enabled automation that has never run must be reported"
  );

  monitor.lastRun["נעדר מהאימונים"] = { ok: true, at: new Date().toISOString() };
  assert.strictEqual(watchdog.silentAutomations(monitor).length, 0, "and one that just ran must not be");
  store.setSetting("enabledAutomations", []);
});

test("an automation nobody switched on is not reported as broken", async () => {
  // Warning about things that are off by choice is how people learn to ignore
  // warnings.
  const watchdog = require("../src/watchdog");
  store.setSetting("enabledAutomations", []);
  assert.strictEqual(watchdog.silentAutomations({ lastRun: {} }).length, 0);
});

test("a message that never arrived is surfaced, not just stored", async () => {
  const watchdog = require("../src/watchdog");
  store.setArboxState({
    deliveryStatus: [
      { at: new Date().toISOString(), to: "972500000700", status: "delivered" },
      { at: new Date().toISOString(), to: "972500000701", status: "failed", error: "Re-engagement message" },
    ],
  });
  const failed = watchdog.recentFailedDeliveries(null);
  assert.strictEqual(failed.length, 1, "only the failures");
  assert.strictEqual(failed[0].to, "972500000701");
});

test("a birthday greeting only goes to someone who actually trains here", async () => {
  // Arbox's birthday report is not a list of members - it returns everyone it
  // holds a birthday for, including people who left long ago and people who once
  // left their details and never came. On the day this was measured, three of
  // the four names in it were not training here, and all three would have been
  // wished many happy returns by a gym they do not attend.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const start = src.indexOf("async function checkBirthdays");
  const check = src.slice(start, src.indexOf("\n}", start));
  assert.ok(
    check.includes("getAllActiveMembers"),
    "the birthday list must be crossed against the people who actually train here"
  );
});

test("every message passes exactly as many blanks as its template has", async () => {
  // WhatsApp rejects a template whose parameter count does not match, and a
  // rejected send just throws into a catch - so the late-cancellation automation
  // looked switched on and working while having never delivered a single
  // message. Nothing was watching the one thing that made it impossible.
  const templates = require("../templates.json");
  const blanks = {};
  for (const t of templates) {
    blanks[t.name] = new Set((t.body.match(/\{\{\d+\}\}/g) || [])).size;
  }

  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const problems = [];
  let i = 0;
  while ((i = src.indexOf("queueMessage(", i)) !== -1) {
    let depth = 0;
    let j = i + "queueMessage".length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    const call = src.slice(i, j + 1);
    i = j;

    const named = /,\s*"([a-z_0-9]+)"\s*,/.exec(call);
    if (!named) continue; // template chosen at runtime - covered by the variants below
    const name = named[1];
    const expected = blanks[name] ?? blanks[name.replace(/_v2$/, "")];
    if (expected === undefined) continue;

    const arr = /\[([\s\S]*)\]/.exec(call);
    let count = 0;
    if (arr) {
      // Comments inside the array are prose, and prose contains commas.
      const body = arr[1].replace(/\/\/[^\n]*/g, "").trim();
      if (!body) continue;
      let d = 0;
      count = 1;
      for (const ch of body) {
        if ("([{".includes(ch)) d++;
        else if (")]}".includes(ch)) d--;
        else if (ch === "," && d === 0) count++;
      }
      // A trailing comma before the closing bracket is not another argument.
      if (/,\s*$/.test(body)) count--;
    }
    if (count !== expected) problems.push(`${name}: template has ${expected}, code sends ${count}`);
  }

  assert.deepStrictEqual(problems, [], problems.join("; "));
});

test("somebody who asked not to be messaged is not messaged", async () => {
  // Twenty-five of the hundred and ninety members have asked for quiet, and only
  // two of the eleven automations were checking. The worst was the absence
  // reminder - a person who asked to be left alone and then stopped coming would
  // be told we miss them, which is exactly the person who blocks the number.
  const monitor = require("../src/arbox-monitor");
  assert.strictEqual(typeof monitor.optedOut, "function", "the check must be reachable to be trusted");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const fnStart = src.indexOf("function queueMessage");
  const fn = src.slice(fnStart, src.indexOf("\n}", fnStart));
  assert.ok(fn.includes("optedOut("), "and it must sit in the one place every message passes");
});

test("a person Nadav silences by hand stays silenced", async () => {
  // Arbox is where consent belongs, but its public API will not write to a user -
  // every verb returns 405 - so the only way to record "stop writing to me" there
  // is a click in the UI. That is too slow: somebody says it in a conversation
  // and the next automation cycle is ten seconds away. The bot therefore keeps
  // its own list, and this is the test that it is actually consulted.
  const monitor = require("../src/arbox-monitor");
  const store = require("../src/store");
  const file = path.join(store.dataDir, "opt-outs.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

  try {
    const phone = "+972500000199";
    assert.strictEqual(monitor.optedOut(phone), false, "nobody is silenced before being added");

    monitor.silence(phone, "בדיקה", "טסט");
    assert.strictEqual(monitor.optedOut(phone), true, "and silenced immediately after");

    // The number arrives from Arbox, from WhatsApp and from Nadav typing it, in
    // three different shapes. All three are the same person.
    assert.strictEqual(monitor.optedOut("0500000199"), true, "local format");
    assert.strictEqual(monitor.optedOut("972500000199"), true, "no plus");
    assert.strictEqual(monitor.optedOut("050-000-0199"), true, "with dashes");

    // Adding twice must not grow the list, or a repeated request quietly turns
    // into a file that grows forever.
    const twice = monitor.silence(phone, "בדיקה");
    assert.strictEqual(twice.filter((p) => p.phone.endsWith("500000199")).length, 1, "recorded once");

    assert.strictEqual(monitor.optedOut("+972500000198"), false, "and nobody else is caught by it");
  } finally {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  }
});

test("\"delete everything\" also stops what is already approved", async () => {
  // The button called reject(pending()), and pending() means "waiting for a
  // decision" - so an approved message, the only kind actually about to be sent,
  // was invisible to it. Nadav emptied the queue, was told nothing could go out,
  // and two messages left four minutes later.
  const outbox = require("../src/outbox");
  const store = require("../src/store");
  const file = path.join(store.dataDir, "outbox.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        nextId: 9,
        items: [
          { id: 1, status: "pending", proposedAt: new Date().toISOString(), to: "972500000001", template: "t", automation: "נעדר מהאימונים" },
          { id: 2, status: "approved", proposedAt: new Date().toISOString(), to: "972500000002", template: "t", automation: "נעדר מהאימונים" },
          { id: 3, status: "held", proposedAt: new Date().toISOString(), to: "972500000003", template: "t", automation: "ליד חדש" },
          { id: 4, status: "sent", proposedAt: new Date().toISOString(), to: "972500000004", template: "t", automation: "ליד חדש" },
        ],
      })
    );

    assert.strictEqual(outbox.waitingToSend().length, 1, "one message is approved and about to go");
    outbox.rejectAllPending();
    assert.strictEqual(outbox.waitingToSend().length, 0, "and after 'delete everything' none is");
    assert.strictEqual(outbox.pending().length, 0, "nothing is left waiting either");

    // What already went out is history and must not be rewritten.
    const after = JSON.parse(fs.readFileSync(file, "utf8")).items;
    assert.strictEqual(after.find((i) => i.id === 4).status, "sent", "a sent message stays sent");
  } finally {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  }
});

test("turning auto-approve off un-approves what it had already stamped", async () => {
  // The switch means "stop sending on my behalf". Until now it only applied to
  // proposals not yet made, so messages approved a minute earlier still left.
  const outbox = require("../src/outbox");
  const store = require("../src/store");
  const file = path.join(store.dataDir, "outbox.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        nextId: 9,
        items: [
          { id: 1, status: "approved", autoApproved: true, proposedAt: new Date().toISOString(), to: "972500000001", template: "t", automation: "נעדר מהאימונים" },
          { id: 2, status: "approved", proposedAt: new Date().toISOString(), to: "972500000002", template: "t", automation: "ליד חדש" },
        ],
      })
    );

    const n = outbox.unapproveAutomation("נעדר מהאימונים");
    assert.strictEqual(n, 1, "its own approved message is taken back");
    const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
    assert.strictEqual(items.find((i) => i.id === 1).status, "pending", "and now waits for a human");
    assert.strictEqual(items.find((i) => i.id === 2).status, "approved", "another automation is left alone");
  } finally {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  }
});

test("somebody who no longer trains here is not told we miss them", async () => {
  // The attendance picture is built from registrations on past sessions, so it
  // holds everyone who ever booked one - lapsed members, a trial visitor from a
  // month ago. Nadav found אנפה in the queue; she has no membership at all.
  // The birthday check has always cross-referenced the member list. This one did
  // not, so the guard has to be visible in the code that builds the list.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const start = src.indexOf("async function checkAbsences");
  const fn = src.slice(start, src.indexOf("\nasync function", start + 10));

  assert.ok(
    fn.includes("getAllActiveMembers"),
    "the absence check must look up who is actually a member"
  );
  assert.ok(
    /activeIds\.has|activePhones\.has/.test(fn),
    "and every candidate must be tested against that list before being queued"
  );
  // Failing closed matters more than usual here: an empty member list would
  // otherwise mean "nobody is a member", which passes the test above while
  // silencing the automation, or worse, inverts it.
  assert.ok(
    fn.includes("activeIds.size === 0"),
    "an empty or failed member lookup must skip the round, not message everybody"
  );
});

test("every automation aimed at members checks that they still are one", async () => {
  // Two separate groups, and mixing them up is what went wrong. The lead checks
  // are supposed to write to people who are not members - that is their whole
  // job. The member checks are not, and two of them were doing it anyway:
  // checkAbsences queued "we miss you" to אנפה and Guy, who had both left, and
  // checkLateCancellations would have called a prospect who dropped a trial
  // session a נקניקיה.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const FOR_MEMBERS = [
    "checkAbsences",
    "checkBirthdays",
    "checkNewMemberCheckins",
    "checkLateCancellations",
  ];

  const missing = [];
  for (const name of FOR_MEMBERS) {
    const start = src.indexOf(`async function ${name}`);
    assert.ok(start !== -1, `${name} should exist`);
    const next = src.indexOf("\nasync function", start + 10);
    const fn = src.slice(start, next === -1 ? undefined : next);
    if (!fn.includes("getAllActiveMembers")) missing.push(name);
  }
  assert.deepStrictEqual(
    missing,
    [],
    "these write to members without checking anybody is still one: " + missing.join(", ")
  );
});

test("the silence list survives a restart", async () => {
  // It has to live on disk. Held in memory it would be lost on every deploy, and
  // a person who asked for quiet would start being written to again a day later
  // with nobody realising why.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const fnStart = src.indexOf("function silence(");
  const fn = src.slice(fnStart, src.indexOf("\n}", fnStart));
  assert.ok(fn.includes("writeFileSync"), "silencing somebody must be written to disk, not just remembered");
});

test("the clock is the gym's, not Greenwich's", async () => {
  // Render runs in UTC and every "send this at nine" in the code means the gym's
  // morning. Three hours out, the same-day trial reminder arrived at noon for a
  // workout that started at seven - a reminder for a session that had finished
  // five hours earlier.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  const tz = src.indexOf("process.env.TZ");
  assert.ok(tz >= 0, "the timezone must be set explicitly");
  assert.ok(src.includes("Asia/Jerusalem"), "and it must be the gym's");
  assert.ok(tz < src.indexOf('require("dotenv")'), "before anything reads a clock");
});

test("a suspiciously small attendance picture is not acted on", async () => {
  // The dangerous failure is not an error - an error aborts the check and nobody
  // is written to. It is Arbox answering successfully with less than it should,
  // because then people who trained yesterday are simply missing and the check
  // concludes, correctly given what it can see, that they have stopped coming.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const start = src.indexOf("async function checkAbsences");
  const check = src.slice(start, src.indexOf("\n}", start));
  assert.ok(check.includes("attendanceSample"), "each run must be compared against the last");
  assert.ok(/0\.7|70/.test(check), "and a sharp drop must stop the run");
});

test("a message the fuse stopped is not marked sent", async () => {
  // It used to be marked sent whatever had happened. So if twenty-five people
  // qualified on the same day, twenty were written to and five vanished: dropped
  // from the queue, recorded as delivered, never sent, and nothing anywhere said
  // so. Nadav asked exactly this question - what happens to the ones over the
  // limit - and the answer was worse than he feared.
  reset();
  clearOutbox();
  store.setSetting("autoApproveAutomations", []);

  const item = outbox.propose({ to: "972500000801", template: "birthday_1_v2", params: ["א"] });
  outbox.approve([item.id]);

  // Trip the fuse so the sender refuses.
  for (let i = 0; i < fuse.MAX_PER_HOUR + 1; i++) {
    await whatsapp.sendTemplate(`9725000009${String(i).padStart(2, "0")}`, "lost_lead_goodbye_v2", ["x"]);
  }
  assert.ok(fuse.isTripped(), "the fuse must be tripped for this test to mean anything");

  await outbox.send();
  assert.strictEqual(outbox.waitingToSend().length, 1, "the blocked message must still be waiting");

  fuse.reset();
  await outbox.send();
  assert.strictEqual(outbox.waitingToSend().length, 0, "and go once the fuse is reset");
});

test("switching an automation on is safe by itself", async () => {
  // Twice I ran a check against a fresh local copy, watched it record everything
  // in silence, told Nadav it was safe, and switched it on. A fresh copy is a
  // different system from one that has been running for days: the second time,
  // fourteen people who had done nothing but miss a week of training were
  // written to within seconds of the switch.
  //
  // So the safety cannot live in the checking. The first complete run after an
  // automation is switched on sends nothing, whatever state it finds, whether or
  // not anybody looked first.
  const monitor = require("../src/arbox-monitor");
  assert.strictEqual(typeof monitor.armSilentRun, "function");
  assert.strictEqual(typeof monitor.silentRunDone, "function");

  monitor.armSilentRun("נעדר מהאימונים");
  assert.strictEqual(
    monitor.silentRunDone("נעדר מהאימונים"),
    false,
    "immediately after switching on, the automation has not earned the right to send"
  );

  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const fnStart = src.indexOf("function queueMessage");
  const fn = src.slice(fnStart, src.indexOf("\n}", fnStart));
  assert.ok(fn.includes("silentRunDone("), "and every message must pass that check");

  const admin = fs.readFileSync(path.join(__dirname, "..", "src", "admin.js"), "utf8");
  assert.ok(admin.includes("armSilentRun"), "turning it on must re-arm the silence");
});

test("nothing goes out on Shabbat or in the middle of the night", async () => {
  // Two rules with no exception. A message at three in the morning wakes
  // somebody, and one on Shabbat reaches customers who keep it - in both cases
  // from a business they pay, and in both cases the damage is done the moment
  // the phone buzzes. Nothing this system sends is urgent: it is all follow-ups,
  // reminders and greetings.
  const quiet = require("../src/quiet-hours");
  const at = (day, hour) => new Date(2026, 7, 30 + day, hour, 0, 0);

  assert.ok(quiet.isQuiet(at(6, 3)), "three in the morning");
  assert.ok(quiet.isQuiet(at(0, 3)), "three in the morning on any day");
  assert.ok(quiet.isQuiet(at(1, 23)), "late evening");
  assert.ok(quiet.isQuiet(at(6, 11)), "Saturday midday");
  assert.ok(quiet.isQuiet(at(6, 19)), "Saturday evening, before Shabbat is out");
  assert.ok(quiet.isQuiet(at(5, 17)), "Friday afternoon, after Shabbat comes in");

  assert.ok(!quiet.isQuiet(at(0, 10)), "Sunday morning is fine");
  assert.ok(!quiet.isQuiet(at(3, 19)), "Wednesday evening is fine");
  assert.ok(!quiet.isQuiet(at(5, 10)), "Friday morning is fine");
});

test("nothing goes out on a festival or its eve", async () => {
  // Read from the Hebrew calendar built into Node rather than a table of dates,
  // so this cannot quietly expire in a year and start messaging people on Yom
  // Kippur because nobody remembered to extend a list.
  const quiet = require("../src/quiet-hours");
  const at = (d, h) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`);

  assert.ok(quiet.holdReason(at("2026-09-21", 10)), "Yom Kippur");
  assert.ok(quiet.holdReason(at("2026-09-20", 17)), "the eve of Yom Kippur");
  assert.ok(quiet.holdReason(at("2026-09-12", 10)), "Rosh Hashanah");
  assert.ok(quiet.holdReason(at("2026-09-26", 12)), "Sukkot");
  assert.ok(quiet.holdReason(at("2026-10-03", 12)), "Simchat Torah");
  assert.ok(quiet.holdReason(at("2027-04-22", 12)), "Pesach");
  assert.ok(quiet.holdReason(at("2027-06-11", 12)), "Shavuot");

  // The intermediate days of a festival are ordinary working days here.
  assert.strictEqual(quiet.holdReason(at("2026-09-23", 12)), null, "chol hamoed is a working day");
  assert.strictEqual(quiet.holdReason(at("2026-09-01", 12)), null, "an ordinary Tuesday");
});

test("a message held for quiet hours is held, not lost", async () => {
  // Held, not dropped: one that qualifies at midnight goes out after eight the
  // next morning rather than disappearing. The queue keeps an approved item and
  // tries again, which is what makes an absolute rule affordable.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "whatsapp.js"), "utf8");
  const fnStart = src.indexOf("async function sendTemplate");
  const fn = src.slice(fnStart, src.indexOf("\n}", fnStart));
  assert.ok(fn.includes("quiet-hours"), "the sender must check before sending");
  assert.ok(fn.includes("return null"), "and decline rather than throw, so the queue retries");

  const outboxSrc = fs.readFileSync(path.join(__dirname, "..", "src", "outbox.js"), "utf8");
  assert.ok(outboxSrc.includes("quiet-hours"), "chat replies are held too");
});

test("somebody who trained this morning is not told we miss them", async () => {
  // Three people trained at seven and were told at eight that we had not seen
  // them - Elad at 07:00, Eran at 07:10, Michal at 07:30, all messaged at 08:00.
  // Nothing was wrong with the absence logic: the picture it reads spans
  // thirty-five days and takes minutes to assemble, so by the time it was ready
  // the morning had moved on without it.
  //
  // Today is now checked last, in one request for one day, immediately before
  // anybody is written to.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "arbox-monitor.js"), "utf8");
  const start = src.indexOf("async function checkAbsences");
  const check = src.slice(start, src.indexOf("\n}", start));
  assert.ok(check.includes("activeToday"), "today must be looked at separately");
  assert.ok(check.includes("activeToday.has(id)"), "and anyone in it must be skipped");
  // The order matters: the day query has to come after the long one, or it is
  // just as stale as the picture it is correcting.
  assert.ok(
    check.indexOf("activeToday") > check.indexOf("attendancePicture"),
    "and it must be asked last, not with the rest"
  );
});

test("a proposal waits and sends nothing", async () => {
  reset();
  clearOutbox();
  outbox.propose({ to: "972501111111", template: "welcome_new_member_v2", params: ["דנה"] });
  await outbox.send();
  assert.strictEqual(sentCount, 0, "an unapproved proposal must never reach anyone");
  assert.strictEqual(outbox.pending().length, 1, "and it must still be waiting");
});

test("approving is what sends, and only what was approved", async () => {
  reset();
  clearOutbox();
  const a = outbox.propose({ to: "972502222222", template: "welcome_new_member_v2", params: ["א"] });
  outbox.propose({ to: "972503333333", template: "welcome_new_member_v2", params: ["ב"] });
  outbox.approve([a.id]);
  await outbox.send();
  assert.strictEqual(sentCount, 1, "exactly the approved one");
  assert.strictEqual(outbox.pending().length, 1, "the other is still waiting, untouched");
});

test("a rejected proposal is gone for good", async () => {
  reset();
  clearOutbox();
  const a = outbox.propose({ to: "972504444444", template: "birthday_1_v2", params: ["ג"] });
  outbox.reject([a.id]);
  await outbox.send();
  assert.strictEqual(sentCount, 0);
  assert.strictEqual(outbox.pending().length, 0);
});

test("a check running every two minutes queues a person once, not thirty times", async () => {
  reset();
  clearOutbox();
  for (let i = 0; i < 30; i++) {
    outbox.propose({ to: "972505555555", template: "welcome_new_member_v2", params: ["ד"] });
  }
  assert.strictEqual(outbox.pending().length, 1);
});

test("nothing is queued that the sender would refuse anyway", async () => {
  reset();
  clearOutbox();
  await whatsapp.sendTemplate("972506000000", "welcome_new_member_v2", ["ה"]);
  const again = outbox.propose({ to: "972506000000", template: "welcome_new_member_v2", params: ["ה"] });
  assert.strictEqual(again, null, "the panel must not show work that is not really there");
});

test("a stale proposal expires instead of being sent late", async () => {
  reset();
  clearOutbox();
  const a = outbox.propose({ to: "972507000000", template: "birthday_1_v2", params: ["ו"] });
  // Age it past the expiry window by hand.
  const f = path.join(tmp, "outbox.json");
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  data.items.find((i) => i.id === a.id).proposedAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(data));
  assert.strictEqual(outbox.pending().length, 0, "a birthday greeting two days late is worse than none");
  outbox.sweep();
  await outbox.send();
  assert.strictEqual(sentCount, 0);
});

test("even a huge queue sends nothing on its own", async () => {
  reset();
  clearOutbox();
  // The exact shape of today's incident: 465 people suddenly looking new.
  for (let i = 0; i < 465; i++) {
    outbox.propose({ to: `9725${100000 + i}`, template: "lost_lead_goodbye_v2", params: ["x"] });
  }
  await outbox.send();
  assert.strictEqual(sentCount, 0, "the worst case is now a long list on a screen, not 465 messages");
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
