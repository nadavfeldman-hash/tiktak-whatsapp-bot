const arbox = require("./arbox");
const whatsapp = require("./whatsapp");
const store = require("./store");

const outbox = require("./outbox");
const events = require("./events");
const TEMPLATES = require("../templates.json");

const ADMIN_PHONE = process.env.ADMIN_PHONE;

// Every customer-facing message in this file goes through here, and here it is
// not sent - it is proposed. Nadav approves it in the panel, and only then does
// it reach a phone.
//
// It deliberately keeps the exact signature of the old sendTemplate, so none of
// the seventeen checks had to be rewritten to gain this. Their decision logic is
// untouched; what that logic produces is now a suggestion instead of an action.
//
// Returns the queued proposal, or null when there is nothing to queue (one is
// already waiting, or it has already been sent). Callers that read null as "not
// handled, look again next time" keep behaving exactly as before.
function queueMessage(to, template, params = [], options = {}) {
  // Arbox holds numbers in whatever shape whoever typed them used: +972...,
  // 054-544..., 0527829504, and a couple with a stray direction mark pasted in
  // from a spreadsheet. Every check used to do replace("+", "") and nothing
  // else, which leaves a local 05... number that WhatsApp cannot deliver to. It
  // fails at the far end, quietly, and the person simply never hears from us -
  // the worst kind of fault, because it looks exactly like everything working.
  // Normalised here, in the one place every proposal passes through, so no
  // check can get it wrong again.
  const label = TEMPLATE_LABELS[template] || template;
  // Forty of the fifty-four leads in Arbox have their surname typed into the
  // first-name box - "חגית מייזליק", "Ben Rozenberg" - so three quarters of
  // these messages opened with a full name. The whole point of them is that they
  // read as Nadav writing personally, and nobody who knows you opens with your
  // surname. Trimmed here, where every message passes.
  params = params.map((p, i) => (i === 0 ? firstNameOnly(p) : p));
  const who = params[0] || "";

  // Every outcome below is written to the event log, including the ones that
  // lead nowhere. A message that went out can be seen on the phone; one that did
  // not was previously visible nowhere at all, which is why "why didn't they get
  // it?" could only ever be answered with a guess.
  if (!automationOn(label)) {
    events.decision({ automation: label, person: who, phone: to, outcome: "לא נשלח", reason: "האוטומציה כבויה" });
    return null;
  }

  const phone = usablePhone(to);
  if (!phone) {
    events.decision({ automation: label, person: who, phone: to, outcome: "לא נשלח", reason: "מספר טלפון לא תקין" });
    return null;
  }

  const queued = outbox.propose({
    to: phone,
    template,
    params,
    automation: label,
    personName: who,
    reason: options.reason || "",
    preview: renderTemplate(template, params),
  });

  if (!queued) {
    events.decision({
      automation: label,
      person: who,
      phone,
      outcome: "לא נשלח",
      reason: "כבר נשלח או כבר ממתין",
    });
    return null;
  }

  events.decision({
    automation: label,
    person: who,
    phone,
    outcome: queued.status === "approved" ? "ממתין לשליחה" : "ממתין לאישור שלך",
  });
  return queued;
}

// What the person will actually read, blanks filled in - so approving is a
// decision about real words rather than about a template name.
function renderTemplate(name, params) {
  const bare = name.replace(/_v2$/, "");
  const t = TEMPLATES.find((x) => x.name === name || x.name === bare);
  if (!t) return "";
  return String(t.body).replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] ?? m);
}

