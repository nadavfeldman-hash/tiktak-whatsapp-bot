const arbox = require("./arbox");
const whatsapp = require("./whatsapp");
const store = require("./store");

const ADMIN_PHONE = process.env.ADMIN_PHONE;

// Small pause between messages in any loop that could message many different
// recipients in one run (e.g. the first-ever attendance-trend sweep can hit
// 100+ people) - keeps us well under WhatsApp's send-rate limits.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PACE_MS = 1200;

// Safety gate: the checks below this point message real customers directly
// (not just Nadav). They must never fire just because the server restarted -
// only when explicitly turned on (via the admin panel, or ENABLE_CUSTOMER_AUTOMATIONS
// in .env as a fallback), after Nadav has reviewed and approved the templates.
// Read fresh each time (not cached at module load) so the admin panel toggle
// takes effect immediately, without restarting the server.
// Automations act on what happens from the day they went live, never on the
// backlog that was already sitting in Arbox. Without this, switching them on
// would message every lead whose status was set weeks ago and everyone who
// stopped coming last month - 47 messages in one burst, when measured.
//
// A fixed date rather than "first boot" on purpose: a redeploy or a wiped disk
// must not make the whole history look new again.
// Read fresh each time rather than captured at load, so the reset button in the
// admin panel can move it without a redeploy. Stored value wins, then the
// environment, then the date this was first set.
function automationsStart() {
  const stored = store.getArboxState().automationsStartFrom;
  return new Date(stored || process.env.AUTOMATIONS_START_DATE || "2026-08-25T11:32:38");
}

// Did this happen after we went live? Anything unparseable counts as old, so
// missing timestamps stay silent rather than triggering a message.
function isAfterGoLive(timestamp) {
  if (!timestamp) return false;
  const t = new Date(String(timestamp).replace(" ", "T"));
  return !isNaN(t) && t >= automationsStart();
}

// EMERGENCY STOP, 25 Aug 2026. Automations went live and immediately messaged a
// batch of real customers before Nadav had signed off on it. Nothing customer-
// facing may fire while this is true, whatever any environment variable or
// stored setting says. Flip to false only when Nadav explicitly asks.
const HARD_STOP = false;

function customerAutomationsEnabled() {
  if (HARD_STOP) return false;
  // ENABLE_CUSTOMER_AUTOMATIONS is a hard override in BOTH directions. It used
  // to be able only to turn things on, falling through to the stored setting
  // otherwise - which meant a stale "true" on the server's own disk could send
  // real customers messages even though every other switch said off. That
  // happened once, to a live lead. "false" now wins over everything.
  const override = process.env.ENABLE_CUSTOMER_AUTOMATIONS;
  if (override === "false") return false;
  if (override === "true") return true;
  return !!store.getSettings().customerAutomationsEnabled;
}

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

    // Same go-live rule as every other automation: only leads created after we
    // switched on get an automatic welcome. Without this, turning automations on
    // re-messages everyone already in the list - including three leads that had
    // just been written to by hand.
    if (customerAutomationsEnabled() && lead.phone && isAfterGoLive(lead.created_time)) {
      try {
        await whatsapp.sendTemplate(lead.phone.replace("+", ""), "new_lead_details_request_v2", [
          lead.first_name || "",
        ]);
        await sleep(PACE_MS);
      } catch (e) {
        console.error("Failed to message new lead", lead.phone, e.message);
      }
    }
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
// Four variants, picked at random, so people who train here for years don't get
// the same birthday message twice: two jokey ones, one warm, and one short and
// personally signed by Nadav.
const BIRTHDAY_TEMPLATES = [
  "birthday_greeting_1_v2",
  "birthday_greeting_2_v2",
  "birthday_greeting_3_v2",
  "birthday_greeting_4",
];

