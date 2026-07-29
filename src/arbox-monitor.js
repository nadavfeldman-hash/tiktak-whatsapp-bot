const arbox = require("./arbox");
const whatsapp = require("./whatsapp");
const store = require("./store");

const ADMIN_PHONE = process.env.ADMIN_PHONE;

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

function startMonitoring(intervalMs = 2 * 60 * 1000) {
  const runAll = () => {
    checkNewLeads().catch((e) => console.error("Arbox monitor (leads) error:", e.message));
    checkDebtReport().catch((e) => console.error("Arbox monitor (debt) error:", e.message));
    checkAttendanceReport().catch((e) => console.error("Arbox monitor (attendance) error:", e.message));
    checkDueTasks().catch((e) => console.error("Arbox monitor (tasks) error:", e.message));
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
};