// Plain Hebrew for the queue, so the panel says why somebody is about to be
// written to rather than naming a template.
const TEMPLATE_LABELS = {
  new_lead_details_request_v2: "ליד חדש",
  lead_no_response_1_v2: "שינוי סטטוס ליד",
  lead_no_response_2: "שינוי סטטוס ליד",
  lead_no_response_3_v2: "שינוי סטטוס ליד",
  lost_lead_goodbye_v2: "ליד אבוד",
  welcome_new_member_v2: "מצטרף חדש",
  new_member_checkin_v2: "צ׳ק-אין מצטרף חדש",
  trial_booking_confirmed: "נרשם לאימון ניסיון",
  trial_reminder_day_before_v2: "תזכורת אימון ניסיון",
  trial_reminder_same_day_v2: "תזכורת אימון ניסיון",
  birthday_greeting_1_v2: "יום הולדת",
  birthday_greeting_2_v2: "יום הולדת",
  birthday_greeting_3_v2: "יום הולדת",
  birthday_greeting_4_v2: "יום הולדת",
  absence_reminder_1a: "נעדר מהאימונים",
  absence_reminder_1b: "נעדר מהאימונים",
  absence_reminder_1c: "נעדר מהאימונים",
  absence_reminder_2a: "נעדר מהאימונים",
  absence_reminder_2b: "נעדר מהאימונים",
  absence_reminder_3: "נעדר מהאימונים",
  streak_milestone_v2: "רצף אימונים",
  late_cancellation_callout: "ביטול בלי הרשמה מחדש",
  coach_trial_notice_morning: "עדכון למאמן",
  coach_replacement_notice: "החלפת מאמן",
  failed_payment_reminder: "תשלום שנכשל",
};

// Every automation, whether or not a template for it exists yet. The panel
// lists these, so a name that appears here is a switch Nadav can see and reach.
const ALL_AUTOMATIONS = [
  "ליד חדש",
  "שינוי סטטוס ליד",
  "ליד אבוד",
  "מצטרף חדש",
  "נעדר מהאימונים",
  "יום הולדת",
  "צ׳ק-אין מצטרף חדש",
  "נרשם לאימון ניסיון",
  "תזכורת אימון ניסיון",
  "ביטול בלי הרשמה מחדש",
  "רצף אימונים",
  "עדכון למאמן",
  "תשובה בשיחה",
  // Listed even though no approved wording exists for them yet, so the panel
  // shows the whole set. An automation missing from here would be one with no
  // off switch, which is what the single global toggle amounted to.
  "החלפת מאמן",
  "תשלום שנכשל",
];

// Off unless switched on, one at a time, by name.
//
// It used to be a single switch for all seventeen at once, which meant the only
// way to try one was to turn on the lot - and turning on the lot is how a
// quiet evening became forty-six messages. Trust in these is earned one
// automation at a time, and this is what lets that happen: an automation nobody
// has vouched for cannot send, no matter what any other setting says.
function automationOn(label) {
  const enabled = store.getSettings().enabledAutomations;
  if (!Array.isArray(enabled)) return false;
  return enabled.includes(label);
}



// Off means "do not look", not "look and throw away".
//
// These checks work by comparing what Arbox says now against what they recorded
// last time. While the automation was switched off they kept running and kept
// recording - so a status Nadav set during that window was seen, not sent, and
// written down as handled. Switching the automation back on could not recover
// it: as far as the check was concerned nothing had changed since. Two leads
// were swallowed exactly that way.
function watching(label) {
  return automationOn(label);
}

// The first word, and only when there is clearly more than one.
//
// Deliberately not clever: no attempt to guess which part is the given name, no
// list of particles. If somebody is stored as one word they keep it, and if a
// business is stored as a name the first word is still a reasonable thing to
// greet. Getting this wrong in the other direction - inventing a name - is far
// worse than leaving one long.
function firstNameOnly(value) {
  const name = String(value ?? "").trim();
  if (!name.includes(" ")) return name;
  return name.split(/\s+/)[0];
}

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

// Two automations point at templates Nadav chose not to write, and Meta will
// only send a template it has approved. Left as-is they would throw on every
// trigger - a payment fails, a coach is swapped, and the check dies silently in
// a catch. They stay off until their wording exists and is approved.
const AUTOMATIONS_WITHOUT_TEMPLATES = new Set(["failed payments", "coach replacements"]);

// The weekly attendance summary is off for good, by Nadav's decision. It is the
// only automation that writes to every active member on the same day, and it is
// what caused the day's worst damage - a mass send, then repeats, then reports
// of "0 workouts this week" landing on people who had already left. A digest
// that reaches everyone at once has no margin for error, and he does not want it.
const WEEKLY_SUMMARY_DISABLED = true;