async function checkBirthdays() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getHours();

  if (state.lastBirthdayCheckDate === today || currentHour < BIRTHDAY_HOUR) return;

  const result = await arbox.getReport("birthdayReport", { fromDate: today, toDate: today, limit: 200 });
  const people = (result.data || []).filter((p) => p.phone && p.allow_sms !== "no");

  for (const person of people) {
    const template = BIRTHDAY_TEMPLATES[Math.floor(Math.random() * BIRTHDAY_TEMPLATES.length)];
    await whatsapp.sendTemplate(person.phone.replace("+", ""), template, [person.first_name]);
    await sleep(PACE_MS);
  }

  store.setArboxState({ ...state, lastBirthdayCheckDate: today });
}

async function checkFailedPayments() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

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
        await sleep(PACE_MS);
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
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

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
        await whatsapp.sendTemplate(c.phone.replace("+", ""), "welcome_new_member_v2", [c.first_name]);
        await sleep(PACE_MS);
      }
    }
  }

  store.setArboxState({ ...state, lastConvertedUserId: maxId });
}

async function checkLostLeads() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

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
        await whatsapp.sendTemplate(c.phone.replace("+", ""), "lost_lead_goodbye_v2", [c.first_name]);
        await sleep(PACE_MS);
      }
    }
  }

  store.setArboxState({ ...state, lastLostUserId: maxId });
}

function isTrialRegistration(reg) {
  return (reg.membership_type || "").includes("ניסיון");
}

async function findTrialRegistrations(dateStr) {
  const result = await arbox.getSchedule({
    from_date: dateStr,
    to_date: dateStr,
    limit: 200,
    registration_details: "1",
    registration_count: "1",
  });
  const sessions = result.data || [];
  const registrations = [];
  for (const session of sessions) {
    for (const reg of session.registration_Details || []) {
      if (isTrialRegistration(reg)) {
        registrations.push({ session, reg });
      }
    }
  }
  return registrations;
}

const TRIAL_REMINDER_DAY_BEFORE_HOUR = 19; // evening before
const TRIAL_REMINDER_SAME_DAY_HOUR = 9; // morning of

async function checkTrialReminders() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const sentKeys = new Set(state.sentTrialReminderKeys || []);
  const currentHour = new Date().getHours();
  let changed = false;

  const sendFor = async (dateStr, tag, hourGate) => {
    if (currentHour < hourGate) return;
    const registrations = await findTrialRegistrations(dateStr);
    for (const { session, reg } of registrations) {
      const key = `${session.schedule_id}:${reg.user_id}:${tag}`;
      if (sentKeys.has(key)) continue;
      if (!reg.phone) continue;
      // The evening-before message carries the full briefing (what to bring,
      // the Waze address); on the day itself it's just a short nudge.
      const template =
        tag === "day_before" ? "trial_reminder_day_before_v2" : "trial_reminder_same_day_v2";
      await whatsapp.sendTemplate(reg.phone.replace("+", ""), template, [
        reg.full_name || "",
        session.session_name || "אימון",
        session.start_time || "",
      ]);
      await sleep(PACE_MS);
      sentKeys.add(key);
      changed = true;
    }
  };

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fmt = (d) => d.toISOString().slice(0, 10);

  await sendFor(fmt(tomorrow), "day_before", TRIAL_REMINDER_DAY_BEFORE_HOUR);
  await sendFor(fmt(today), "same_day", TRIAL_REMINDER_SAME_DAY_HOUR);

  if (changed) {
    store.setArboxState({ ...state, sentTrialReminderKeys: Array.from(sentKeys) });
  }
}

// Absence nudges escalate with time away, and each stage has several variants
// picked at random so nobody gets the same wording twice. Someone who stays
// away passes through all three stages, one message each - the stage they are
// in is decided by how long it has been, never at random.
const ABSENCE_STAGES = [
  { minDays: 4, templates: ["absence_reminder_1a", "absence_reminder_1b", "absence_reminder_1c"] },
  { minDays: 8, templates: ["absence_reminder_2a", "absence_reminder_2b"] },
  { minDays: 14, templates: ["absence_reminder_3"] },
];

// Past this, someone has not drifted - they have left. Chasing them with "we're
// not giving up on you" reads as a mistake, and winning them back is a different
// conversation entirely.
const ABSENCE_MAX_DAYS = 30;

