// A full rehearsal of everything the automations would do, run before they are
// allowed to do any of it.
//
// This exists because of a specific failure. A query was widened from 50 records
// to 515, which was correct, and the change went live while the automations were
// running. Two minutes later 46 people had been written to about things that had
// happened months earlier. Nothing in the code was wrong in the ordinary sense -
// every check did exactly what it said. What changed was how much the code could
// see, and no test against invented data can catch that, because the invented
// data never widens.
//
// The only thing that would have caught it is what happens here: run the real
// checks against the real database, count what they intend to send, and look at
// the number before anybody is contacted. On the morning in question that number
// would have read 46, on a system whose normal day is two or three.
//
// So the server now rehearses on every start - which means after every deploy,
// the exact moment the risk exists - and if the count is implausible it refuses
// to arm itself and says so. It is also available as a button in the panel, so
// the question "what would happen if I switched this on" can be answered without
// switching it on.
//
// Nothing here can send. Proposals are counted in memory, and the state files
// the checks write to are restored afterwards, so a rehearsal leaves no trace.

const fs = require("fs");
const path = require("path");
const store = require("./store");
const outbox = require("./outbox");

// A day at this gym produces a handful of events: a lead or two, somebody
// crossing an absence threshold, the occasional birthday. Anything above this
// is not a busy day, it is a change in what the code can see.
const IMPLAUSIBLE = 15;

const STATE_FILES = ["arbox-state.json", "outbox.json"];

function snapshot() {
  const saved = {};
  for (const name of STATE_FILES) {
    const file = path.join(store.dataDir, name);
    saved[name] = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return saved;
}

function restore(saved) {
  for (const name of STATE_FILES) {
    const file = path.join(store.dataDir, name);
    if (saved[name] === null) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, saved[name]);
    }
  }
}

// Runs every check with proposals diverted into a list, then puts the world back
// exactly as it was. The checks themselves are untouched and unaware - which is
// the point, because a rehearsal that runs different code proves nothing about
// the code that will actually run.
async function rehearse() {
  const monitor = require("./arbox-monitor");
  const CHECKS = [
    ["ליד חדש", "checkNewLeads"],
    ["ליד שלא ענה", "checkLeadNoResponse"],
    ["מצטרף חדש", "checkNewMembers"],
    ["ליד אבוד", "checkLostLeads"],
    ["נעדר מהאימונים", "checkAbsences"],
    ["יום הולדת", "checkBirthdays"],
    ["תזכורות ניסיון", "checkTrialReminders"],
    ["ביטול בלי הרשמה מחדש", "checkLateCancellations"],
    ["רצף אימונים", "checkStreaks"],
    ["צ'ק-אין מצטרף חדש", "checkNewMemberCheckins"],
  ];

  const saved = snapshot();
  const realPropose = outbox.propose;
  const byAutomation = {};
  let current = null;

  outbox.propose = (p) => {
    const label = current || p.automation || "לא ידוע";
    (byAutomation[label] = byAutomation[label] || []).push({
      name: p.personName,
      to: p.to,
      template: p.template,
    });
    // Returning a stand-in keeps each check behaving as it would in earnest -
    // marking that person handled and moving on - so the rehearsal counts the
    // same set of people the real run would, rather than the same person twice.
    return { id: -1, rehearsal: true };
  };

  const failures = [];
  try {
    for (const [label, fn] of CHECKS) {
      current = label;
      try {
        await monitor[fn]();
      } catch (e) {
        failures.push({ automation: label, error: e.message.slice(0, 120) });
      }
    }
  } finally {
    current = null;
    outbox.propose = realPropose;
    restore(saved);
  }

  const total = Object.values(byAutomation).reduce((s, l) => s + l.length, 0);
  return { total, byAutomation, failures, implausible: total > IMPLAUSIBLE, threshold: IMPLAUSIBLE };
}

// Run at startup, before the monitor is allowed to propose anything. A verdict
// of "implausible" disarms the automations rather than merely warning, because a
// warning that arrives alongside the damage is not a safeguard.
async function rehearseAndArm() {
  let result;
  try {
    result = await rehearse();
  } catch (e) {
    // A rehearsal that cannot run is not permission to proceed.
    console.error("Canary: rehearsal failed to run -", e.message);
    store.setSetting("customerAutomationsEnabled", false);
    return { ok: false, error: e.message };
  }

  const summary = Object.entries(result.byAutomation)
    .map(([k, v]) => `${k}: ${v.length}`)
    .join(", ");
  console.log(`Canary: rehearsal intends ${result.total} messages${summary ? ` (${summary})` : ""}.`);

  store.setArboxState({
    ...store.getArboxState(),
    lastRehearsal: {
      at: new Date().toISOString(),
      total: result.total,
      byAutomation: Object.fromEntries(
        Object.entries(result.byAutomation).map(([k, v]) => [k, v.length])
      ),
      failures: result.failures,
      implausible: result.implausible,
    },
  });

  if (result.implausible) {
    // Disarm what actually arms things. The global flag is no longer the switch
    // that matters - each automation has its own, and disarming the old one
    // while leaving those on would be a safeguard that reports success and does
    // nothing. The list is kept so it can be restored in one click.
    const enabled = store.getSettings().enabledAutomations || [];
    if (enabled.length) store.setSetting("disarmedByCanary", enabled);
    store.setSetting("enabledAutomations", []);
    store.setSetting("customerAutomationsEnabled", false);
    console.error(
      `Canary: ${result.total} intended messages is above the plausible limit of ${result.threshold}. Automations disarmed.`
    );
    notify(
      `🐤 עצרתי את האוטומציות לפני שיצאה הודעה.\n\nבבדיקה שלפני ההפעלה יצא שהמערכת רוצה לשלוח ${result.total} הודעות.\nביום רגיל זה 2-4.\n\n${summary}\n\nזה כמעט תמיד אומר שמשהו השתנה בנתונים ולא שקרו באמת ${result.total} דברים.\nכלום לא נשלח. תיכנס לפאנל לראות.`
    );
  }

  return { ok: true, ...result };
}

function notify(text) {
  const admin = process.env.ADMIN_PHONE;
  if (!admin) return;
  require("./whatsapp").sendText(admin, text).catch(() => {});
}

module.exports = { rehearse, rehearseAndArm, IMPLAUSIBLE };