function hasTemplate(automationName) {
  return !AUTOMATIONS_WITHOUT_TEMPLATES.has(automationName);
}

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
        await queueMessage(lead.phone.replace("+", ""), "new_lead_details_request_v2", [
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

  store.setArboxState({ lastLeadCheckTime: latestTime.toISOString() });
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

  store.setArboxState({ lastDebtReportDate: today });
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

  store.setArboxState({ lastAttendanceReportDate: today });
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
    store.setArboxState({ sentTaskReminderIds: Array.from(sentIds) });
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
    await queueMessage(person.phone.replace("+", ""), template, [person.first_name]);
    await sleep(PACE_MS);
  }

  store.setArboxState({ lastBirthdayCheckDate: today });
}

async function checkFailedPayments() {
  if (!hasTemplate("failed payments")) return;
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
        await queueMessage(phone.replace("+", ""), "failed_payment_reminder", [t.first_name]);
        await sleep(PACE_MS);
      }
    } catch (e) {
      console.error("Failed to notify about failed payment", t.transaction_id, e.message);
    }
    notifiedKeys.add(key);
  }

  if (seenThisRun.size > 0) {
    store.setArboxState({ notifiedFailedPaymentKeys: Array.from(notifiedKeys) });
  }
}

async function checkNewMembers() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;
  if (!watching("מצטרף חדש")) return;

  const state = store.getArboxState();
  // Tracked as a set of people already welcomed rather than "the highest user_id
  // seen so far". Arbox returns converted leads unordered, and a user_id is
  // assigned when the lead is first created, not when they join - so a
  // long-standing lead who signs up today carries an old, low id, falls under
  // any high-water mark, and is never welcomed at all. A silent miss, which is
  // exactly the kind that goes unnoticed.
  const welcomed = new Set(state.welcomedUserIds || []);
  const converted = await arbox.getAllConvertedLeads();

  // Same guard as the lost-lead check: a sudden jump in how many people we can
  // see means the query widened, not that they all joined today.
  const unseen = converted.filter((c) => !welcomed.has(String(c.user_id))).length;
  const isFirstRun = state.welcomedUserIds === undefined || unseen > 20;
  if (isFirstRun && unseen > 20) {
    console.log(`New members: ${unseen} unseen at once - recording silently rather than messaging them.`);
  }

  for (const c of converted) {
    if (welcomed.has(String(c.user_id))) continue;
    if (!isFirstRun && c.phone) {
      // Converting a lead to a member is likewise Nadav's own doing.
      await queueMessage(c.phone.replace("+", ""), "welcome_new_member_v2", [c.first_name], {
        deliberate: true,
      });
      await sleep(PACE_MS);
    }
    welcomed.add(String(c.user_id));
  }

  store.setArboxState({ welcomedUserIds: Array.from(welcomed) });
}

async function checkLostLeads() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;
  if (!watching("ליד אבוד")) return;

  const state = store.getArboxState();
  // Same reasoning as the welcome check: track who has been said goodbye to,
  // not the highest id seen, because the list is unordered and ids predate the
  // event.
  const saidGoodbye = new Set(state.saidGoodbyeUserIds || []);
  const lost = await arbox.getAllLostLeads();

  // Widening the query from 50 records to all 515 would otherwise look like 465
  // people going lost at once, and message every one of them. Any jump this
  // large is a change in what we can see, not in what happened, so the list is
  // recorded in silence and normal behaviour resumes from the next cycle.
  const unseen = lost.filter((c) => !saidGoodbye.has(String(c.user_id))).length;
  const isFirstRun = state.saidGoodbyeUserIds === undefined || unseen > 20;
  if (isFirstRun && unseen > 20) {
    console.log(`Lost leads: ${unseen} unseen at once - recording silently rather than messaging them.`);
  }

  for (const c of lost) {
    if (saidGoodbye.has(String(c.user_id))) continue;
    if (!isFirstRun && c.phone) {
      // Marking a lead lost is Nadav closing that file himself, the same kind of
      // deliberate act as moving a status - so it is not held back by the
      // blanket protection, only by the no-repeats rule.
      await queueMessage(c.phone.replace("+", ""), "lost_lead_goodbye_v2", [c.first_name], {
        deliberate: true,
      });
      await sleep(PACE_MS);
    }
    saidGoodbye.add(String(c.user_id));
  }

  store.setArboxState({ saidGoodbyeUserIds: Array.from(saidGoodbye) });
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