// Highest stage whose threshold the absence has passed, or null if it is too
// soon to say anything - or too late to be saying this particular thing.
function absenceStage(daysAgo) {
  if (daysAgo > ABSENCE_MAX_DAYS) return null;
  let stage = null;
  ABSENCE_STAGES.forEach((s, i) => {
    if (daysAgo >= s.minDays) stage = i;
  });
  return stage;
}

async function checkAbsences() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  // Keyed by user+stage, so someone who keeps staying away hears from us once
  // per stage rather than once ever.
  const notifiedKeys = new Set(state.notifiedAbsenceKeys || []);

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date();
  from.setDate(from.getDate() - 30); // Arbox reports cap the range at 31 days
  const fromStr = from.toISOString().slice(0, 10);

  const result = await arbox.getReport("absenceReport", {
    fromDate: fromStr,
    toDate: to,
    limit: 200,
    group_by: "user",
  });
  const people = result.data || [];
  const now = new Date();
  let changed = false;

  for (const person of people) {
    if (person.future_registration !== "no" || person.allow_sms === "no" || !person.phone) continue;

    if (!isAfterGoLive(person.last_seen)) continue; // stopped coming before we went live
    const lastSeen = new Date(person.last_seen);
    const daysAgo = Math.floor((now - lastSeen) / (1000 * 60 * 60 * 24));
    const stage = absenceStage(daysAgo);
    if (stage === null) continue; // hasn't been away long enough yet

    const key = `${person.id}:${stage}`;
    if (notifiedKeys.has(key)) continue;

    const variants = ABSENCE_STAGES[stage].templates;
    const template = variants[Math.floor(Math.random() * variants.length)];
    // Only the last stage names how many days it has been.
    const params =
      template === "absence_reminder_3" ? [person.first_name, String(daysAgo)] : [person.first_name];
    await whatsapp.sendTemplate(person.phone.replace("+", ""), template, params);
    await sleep(PACE_MS);
    notifiedKeys.add(key);
    changed = true;
  }

  if (changed) {
    store.setArboxState({ ...state, notifiedAbsenceKeys: Array.from(notifiedKeys) });
  }
}

const LEAD_NO_RESPONSE_TEMPLATES = ["lead_no_response_1_v2", "lead_no_response_2", "lead_no_response_3_v2"];

// Arbox tracks follow-up attempts as sequential statuses: "ללא מענה 1", "ללא
// מענה 2", "ללא מענה 3" - each stage should get its matching, progressively
// more direct message (soft nudge -> personal appeal), not a random one, and
// each stage a lead passes through should get notified once as they reach it.
function leadNoResponseStage(status) {
  const match = /ללא מענה\s*(\d+)/.exec(status || "");
  if (!match) return null;
  const stage = Number(match[1]);
  return stage >= 1 && stage <= LEAD_NO_RESPONSE_TEMPLATES.length ? stage : null;
}

async function checkLeadNoResponse() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const notifiedKeys = new Set(state.notifiedLeadNoResponseKeys || []);

  const previousStatuses = state.leadStatusSnapshot || {};
  const result = await arbox.getReport("leadsInProcessReport", { limit: 200, group_by: "user" });
  const leads = result.data || [];
  const currentStatuses = {};
  leads.forEach((l) => {
    currentStatuses[l.user_id] = l.lead_status;
  });
  let changed = false;

  for (const lead of leads) {
    const stage = leadNoResponseStage(lead.lead_status);
    if (!stage) continue;
    if (!lead.phone) continue;
    const key = `${lead.user_id}:${stage}`;
    if (notifiedKeys.has(key)) continue;

    // Arbox reports updated_at as a bare date with no time, so it cannot tell us
    // whether a status changed before or after we went live. Instead we keep a
    // snapshot of what each lead's status was last cycle and react only to an
    // actual change we witnessed: the first cycle records the current picture
    // silently, and from then on a status Nadav sets is what triggers the
    // message.
    if (previousStatuses[lead.user_id] === undefined) continue; // first sighting
    if (previousStatuses[lead.user_id] === lead.lead_status) continue; // unchanged

    // Nadav moves a lead to "ללא מענה N" the moment a call goes unanswered, so
    // that status change IS the trigger - the message goes out immediately
    // rather than waiting for a cooling-off period.
    const template = LEAD_NO_RESPONSE_TEMPLATES[stage - 1];
    await whatsapp.sendTemplate(lead.phone.replace("+", ""), template, [lead.first_name || ""]);
    await sleep(PACE_MS);
    notifiedKeys.add(key);
    changed = true;
  }

  // The snapshot is saved every cycle, whether or not anything was sent, so the
  // next cycle has something to compare against.
  store.setArboxState({
    ...state,
    notifiedLeadNoResponseKeys: changed ? Array.from(notifiedKeys) : state.notifiedLeadNoResponseKeys,
    leadStatusSnapshot: currentStatuses,
  });
}

