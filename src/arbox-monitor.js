const arbox = require("./arbox");
const whatsapp = require("./whatsapp");
const store = require("./store");

const ADMIN_PHONE = process.env.ADMIN_PHONE;

// Safety gate: the checks below this point message real customers directly
// (not just Nadav). They must never fire just because the server restarted -
// only when explicitly turned on in .env, after Nadav has reviewed and
// approved the templates.
const CUSTOMER_AUTOMATIONS_ENABLED = process.env.ENABLE_CUSTOMER_AUTOMATIONS === "true";

function formatLeadAlert(lead) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "(ללא שם)";
  const phone = lead.phone || "לא צוין טלפון";
  return `🔔 ליד חדש ב-ARBOX!\n${name}\nטלפון: ${phone}\nמקור: ${lead.lead_source || "לא ידוע"}\nסטטוס: ${lead.lead_status || "לא ידוע"}`;
}

async function checkNewLeads() {
  if (!ADMIN_PHONE || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const isFirstRun = !state.lastLeadCheckTime;
  const since = isFirstRun ? new Date(0) : new Date(state.lastLeadCheckTime);

  const result = await arbox.getLeads({ limit: 20, sort: "desc" });
  const leads = result.data || [];

  // Leads come back newest-first; walk oldest-to-newest so alerts arrive in order.
  const newLeads = leads
    .filter((lead) => lead.created_time && new Date(lead.created_time) > since)
    .reverse();

  for (const lead of newLeads) {
    if (isFirstRun) break; // don't spam alerts for existing history on first run ever
    await whatsapp.sendText(ADMIN_PHONE, formatLeadAlert(lead));
  }

  const latestTime = leads.reduce((max, lead) => {
    const t = lead.created_time ? new Date(lead.created_time) : null;
    return t && t > max ? t : max;
  }, since);

  store.setArboxState({ ...state, lastLeadCheckTime: latestTime.toISOString() });
}

const DEBT_REPORT_HOUR = 9; // sends once, the first time the monitor runs at/after this local hour each day

function formatDebtReport(entries) {
  const withDebt = entries.filter((e) => Number(e.debt) > 0);
  if (withDebt.length === 0) return "💰 דוח חובות יומי: אין כרגע אף אחד עם חוב פתוח 🙌";

  const lines = withDebt.map((e) => `- ${e.full_name}: ${e.debt}₪ (${e.item_name || "לא ידוע"}) | ${e.phone || "אין טלפון"}`);
  const total = withDebt.reduce((sum, e) => sum + Number(e.debt), 0);
  return `💰 דוח חובות יומי (${withDebt.length} לקוחות, סה"כ ${total}₪):\n${lines.join("\n")}`;
}

async function checkDebtReport() {
  if (!ADMIN_PHONE || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getHours();

  if (state.lastDebtReportDate === today || currentHour < DEBT_REPORT_HOUR) return;

  const result = await arbox.getReport("debtReport", { limit: 200 });
  const message = formatDebtReport(result.data || []);
  await whatsapp.sendText(ADMIN_PHONE, message);

  store.setArboxState({ ...state, lastDebtReportDate: today });
}

const ATTENDANCE_REPORT_HOUR = 21; // sent once, the first time the monitor runs at/after this local hour each day

async function checkAttendanceReport() {
  if (!ADMIN_PHONE || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getHours();

  if (state.lastAttendanceReportDate === today || currentHour < ATTENDANCE_REPORT_HOUR) return;

  const result = await arbox.getSchedule({
    from_date: today,
    to_date: today,
    limit: 200,
    registration_details: "1",
    registration_count: "1",
  });
  const sessions = result.data || [];

  // Registration counts as attendance here, regardless of the physical check-in
  // flag - people who booked but forgot to scan in still counted (per Nadav).
  const totalRegistrations = sessions.reduce((sum, s) => sum + Number(s.registration_count || 0), 0);
  const sessionsWithPeople = sessions.filter((s) => Number(s.registration_count) > 0).length;

  const message = `📋 דוח נוכחות יומי (${today}):\n${totalRegistrations} הרשמות לאימונים, פרוסות על ${sessionsWithPeople} שיעורים.`;
  await whatsapp.sendText(ADMIN_PHONE, message);

  store.setArboxState({ ...state, lastAttendanceReportDate: today });
}

function formatTaskAlert(task) {
  return `✅ תזכורת למשימה:\nלקוח: ${task.full_name || "לא ידוע"} | ${task.phone || "אין טלפון"}\nסוג: ${task.task_type || "כללי"}\n${task.description || ""}`;
}

async function checkDueTasks() {
  if (!ADMIN_PHONE || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const sentIds = new Set(state.sentTaskReminderIds || []);

  const from = new Date();
  from.setDate(from.getDate() - 1);
  const to = new Date();
  to.setDate(to.getDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const result = await arbox.getTasks({
    from_date: fmt(from),
    to_date: fmt(to),
    include_completed: "0",
    limit: 200,
  });
  const tasks = result.data || [];
  const now = new Date();

  const dueTasks = tasks.filter(
    (t) =>
      !t.done &&
      t.reminder_time &&
      new Date(t.reminder_time.replace(" ", "T")) <= now &&
      !sentIds.has(String(t.task_id))
  );

  for (const task of dueTasks) {
    await whatsapp.sendText(ADMIN_PHONE, formatTaskAlert(task));
    sentIds.add(String(task.task_id));
  }

  if (dueTasks.length > 0) {
    store.setArboxState({ ...state, sentTaskReminderIds: Array.from(sentIds) });
  }
}

const BIRTHDAY_HOUR = 10; // sends once, the first time the monitor runs at/after this local hour each day
const BIRTHDAY_TEMPLATES = ["birthday_greeting_1", "birthday_greeting_2", "birthday_greeting_3"];

async function checkBirthdays() {
  if (!CUSTOMER_AUTOMATIONS_ENABLED || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getHours();

  if (state.lastBirthdayCheckDate === today || currentHour < BIRTHDAY_HOUR) return;

  const result = await arbox.getReport("birthdayReport", { fromDate: today, toDate: today, limit: 200 });
  const people = (result.data || []).filter((p) => p.phone && p.allow_sms !== "no");

  for (const person of people) {
    const template = BIRTHDAY_TEMPLATES[Math.floor(Math.random() * BIRTHDAY_TEMPLATES.length)];
    await whatsapp.sendTemplate(person.phone.replace("+", ""), template, [person.first_name]);
  }

  store.setArboxState({ ...state, lastBirthdayCheckDate: today });
}

async function checkFailedPayments() {
  if (!CUSTOMER_AUTOMATIONS_ENABLED || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const notifiedKeys = new Set(state.notifiedFailedPaymentKeys || []);
  const today = new Date().toISOString().slice(0, 10);

  const from = new Date();
  from.setDate(from.getDate() - 2);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const result = await arbox.getReport("transactionsReport", { fromDate: fmt(from), toDate: today, limit: 200 });
  const failed = result.data || [];

  // One reminder per customer per day, even if their payment retried and failed
  // several times - not one message per failed attempt.
  const seenThisRun = new Set();
  for (const t of failed) {
    if (t.status !== "FAIL") continue;
    const key = `${t.user_id}:${today}`;
    if (notifiedKeys.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);

    try {
      const user = await arbox.getUser(t.user_id);
      const phone = user.data?.phone;
      if (phone) {
        await whatsapp.sendTemplate(phone.replace("+", ""), "failed_payment_reminder", [t.first_name]);
      }
    } catch (e) {
      console.error("Failed to notify about failed payment", t.transaction_id, e.message);
    }
    notifiedKeys.add(key);
  }

  if (seenThisRun.size > 0) {
    store.setArboxState({ ...state, notifiedFailedPaymentKeys: Array.from(notifiedKeys) });
  }
}

async function checkNewMembers() {
  if (!CUSTOMER_AUTOMATIONS_ENABLED || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const isFirstRun = state.lastConvertedUserId === undefined;
  const lastSeenId = state.lastConvertedUserId || 0;

  const result = await arbox.getConvertedLeads({ limit: 50 });
  const converted = result.data || [];

  const newOnes = converted.filter((c) => c.user_id > lastSeenId);
  const maxId = converted.reduce((max, c) => Math.max(max, c.user_id), lastSeenId);

  if (!isFirstRun) {
    for (const c of newOnes) {
      if (c.phone) {
        await whatsapp.sendTemplate(c.phone.replace("+", ""), "welcome_new_member", [c.first_name]);
      }
    }
  }

  store.setArboxState({ ...state, lastConvertedUserId: maxId });
}

async function checkLostLeads() {
  if (!CUSTOMER_AUTOMATIONS_ENABLED || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const isFirstRun = state.lastLostUserId === undefined;
  const lastSeenId = state.lastLostUserId || 0;

  const result = await arbox.getLostLeads({ limit: 50 });
  const lost = result.data || [];

  const newOnes = lost.filter((c) => c.user_id > lastSeenId);
  const maxId = lost.reduce((max, c) => Math.max(max, c.user_id), lastSeenId);

  if (!isFirstRun) {
    for (const c of newOnes) {
      if (c.phone) {
        await whatsapp.sendTemplate(c.phone.replace("+", ""), "lost_lead_goodbye", [c.first_name]);
      }
    }
  }

  store.setArboxState({ ...state, lastLostUserId: maxId });
}

function startMonitoring(intervalMs = 2 * 60 * 1000) {
  const runAll = () => {
    checkNewLeads().catch((e) => console.error("Arbox monitor (leads) error:", e.message));
    checkDebtReport().catch((e) => console.error("Arbox monitor (debt) error:", e.message));
    checkAttendanceReport().catch((e) => console.error("Arbox monitor (attendance) error:", e.message));
    checkDueTasks().catch((e) => console.error("Arbox monitor (tasks) error:", e.message));
    checkBirthdays().catch((e) => console.error("Arbox monitor (birthdays) error:", e.message));
    checkFailedPayments().catch((e) => console.error("Arbox monitor (failed payments) error:", e.message));
    checkNewMembers().catch((e) => console.error("Arbox monitor (new members) error:", e.message));
    checkLostLeads().catch((e) => console.error("Arbox monitor (lost leads) error:", e.message));
  };
  runAll();
  setInterval(runAll, intervalMs);
}

module.exports = {
  startMonitoring,
  checkNewLeads,
  checkDebtReport,
  checkAttendanceReport,
  checkDueTasks,
  checkBirthdays,
  checkFailedPayments,
  checkNewMembers,
  checkLostLeads,
};