// Confirm a trial the moment it is booked.
//
// The two reminders that already exist speak the evening before and on the
// morning itself, which leaves whoever booked on a Tuesday for next Sunday with
// five days of silence after the one action that says they are seriously
// considering this. The confirmation closes that gap: it lands while they are
// still on the page, with the address and what to bring.
const TRIAL_CONFIRM_LOOKAHEAD_DAYS = 21;
const HEBREW_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function hebrewWhen(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  // Never begins with a digit: a line starting with a number flips direction in
  // Hebrew and the date comes out reversed on the phone.
  return `יום ${HEBREW_DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}`;
}

async function checkTrialBookings() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;
  if (!watching("נרשם לאימון ניסיון")) return;

  const state = store.getArboxState();
  const confirmed = new Set(state.confirmedTrialKeys || []);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const found = [];
  for (let i = 0; i <= TRIAL_CONFIRM_LOOKAHEAD_DAYS; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    found.push(...(await findTrialRegistrations(fmt(d))));
  }

  // Trials already on the books when this was switched on were booked before
  // anybody promised them a confirmation, and a note about a session they
  // arranged last week reads as a mistake. They are recorded in silence and the
  // automation starts from now, the same way the absence reminders do.
  const unseen = found.filter(({ session, reg }) => !confirmed.has(`${session.schedule_id}:${reg.user_id}`));
  const firstRun = state.confirmedTrialKeys === undefined;

  let changed = false;
  for (const { session, reg } of found) {
    const key = `${session.schedule_id}:${reg.user_id}`;
    if (confirmed.has(key)) continue;

    if (!firstRun && reg.phone && isAfterGoLive(reg.booking_time)) {
      await queueMessage(reg.phone.replace("+", ""), "trial_booking_confirmed", [
        (reg.full_name || "").split(" ")[0],
        hebrewWhen(session.date),
        String(session.start_time || "").slice(0, 5),
      ]);
    }
    confirmed.add(key);
    changed = true;
  }

  if (firstRun) {
    console.log(`Trial bookings: starting from now - ${unseen.length} already booked, recorded in silence.`);
  }
  if (changed) {
    store.setArboxState({ confirmedTrialKeys: Array.from(confirmed) });
  }
}

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
      await queueMessage(reg.phone.replace("+", ""), template, [
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
    store.setArboxState({ sentTrialReminderKeys: Array.from(sentKeys) });
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

// Who has stopped coming, worked out from attendance.
//
// This used to read Arbox's absenceReport, and that was simply the wrong list:
// it returns only people absent 31 days or more, while these reminders look for
// 4 to 30. The two ranges do not overlap anywhere, so the four- and eight-day
// follow-ups could never fire, and in the whole time they were switched on they
// never once did. Nobody noticed, because an automation that sends nothing looks
// exactly like an automation with nothing to say.
//
// Attendance is counted from check-ins rather than bookings. Booking a session
// and turning up to it are different things, and only the second one means
// somebody is still training.
const ABSENCE_LOOKBACK_DAYS = 35;
const ABSENCE_FUTURE_DAYS = 14;

async function fetchSessionsPaged(from, to) {
  const all = [];
  let page = 1;
  while (page <= 40) {
    const res = await arbox.getSchedule({
      from_date: from,
      to_date: to,
      limit: 200,
      page,
      registration_details: "1",
    });
    all.push(...(res.data || []));
    if (!res.extra?.pagination?.next_page_url) break;
    page++;
  }
  return all;
}

// A month of sessions is a few thousand records, and asking for it in one go
// tends to come back truncated - so it is fetched a week at a time.
async function attendancePicture() {
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const past = [];
  for (let i = ABSENCE_LOOKBACK_DAYS; i > 0; i -= 7) {
    past.push(...(await fetchSessionsPaged(day(-i), day(-Math.max(i - 7, 0)))));
  }

  const lastSeen = new Map();
  const people = new Map();
  for (const session of past) {
    for (const r of session.registration_Details || []) {
      if (r.checked_in !== 1) continue;
      const id = String(r.user_id);
      people.set(id, { name: r.full_name, phone: r.phone });
      if (!lastSeen.has(id) || session.date > lastSeen.get(id)) lastSeen.set(id, session.date);
    }
  }

  // Somebody booked into a future session has not drifted away, whatever the
  // gap since they last came. Writing "we miss you" to a person holding a ticket
  // for tomorrow morning is what makes a system feel like a machine.
  const booked = new Set();
  for (const session of await fetchSessionsPaged(day(1), day(ABSENCE_FUTURE_DAYS))) {
    for (const r of session.registration_Details || []) booked.add(String(r.user_id));
  }

  return { lastSeen, people, booked };
}

// Arbox holds a few malformed numbers - a missing country code, a stray
// direction mark pasted in from somewhere. Sending to those fails noisily and
// achieves nothing, so they are skipped in silence.
function usablePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  // An Israeli mobile typed without its leading zero: exactly nine digits
  // beginning with 5. Recovered rather than dropped, because it is a real
  // customer with a perfectly good number and one missing character.
  if (digits.length === 9 && digits.startsWith("5")) return "972" + digits;
  // Anything else is genuinely ambiguous - a digit too many, a stray character
  // pasted in from a spreadsheet - and guessing at a phone number is how a
  // message reaches a stranger. Skipped.
  return null;
}

async function checkAbsences() {
  if (!customerAutomationsEnabled() || !process.env.ARBOX_API_KEY) return;
  if (!watching("נעדר מהאימונים")) return;

  const state = store.getArboxState();
  // Keyed by user and stage, so someone who keeps staying away hears from us
  // once per stage rather than once ever.
  const notifiedKeys = new Set(state.notifiedAbsenceKeys || []);

  const { lastSeen, people, booked } = await attendancePicture();
  const today = new Date(new Date().toISOString().slice(0, 10));

  // Everyone currently mid-absence, and which stage they are in.
  const due = [];
  for (const [id, date] of lastSeen) {
    const daysAgo = Math.round((today - new Date(date)) / 86400000);
    const stage = absenceStage(daysAgo);
    if (stage === null) continue;
    if (booked.has(id)) continue;
    const person = people.get(id) || {};
    const phone = usablePhone(person.phone);
    if (!phone) continue;
    due.push({ id, stage, daysAgo, phone, name: (person.name || "").split(" ")[0] });
  }

  // Starting from today, by Nadav's decision. Forty-two people are mid-absence
  // right now because this has never worked; switching it on without this would
  // write to all of them at once, which is precisely the failure that has
  // already happened twice. They are recorded as handled, in silence, and the
  // automation carries on normally for anyone who crosses a threshold from here.
  const firstRun = !state.absenceAttendanceStarted;
  if (firstRun) {
    for (const d of due) {
      // Every stage up to and including their current one, so a person eight
      // days absent today does not receive the fourteen-day message next week
      // for an absence that began before we were watching.
      for (let s = 0; s <= d.stage; s++) notifiedKeys.add(`${d.id}:${s}`);
    }
    store.setArboxState({
      notifiedAbsenceKeys: Array.from(notifiedKeys),
      absenceAttendanceStarted: new Date().toISOString(),
    });
    console.log(`Absences: starting from now - ${due.length} people already mid-absence recorded in silence.`);
    return;
  }

  let changed = false;
  for (const d of due) {
    const key = `${d.id}:${d.stage}`;
    if (notifiedKeys.has(key)) continue;

    const variants = ABSENCE_STAGES[d.stage].templates;
    const template = variants[Math.floor(Math.random() * variants.length)];
    // Only the last stage names how many days it has been.
    const params =
      template === "absence_reminder_3" ? [d.name, String(d.daysAgo)] : [d.name];

    const r = await queueMessage(d.phone, template, params);
    if (r === null) continue; // blocked by a guard - do not retire the reminder
    notifiedKeys.add(key);
    changed = true;
  }

  if (changed) {
    store.setArboxState({ notifiedAbsenceKeys: Array.from(notifiedKeys) });
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
  if (!watching("שינוי סטטוס ליד")) return;

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
    // Nadav moved this lead's status himself, so it is a deliberate act rather
    // than an automation's own inference - it is not held back by the blanket
    // protection or the daily cooldown, only by the no-repeats rule.
    const result = await queueMessage(
      lead.phone.replace("+", ""),
      template,
      [lead.first_name || ""],
      { deliberate: true }
    );
    // sendTemplate returns null when a guard blocked it - typically the
    // per-person daily cooldown. Marking that as "notified" would retire the
    // message permanently, so the lead would never hear from us even once the
    // cooldown lapsed. Only a message that actually left counts.
    if (result === null) continue;
    await sleep(PACE_MS);
    notifiedKeys.add(key);
    changed = true;
  }

  // The snapshot is saved every cycle, whether or not anything was sent, so the
  // next cycle has something to compare against.
  store.setArboxState({
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
  if (WEEKLY_SUMMARY_DISABLED) return;
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
    store.setArboxState({ lastAttendanceTrendCheckDate: now.toISOString() });
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
    await queueMessage(info.phone.replace("+", ""), template, params);
    await sleep(PACE_MS);
  }

  store.setArboxState({ lastAttendanceTrendCheckDate: now.toISOString() });
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
    await queueMessage(coachPhone.replace("+", ""), "coach_trial_notice_morning", [
      session.staff_member.name || "",
      session.session_name || "אימון",
      session.start_time || "",
      reg.full_name || "",
    ]);
    await sleep(PACE_MS);
  }

  store.setArboxState({ lastCoachTrialNoticeDate: today });
}

// Detects when a session's assigned coach changes from what we last saw, by
// snapshotting today's + tomorrow's schedule each run and diffing against the
// previous snapshot - Arbox has no "replacement" event/webhook of its own.
async function checkCoachReplacements() {
  if (!hasTemplate("coach replacements")) return;
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
        await queueMessage(newCoachPhone.replace("+", ""), "coach_replacement_notice", [
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

  store.setArboxState({ coachScheduleSnapshot: newSnapshot });
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

    const r = await queueMessage(c.phone.replace("+", ""), "late_cancellation_callout", [
      c.first_name || "",
      c.class_name || "אימון",
      `${c.date || ""} ${(c.start_time || "").slice(0, 5)}`.trim(),
    ]);
    if (r === null) continue;
    await sleep(PACE_MS);
    notifiedKeys.add(key);
    changed = true;
  }

  if (changed) {
    store.setArboxState({ notifiedLateCancellationKeys: Array.from(notifiedKeys) });
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
      await queueMessage(info.phone.replace("+", ""), "streak_milestone_v2", [
        info.name || "",
        String(newStreak),
      ]);
      await sleep(PACE_MS);
    }
  }

  store.setArboxState({ userStreaks: streaks, lastStreakCheckDate: now.toISOString() });
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

      await queueMessage(member.phone.replace("+", ""), "new_member_checkin_v2", [
        member.first_name || "",
        String(Math.round(milestone / 7)),
      ]);
      await sleep(PACE_MS);
      sentKeys.add(key);
      changed = true;
    }
  }

  store.setArboxState({
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

// Never let the same check run twice at once.
//
// Moving three checks onto short loops without removing them from the main one
// left two copies of each running at the same moment: both read the state, both
// concluded the same person qualified, and both sent before either had recorded
// anything. Four people were written to twice within the hour.
//
// The de-duplication rules could not help - they compare against what has been
// written down, and neither copy had written anything yet. The only fix that
// holds is not running the check twice at all, and this makes that true whatever
// anyone wires up later: a second call while the first is still going is
// skipped, not queued.
const running = new Set();
function once(name, fn) {
  return async () => {
    if (running.has(name)) {
      console.log(`Skipping ${name}: previous run still going.`);
      return;
    }
    running.add(name);
    try {
      await fn();
    } finally {
      running.delete(name);
    }
  };
}

// One loop. Everything in it, one after another, never two at once.
//
// There were three timers and seventeen checks, and the checks overlapped
// freely. Every incident of the last two days came out of that: two copies of
// one check both deciding the same person qualified and both sending; one check
// writing back a stale copy of the state and reverting what another had just
// recorded, so the daily debt report re-sent itself every two minutes all
// morning. Guards cannot fix this - they compare against what has been written
// down, and with concurrent writers there is no reliable "what has been written
// down".
//
// So there is one timer. It ticks every ten seconds and works through a list in
// order, awaiting each one. Two checks can no longer run at the same moment
// because there is only ever one running.
//
// Frequency is expressed as "every Nth tick" rather than as another timer.
// Things Nadav does by hand and then watches for run on every tick; things that
// read hundreds of records run rarely, because asking Arbox for three pages
// every ten seconds is rude and pointless.
const TICK_MS = 10 * 1000;
const SCHEDULE = [
  // Nadav sets a status and looks at his phone. This is the one that must feel
  // instant.
  { name: "שינוי סטטוס ליד", every: 1, run: checkLeadNoResponse },
  { name: "ליד חדש", every: 1, run: checkNewLeads },
  // Three pages of records; every third tick is still half a minute.
  { name: "ליד אבוד", every: 3, run: checkLostLeads },
  { name: "מצטרף חדש", every: 6, run: checkNewMembers },
  // Reads a month of sessions - expensive, and absence is measured in days.
  { name: "נעדר מהאימונים", every: 30, run: checkAbsences },
  { name: "נרשם לאימון ניסיון", every: 12, run: checkTrialBookings },
  { name: "תזכורת אימון ניסיון", every: 12, run: checkTrialReminders },
  { name: "יום הולדת", every: 30, run: checkBirthdays },
  { name: "ביטול בלי הרשמה מחדש", every: 12, run: checkLateCancellations },
  { name: "צ׳ק-אין מצטרף חדש", every: 30, run: checkNewMemberCheckins },
  { name: "רצף אימונים", every: 60, run: checkStreaks },
  { name: "עדכון למאמן", every: 30, run: checkCoachTrialNotices },
  { name: "החלפת מאמן", every: 30, run: checkCoachReplacements },
  { name: "מגמות נוכחות", every: 60, run: checkAttendanceTrends },
  { name: "תשלום שנכשל", every: 30, run: checkFailedPayments },
  // Reports to Nadav himself, not to customers.
  { name: "דוח חובות", every: 30, run: checkDebtReport },
  { name: "דוח נוכחות", every: 30, run: checkAttendanceReport },
  { name: "תזכורות משימות", every: 30, run: checkDueTasks },
  // Watches the watchers: an automation that has gone quiet, and messages that
  // never arrived. Every 60 ticks is ten minutes, which is often enough for
  // something measured in days.
  { name: "בדיקת תקינות", every: 60, run: () => require("./watchdog").run(module.exports) },
];

function startMonitoring(tickMs = TICK_MS) {
  let tick = 0;
  let busy = false;

  const runTick = async () => {
    // Belt and braces on top of the single timer: if a tick somehow runs long,
    // the next one waits rather than starting a second pass through the list.
    if (busy) return;
    busy = true;
    tick++;
    try {
      for (const job of SCHEDULE) {
        if (tick % job.every !== 0) continue;
        try {
          await job.run();
          lastRun[job.name] = { ok: true, at: new Date().toISOString() };
        } catch (e) {
          // Errors used to disappear into a .catch that printed to a console
          // nobody reads, so a dead automation looked exactly like a quiet one.
          lastRun[job.name] = { ok: false, error: e.message, at: new Date().toISOString() };
          events.failure(job.name, e.message);
        }
      }

      // The only place a customer is written to, and it sends strictly what has
      // been approved - by Nadav in the panel, or in advance for the automations
      // he has said may go on their own.
      outbox.sweep();
      await outbox.send();
    } finally {
      busy = false;
    }
  };

  runTick();
  setInterval(runTick, tickMs);
}

module.exports = {
  lastRun,
  once,
  ALL_AUTOMATIONS,
  automationOn,
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
  checkTrialBookings,
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