// Runs once a week: counts each active (non-trial) member's registrations in
// the last 7 days vs the 7 days before that, and nudges them if the trend is
// clearly up, down, or flatly steady.
async function fetchScheduleRange(fromStr, toStr) {
  let sessions = [];
  let page = 1;
  while (true) {
    const result = await arbox.getSchedule({
      from_date: fromStr,
      to_date: toStr,
      limit: 200,
      page,
      registration_details: "1",
    });
    sessions = sessions.concat(result.data || []);
    if (!result.extra?.pagination?.next_page_url) break;
    page++;
  }
  return sessions;
}

function countRegistrationsByUser(sessions) {
  const counts = new Map();
  for (const session of sessions) {
    for (const reg of session.registration_Details || []) {
      if ((reg.membership_type || "").includes("ניסיון")) continue; // trial users have no "trend" yet
      if (!reg.phone) continue;
      const key = reg.user_id;
      const entry = counts.get(key) || { count: 0, name: reg.first_name || reg.full_name, phone: reg.phone };
      entry.count++;
      counts.set(key, entry);
    }
  }
  return counts;
}

async function checkAttendanceTrends() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const lastRun = state.lastAttendanceTrendCheckDate ? new Date(state.lastAttendanceTrendCheckDate) : null;
  const now = new Date();
  if (lastRun && now - lastRun < 7 * 24 * 60 * 60 * 1000) return;

  // The weekly summary goes to every active member at once, so on the very
  // first run after automations are switched on it is a mass send to people who
  // were never told to expect it. That happened. It now stays silent on its
  // first pass and only records the date, so the first real summary goes out a
  // week later, as a weekly summary should.
  if (!lastRun) {
    console.log("Attendance trends: first run - recording the date and staying silent this week.");
    store.setArboxState({ ...state, lastAttendanceTrendCheckDate: now.toISOString() });
    return;
  }

  const fmt = (d) => d.toISOString().slice(0, 10);
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const twoWeeksAgo = new Date(now);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const dayBeforeWeekAgo = new Date(weekAgo);
  dayBeforeWeekAgo.setDate(dayBeforeWeekAgo.getDate() - 1);

  const thisWeekSessions = await fetchScheduleRange(fmt(weekAgo), fmt(now));
  const lastWeekSessions = await fetchScheduleRange(fmt(twoWeeksAgo), fmt(dayBeforeWeekAgo));

  const thisWeekCounts = countRegistrationsByUser(thisWeekSessions);
  const lastWeekCounts = countRegistrationsByUser(lastWeekSessions);

  const allUserIds = new Set([...thisWeekCounts.keys(), ...lastWeekCounts.keys()]);
  for (const userId of allUserIds) {
    const current = thisWeekCounts.get(userId);
    const previous = lastWeekCounts.get(userId);
    const currentCount = current?.count || 0;
    const previousCount = previous?.count || 0;
    if (currentCount === 0 && previousCount === 0) continue;

    // Nobody who did not train at all this week gets a weekly summary. Someone
    // who trained a fortnight ago and stopped would otherwise be sent a report
    // telling them they did nothing - a former member being handed a scorecard
    // of their own absence. That happened, and it reads badly. People who have
    // drifted are the absence reminders' job, not this one's.
    if (currentCount === 0) continue;

    const info = current || previous;
    if (!info?.phone) continue;

    let template;
    if (currentCount > previousCount) template = "attendance_trend_up";
    else if (currentCount < previousCount) template = "attendance_trend_down";
    // Only congratulate a steady week from 2 sessions up - holding at a single
    // workout a week isn't a rhythm worth celebrating.
    else if (currentCount >= 2) template = "attendance_trend_steady";
    else continue;

    const params =
      template === "attendance_trend_steady"
        ? [info.name || "", String(currentCount)]
        : [info.name || "", String(previousCount), String(currentCount)];
    await whatsapp.sendTemplate(info.phone.replace("+", ""), template, params);
    await sleep(PACE_MS);
  }

  store.setArboxState({ ...state, lastAttendanceTrendCheckDate: now.toISOString() });
}

