// "Start from zero" - wipe everything the bot remembers about customers and
// begin again from this moment.
//
// The dangerous half is the bookkeeping. Every automation decides whether to
// message someone by checking whether it already has; clearing that memory
// without anything in its place makes every existing member and lead look brand
// new, and the next cycle messages all of them at once. So the wipe and the new
// starting line have to happen together, and the current state of the world has
// to be walked once with sending disabled so it is recorded as handled.
//
// After this runs: nobody is messaged about anything that happened before the
// button was pressed. Only genuinely new events count.
const fs = require("fs");
const path = require("path");
const store = require("./store");
const whatsapp = require("./whatsapp");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

const WIPE_FILES = [
  "conversations.json",
  "appointments.json",
  "tickets.json",
  "arbox-state.json",
];

async function factoryReset() {
  const wiped = [];
  for (const name of WIPE_FILES) {
    const file = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(file)) {
        fs.writeFileSync(file, name === "arbox-state.json" ? "{}" : name === "conversations.json" ? "{}" : "[]");
        wiped.push(name);
      }
    } catch (e) {
      console.error(`Factory reset: could not clear ${name} - ${e.message}`);
    }
  }

  // The new starting line, written before anything else runs.
  const startedAt = new Date().toISOString();
  store.setArboxState({ automationsStartFrom: startedAt });

  // Walk every check once with sending disabled, so today's members, leads and
  // absences are all recorded as already handled.
  const realText = whatsapp.sendText;
  const realTemplate = whatsapp.sendTemplate;
  let suppressed = 0;
  whatsapp.sendText = async () => { suppressed++; };
  whatsapp.sendTemplate = async () => { suppressed++; };

  const monitor = require("./arbox-monitor");
  const checks = [
    monitor.checkNewLeads, monitor.checkLeadNoResponse, monitor.checkLostLeads,
    monitor.checkNewMembers, monitor.checkNewMemberCheckins, monitor.checkBirthdays,
    monitor.checkAbsences, monitor.checkAttendanceTrends, monitor.checkStreaks,
    monitor.checkLateCancellations, monitor.checkTrialReminders, monitor.checkFailedPayments,
    monitor.checkCoachTrialNotices, monitor.checkCoachReplacements,
  ];
  for (const fn of checks) {
    if (typeof fn !== "function") continue;
    try {
      await fn();
    } catch (e) {
      console.error("Factory reset check failed:", e.message);
    }
  }

  whatsapp.sendText = realText;
  whatsapp.sendTemplate = realTemplate;

  // Re-assert the starting line: the checks above wrote their own state on top.
  const state = store.getArboxState();
  store.setArboxState({ ...state, automationsStartFrom: startedAt });

  console.log(
    `Factory reset complete. Cleared: ${wiped.join(", ")}. ` +
      `${suppressed} message(s) the existing situation would have triggered were suppressed. ` +
      `Automations now start from ${startedAt}.`
  );

  return { wiped, suppressed, startedAt };
}

module.exports = { factoryReset };
