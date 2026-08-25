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
  // The record of who has already been messaged is the one thing a reset must
  // NOT destroy. Wiping it alongside everything else is what made repeated
  // resets send the same people the same messages again - one customer received
  // four. "Start from zero" means forget who still needs contacting, never
  // forget who has already been contacted.
  const preservedSendLog = store.getArboxState().sentTemplateLog || {};

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

  // The new starting line, written before anything else runs - carrying the
  // send history straight back in.
  const startedAt = new Date().toISOString();
  store.setArboxState({ automationsStartFrom: startedAt, sentTemplateLog: preservedSendLog });

  // Belt and braces on top of the per-automation bookkeeping: every phone number
  // that exists in Arbox right now is stamped into the send log as though it had
  // just been messaged. The per-person cooldown then refuses to contact any of
  // them, whatever any check decides. Only people who appear after this moment
  // can receive anything - which is precisely what "start from zero" has to mean
  // after the same customers were messaged repeatedly.
  const arbox = require("./arbox");
  const stamp = new Date().toISOString();
  const seededLog = { ...preservedSendLog };
  let seededPeople = 0;
  try {
    const [leads, members] = await Promise.all([
      arbox.getLeads({ limit: 200 }).then((r) => r.data || []).catch(() => []),
      arbox.getAllActiveMembers().catch(() => []),
    ]);
    for (const person of [...leads, ...members]) {
      const phone = String(person.phone || "").replace(/\D/g, "");
      if (!phone) continue;
      seededLog[`${phone}:__existing_at_reset__`] = stamp;
      seededPeople++;
    }
  } catch (e) {
    console.error("Factory reset: could not seed the send log -", e.message);
  }
  store.setArboxState({ ...store.getArboxState(), sentTemplateLog: seededLog });

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

  // Re-assert the starting line and the send history: the checks above wrote
  // their own state on top.
  const state = store.getArboxState();
  store.setArboxState({
    ...state,
    automationsStartFrom: startedAt,
    sentTemplateLog: { ...seededLog, ...(state.sentTemplateLog || {}) },
  });

  console.log(
    `Factory reset complete. Cleared: ${wiped.join(", ")}. ` +
      `${suppressed} message(s) the existing situation would have triggered were suppressed. ` +
      `${seededPeople} existing people were stamped as already contacted. ` +
      `Automations now start from ${startedAt}.`
  );

  return { wiped, suppressed, startedAt, seededPeople };
}

module.exports = { factoryReset };