const COACH_TRIAL_NOTICE_HOUR = 19; // evening before, once per day

async function checkCoachTrialNotices() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getHours();
  if (state.lastCoachTrialNoticeDate === today || currentHour < COACH_TRIAL_NOTICE_HOUR) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const registrations = await findTrialRegistrations(tomorrowStr);
  for (const { session, reg } of registrations) {
    const coachPhone = session.staff_member?.phone;
    if (!coachPhone) continue;
    await whatsapp.sendTemplate(coachPhone.replace("+", ""), "coach_trial_notice_morning", [
      session.staff_member.name || "",
      session.session_name || "אימון",
      session.start_time || "",
      reg.full_name || "",
    ]);
    await sleep(PACE_MS);
  }

  store.setArboxState({ ...state, lastCoachTrialNoticeDate: today });
}

// Detects when a session's assigned coach changes from what we last saw, by
// snapshotting today's + tomorrow's schedule each run and diffing against the
// previous snapshot - Arbox has no "replacement" event/webhook of its own.
async function checkCoachReplacements() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const previousSnapshot = state.coachScheduleSnapshot || {};
  const newSnapshot = {};

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fmt = (d) => d.toISOString().slice(0, 10);

  let sessions = [];
  for (const dateStr of [fmt(today), fmt(tomorrow)]) {
    let page = 1;
    while (true) {
      const result = await arbox.getSchedule({ from_date: dateStr, to_date: dateStr, limit: 200, page });
      sessions = sessions.concat(result.data || []);
      if (!result.extra?.pagination?.next_page_url) break;
      page++;
    }
  }

  for (const session of sessions) {
    const staffId = session.staff_member?.user_id;
    if (!staffId) continue;
    newSnapshot[session.schedule_id] = staffId;

    const previousStaffId = previousSnapshot[session.schedule_id];
    if (previousStaffId && previousStaffId !== staffId) {
      const newCoachPhone = session.staff_member.phone;
      if (newCoachPhone) {
        let previousCoachName = "המאמן/ת הקודם/ת";
        try {
          const previousUser = await arbox.getUser(previousStaffId);
          if (previousUser.data?.first_name) previousCoachName = previousUser.data.first_name;
        } catch {
          // fall back to the generic label above if the lookup fails
        }
        await whatsapp.sendTemplate(newCoachPhone.replace("+", ""), "coach_replacement_notice", [
          session.staff_member.name || "",
          session.date || "",
          session.session_name || "",
          session.start_time || "",
          previousCoachName,
        ]);
        await sleep(PACE_MS);
      }
    }
  }

  store.setArboxState({ ...state, coachScheduleSnapshot: newSnapshot });
}

// There is no waiting list here - a new workout starts every 10 minutes, so a
// cancelled slot costs the studio nothing. What Nadav wants to catch is the
// member who cancels and then simply doesn't train that day at all. We give
// them an hour to book something else before saying anything.
const CANCELLATION_GRACE_HOURS = 1;

// user_ids with at least one live registration on the given date.
async function registeredUserIdsOn(dateStr) {
  const sessions = await fetchScheduleRange(dateStr, dateStr);
  const ids = new Set();
  for (const session of sessions) {
    for (const reg of session.registration_Details || []) {
      if (reg.user_id != null) ids.add(String(reg.user_id));
    }
  }
  return ids;
}

