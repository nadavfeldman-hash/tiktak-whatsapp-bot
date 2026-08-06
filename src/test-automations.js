// Regression test for the Arbox automation checks in arbox-monitor.js.
//
// This does NOT send real WhatsApp messages - it replaces whatsapp.sendText /
// whatsapp.sendTemplate with recorders before requiring arbox-monitor, so we
// can assert on what *would* have been sent. It does make real (read-only)
// calls to the Arbox API.
//
// The single most important property this guards: customer-facing checks
// must never message a real customer while the automations toggle is off -
// that's the exact safety gate that almost failed silently earlier in this
// project. Run after any change to arbox-monitor.js: node src/test-automations.js

require("dotenv").config();

const whatsapp = require("./whatsapp");
const store = require("./store");

const sentTexts = [];
const sentTemplates = [];
whatsapp.sendText = async (to, body) => {
  sentTexts.push({ to, body });
};
whatsapp.sendTemplate = async (to, name, params) => {
  sentTemplates.push({ to, name, params });
};

const monitor = require("./arbox-monitor");

if (!process.env.ARBOX_API_KEY) {
  console.error("ARBOX_API_KEY חסר ב-.env - הבדיקה צריכה גישה אמיתית (לקריאה בלבד) ל-Arbox");
  process.exit(1);
}

const CUSTOMER_FACING_CHECKS = [
  ["checkBirthdays", monitor.checkBirthdays],
  ["checkFailedPayments", monitor.checkFailedPayments],
  ["checkNewMembers", monitor.checkNewMembers],
  ["checkLostLeads", monitor.checkLostLeads],
  ["checkTrialReminders", monitor.checkTrialReminders],
  ["checkAbsences", monitor.checkAbsences],
  ["checkLeadNoResponse", monitor.checkLeadNoResponse],
  ["checkCoachTrialNotices", monitor.checkCoachTrialNotices],
  ["checkCoachReplacements", monitor.checkCoachReplacements],
  ["checkAttendanceTrends", monitor.checkAttendanceTrends],
  ["checkLateCancellations", monitor.checkLateCancellations],
  ["checkStreaks", monitor.checkStreaks],
  ["checkNewMemberCheckins", monitor.checkNewMemberCheckins],
];

const ADMIN_FACING_CHECKS = [
  ["checkNewLeads", monitor.checkNewLeads],
  ["checkDebtReport", monitor.checkDebtReport],
  ["checkAttendanceReport", monitor.checkAttendanceReport],
  ["checkDueTasks", monitor.checkDueTasks],
];

async function main() {
  let failed = false;
  const originalSettings = store.getSettings();

  console.log("=== שלב 1: אוטומציות ללקוחות, המתג כבוי (המצב הרגיל) ===");
  store.setSetting("customerAutomationsEnabled", false);
  for (const [name, fn] of CUSTOMER_FACING_CHECKS) {
    sentTemplates.length = 0;
    try {
      await fn();
    } catch (e) {
      failed = true;
      console.log(`  ❌ ${name} זרק שגיאה: ${e.message}`);
      continue;
    }
    if (sentTemplates.length > 0) {
      failed = true;
      console.log(`  ❌ ${name} שלח ${sentTemplates.length} הודעות למרות שהמתג כבוי! זו בעיית בטיחות קריטית.`);
    } else {
      console.log(`  ✅ ${name} - לא שלח כלום, כמו שצריך`);
    }
  }

  console.log("\n=== שלב 2: אוטומציות ללקוחות, המתג פעיל (בודקים שהלוגיקה לא קורסת) ===");
  store.setSetting("customerAutomationsEnabled", true);
  for (const [name, fn] of CUSTOMER_FACING_CHECKS) {
    sentTemplates.length = 0;
    try {
      await fn();
      console.log(`  ✅ ${name} - רץ בלי שגיאה (${sentTemplates.length} הודעות היו נשלחות בפועל)`);
    } catch (e) {
      failed = true;
      console.log(`  ❌ ${name} זרק שגיאה: ${e.message}`);
    }
  }
  store.setSetting("customerAutomationsEnabled", originalSettings.customerAutomationsEnabled || false);

  console.log("\n=== שלב 3: הדוחות אליך (תמיד פעילים) - בודקים שהלוגיקה לא קורסת ===");
  for (const [name, fn] of ADMIN_FACING_CHECKS) {
    sentTexts.length = 0;
    try {
      await fn();
      console.log(`  ✅ ${name} - רץ בלי שגיאה`);
    } catch (e) {
      failed = true;
      console.log(`  ❌ ${name} זרק שגיאה: ${e.message}`);
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(failed ? "יש כשלים ❌" : "כל הבדיקות עברו ✅");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
