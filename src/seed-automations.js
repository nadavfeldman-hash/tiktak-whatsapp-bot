// Run once, on the boot where automations are first switched on.
//
// Every automation remembers who it has already messaged. On a server that has
// never had them enabled, those records are empty - so the first run treats the
// entire existing backlog as brand new and messages everyone at once: leads
// whose status was set weeks ago, members absent since last month. Nadav's rule
// is that automations act on what happens from now on, never retroactively.
//
// So before anything is allowed to send, every check runs with the WhatsApp
// send functions replaced by no-ops. The checks still walk their data and still
// write their "already notified" bookkeeping, which is exactly what we want:
// the current state of the world gets marked as handled, silently. From the
// next cycle on, only genuinely new events qualify.
const whatsapp = require("./whatsapp");

async function seedAutomations() {
  const realSendText = whatsapp.sendText;
  const realSendTemplate = whatsapp.sendTemplate;
  const realMarkAsRead = whatsapp.markAsRead;

  let suppressed = 0;
  whatsapp.sendText = async () => { suppressed++; };
  whatsapp.sendTemplate = async () => { suppressed++; };
  whatsapp.markAsRead = async () => {};

  // arbox-monitor calls whatsapp.sendTemplate(...) through the module object
  // rather than a captured reference, so replacing the properties takes effect
  // even though index.js has already loaded it.
  const monitor = require("./arbox-monitor");

  const checks = [
    ["leads", monitor.checkNewLeads],
    ["lead no-response", monitor.checkLeadNoResponse],
    ["lost leads", monitor.checkLostLeads],
    ["new members", monitor.checkNewMembers],
    ["new member check-ins", monitor.checkNewMemberCheckins],
    ["birthdays", monitor.checkBirthdays],
    ["absences", monitor.checkAbsences],
    ["attendance trends", monitor.checkAttendanceTrends],
    ["streaks", monitor.checkStreaks],
    ["late cancellations", monitor.checkLateCancellations],
    ["trial reminders", monitor.checkTrialReminders],
    ["failed payments", monitor.checkFailedPayments],
    ["coach trial notices", monitor.checkCoachTrialNotices],
    ["coach replacements", monitor.checkCoachReplacements],
  ];

  for (const [label, fn] of checks) {
    if (typeof fn !== "function") continue;
    try {
      await fn();
    } catch (e) {
      console.error(`Seed: ${label} failed - ${e.message}`);
    }
  }

  whatsapp.sendText = realSendText;
  whatsapp.sendTemplate = realSendTemplate;
  whatsapp.markAsRead = realMarkAsRead;

  console.log(
    `Seed complete: ${suppressed} message(s) that the existing backlog would have ` +
      `triggered were suppressed and marked as handled. Automations now only act on new events.`
  );
}

module.exports = { seedAutomations };