async function checkLateCancellations() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const notifiedKeys = new Set(state.notifiedLateCancellationKeys || []);

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date();
  from.setDate(from.getDate() - 3);

  const result = await arbox.getReport("bookingCancellationReport", {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to,
    limit: 200,
    group_by: "user",
  });
  const cancellations = result.data || [];
  const now = new Date();
  let changed = false;
  // One lookup per affected date, not per cancellation.
  const registeredByDate = new Map();

  for (const c of cancellations) {
    if (c.cancelled_by !== "user") continue; // staff-initiated cancellations aren't the customer's fault
    if (!c.phone || !c.date) continue;
    const key = `${c.user_id}:${c.schedule_id}`;
    if (notifiedKeys.has(key)) continue;

    // Give them an hour to book something else before we say anything.
    if (!isAfterGoLive(c.cancelled_time)) continue;
    const cancelledAt = new Date((c.cancelled_time || "").replace(" ", "T"));
    if (isNaN(cancelledAt)) continue;
    if (now - cancelledAt < CANCELLATION_GRACE_HOURS * 60 * 60 * 1000) continue;

    if (!registeredByDate.has(c.date)) {
      registeredByDate.set(c.date, await registeredUserIdsOn(c.date));
    }
    // They rebooked that same day - nothing to say.
    if (registeredByDate.get(c.date).has(String(c.user_id))) continue;

    await whatsapp.sendTemplate(c.phone.replace("+", ""), "late_cancellation_callout", [
      c.first_name || "",
      c.class_name || "אימון",
      `${c.date || ""} ${(c.start_time || "").slice(0, 5)}`.trim(),
    ]);
    await sleep(PACE_MS);
    notifiedKeys.add(key);
    changed = true;
  }

  if (changed) {
    store.setArboxState({ ...state, notifiedLateCancellationKeys: Array.from(notifiedKeys) });
  }
}

// Nadav celebrates at 10, 25, 50 and 100 sessions in a row.
const STREAK_MILESTONES = [10, 25, 50, 100];

async function checkStreaks() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const lastRun = state.lastStreakCheckDate ? new Date(state.lastStreakCheckDate) : null;
  const now = new Date();
  if (lastRun && now - lastRun < 7 * 24 * 60 * 60 * 1000) return;

  const fmt = (d) => d.toISOString().slice(0, 10);
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const thisWeekSessions = await fetchScheduleRange(fmt(weekAgo), fmt(now));
  const thisWeekCounts = countRegistrationsByUser(thisWeekSessions);

  const streaks = { ...(state.userStreaks || {}) };
  const seenThisWeek = new Set(thisWeekCounts.keys());

  // Anyone who was on a streak but had zero registrations this week breaks it.
  for (const userId of Object.keys(streaks)) {
    if (!seenThisWeek.has(Number(userId)) && !seenThisWeek.has(userId)) {
      streaks[userId] = { ...streaks[userId], streak: 0 };
    }
  }

  for (const [userId, info] of thisWeekCounts) {
    const key = String(userId);
    const previousStreak = streaks[key]?.streak || 0;
    const newStreak = previousStreak + 1;
    streaks[key] = { streak: newStreak, name: info.name, phone: info.phone };

    if (STREAK_MILESTONES.includes(newStreak)) {
      await whatsapp.sendTemplate(info.phone.replace("+", ""), "streak_milestone_v2", [
        info.name || "",
        String(newStreak),
      ]);
      await sleep(PACE_MS);
    }
  }

  store.setArboxState({ ...state, userStreaks: streaks, lastStreakCheckDate: now.toISOString() });
}

// Checks in with newer members a couple of times during their first two
// months - a genuine "how's it going" that (unlike the other automations)
// invites a real reply, which just flows into the normal AI conversation.
const NEW_MEMBER_CHECKIN_MILESTONES = [14, 28]; // days since joining

async function checkNewMemberCheckins() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;

  const state = store.getArboxState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastNewMemberCheckinDate === today) return; // once a day is plenty for a milestone this coarse

  const sentKeys = new Set(state.sentNewMemberCheckinKeys || []);
  const now = new Date();
  let changed = false;

  const members = await arbox.getAllActiveMembers();
  for (const member of members) {
    if (!member.phone || member.allow_sms === "no" || !member.created_at) continue;
    const daysSinceJoined = Math.floor((now - new Date(member.created_at)) / (1000 * 60 * 60 * 24));

    for (const milestone of NEW_MEMBER_CHECKIN_MILESTONES) {
      if (Math.abs(daysSinceJoined - milestone) > 2) continue; // small window around the target day
      const key = `${member.user_id}:${milestone}`;
      if (sentKeys.has(key)) continue;

      await whatsapp.sendTemplate(member.phone.replace("+", ""), "new_member_checkin_v2", [
        member.first_name || "",
        String(Math.round(milestone / 7)),
      ]);
      await sleep(PACE_MS);
      sentKeys.add(key);
      changed = true;
    }
  }

  store.setArboxState({
    ...state,
    lastNewMemberCheckinDate: today,
    sentNewMemberCheckinKeys: changed ? Array.from(sentKeys) : state.sentNewMemberCheckinKeys,
  });
}

// Last outcome of each check, so /status can show why nothing happened. These
// errors are only logged otherwise, and the Render log is not always reachable
// when you need it.
const lastRun = {};

function record(label, promise) {
  return promise
    .then(() => {
      lastRun[label] = { ok: true, at: new Date().toISOString() };
    })
    .catch((e) => {
      lastRun[label] = { ok: false, error: e.message, at: new Date().toISOString() };
      console.error(`Arbox monitor (${label}) error:`, e.message);
    });
}

function startMonitoring(intervalMs = 2 * 60 * 1000) {
  const runAll = () => {
    record("lead no-response", checkLeadNoResponse());
    checkNewLeads().catch((e) => console.error("Arbox monitor (leads) error:", e.message));
    checkDebtReport().catch((e) => console.error("Arbox monitor (debt) error:", e.message));
    checkAttendanceReport().catch((e) => console.error("Arbox monitor (attendance) error:", e.message));
    checkDueTasks().catch((e) => console.error("Arbox monitor (tasks) error:", e.message));
    checkBirthdays().catch((e) => console.error("Arbox monitor (birthdays) error:", e.message));
    checkFailedPayments().catch((e) => console.error("Arbox monitor (failed payments) error:", e.message));
    checkNewMembers().catch((e) => console.error("Arbox monitor (new members) error:", e.message));
    checkLostLeads().catch((e) => console.error("Arbox monitor (lost leads) error:", e.message));
    checkTrialReminders().catch((e) => console.error("Arbox monitor (trial reminders) error:", e.message));
    checkAbsences().catch((e) => console.error("Arbox monitor (absences) error:", e.message));
    checkCoachTrialNotices().catch((e) => console.error("Arbox monitor (coach notices) error:", e.message));
    checkCoachReplacements().catch((e) => console.error("Arbox monitor (coach replacements) error:", e.message));
    checkAttendanceTrends().catch((e) => console.error("Arbox monitor (attendance trends) error:", e.message));
    checkLateCancellations().catch((e) => console.error("Arbox monitor (late cancellations) error:", e.message));
    checkStreaks().catch((e) => console.error("Arbox monitor (streaks) error:", e.message));
    checkNewMemberCheckins().catch((e) => console.error("Arbox monitor (new member checkins) error:", e.message));
  };
  runAll();
  setInterval(runAll, intervalMs);
}

module.exports = {
  lastRun,
  isAfterGoLive,
  automationsStart,
  HARD_STOP_ACTIVE: HARD_STOP,
  startMonitoring,
  checkNewLeads,
  checkDebtReport,
  checkAttendanceReport,
  checkDueTasks,
  checkBirthdays,
  checkFailedPayments,
  checkNewMembers,
  checkLostLeads,
  checkTrialReminders,
  checkAbsences,
  checkLeadNoResponse,
  checkCoachTrialNotices,
  checkCoachReplacements,
  checkAttendanceTrends,
  checkLateCancellations,
  checkStreaks,
  checkNewMemberCheckins,
};
