// Two things nobody was watching: automations that go quiet, and messages that
// never arrive.
//
// The dangerous bug is the silent one. The absence reminders were reading the
// wrong report from the day they were written and could never have fired - and
// nothing said so, because an automation that is broken looks exactly like an
// automation with nothing to do. It sat like that for weeks.
//
// The same blindness applies at the other end. WhatsApp accepting a message
// says only that it took it; it reports the actual outcome later, and those
// reports were being stored and never read. A lead who never received their
// welcome is a customer lost in silence, and silence is precisely what nobody
// notices.
//
// So: an automation that should have run and has not is reported, and a message
// that failed to arrive is reported. Both to Nadav, once, not repeatedly.

const store = require("./store");
const events = require("./events");

// How long an automation may stay quiet before that is worth mentioning. These
// are generous: the point is to catch "dead for days", not "quiet this morning".
const SILENCE_HOURS = {
  "שינוי סטטוס ליד": 48,
  "ליד חדש": 48,
  "ליד אבוד": 72,
  "נעדר מהאימונים": 48,
  "נרשם לאימון ניסיון": 72,
  "תזכורת אימון ניסיון": 72,
};

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

// An automation is only "silent" if it is switched on. One nobody turned on is
// not broken, it is off, and saying otherwise trains people to ignore warnings.
function silentAutomations(monitor) {
  const enabled = store.getSettings().enabledAutomations || [];
  const out = [];
  for (const [name, limit] of Object.entries(SILENCE_HOURS)) {
    if (!enabled.includes(name)) continue;
    const run = monitor.lastRun[name];
    // Never having run at all is the worst case, not an excuse to say nothing.
    if (!run || hoursSince(run.at) > limit) {
      out.push({ name, lastRun: run ? run.at : null, hours: run ? Math.round(hoursSince(run.at)) : null });
    } else if (run.ok === false) {
      out.push({ name, failing: run.error });
    }
  }
  return out;
}

function recentFailedDeliveries(sinceIso) {
  const all = store.getArboxState().deliveryStatus || [];
  return all.filter((d) => d.status === "failed" && (!sinceIso || d.at > sinceIso));
}

// A second, independent check on top of checkTrialBookings/checkTrialReminders -
// not a re-run of their logic, because their logic is exactly what has been
// wrong before (first the absence reminders reading the wrong report, then
// isTrialRegistration missing a blank membership_type - caught 2026-11-03 only
// because Miri Hefetz had already trained and Nadav noticed by hand).
//
// This does not try to classify who is "really" a trial. It asks one ground-
// truth question instead: is this person, booked onto today's or tomorrow's
// schedule, in the real active-members list? If not, and they have received
// no message of any kind in the last 3 days, somebody fell through whatever
// the classifier currently is, known or not-yet-discovered. Flag them by name,
// same day, instead of finding out after they already showed up uncontacted.
async function unwelcomedVisitors() {
  const arbox = require("./arbox");
  const whatsapp = require("./whatsapp");
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = fmt(new Date());
  const tomorrow = fmt(new Date(Date.now() + 86400000));

  let activeMembers;
  try {
    activeMembers = await arbox.getAllActiveMembers();
  } catch {
    return []; // can't tell ground truth right now - say nothing rather than false-alarm
  }
  const activePhones = new Set(activeMembers.map((m) => String(m.phone || "").replace(/\D/g, "").slice(-9)));
  const log = whatsapp.sentLog ? whatsapp.sentLog() : {};

  const seen = new Map();
  for (const dateStr of [today, tomorrow]) {
    let result;
    try {
      result = await arbox.getSchedule({ from_date: dateStr, to_date: dateStr, limit: 200, registration_details: "1" });
    } catch {
      continue;
    }
    for (const session of result.data || []) {
      for (const reg of session.registration_Details || []) {
        if (reg.cancelled_time) continue;
        const digits = String(reg.phone || "").replace(/\D/g, "").slice(-9);
        if (digits.length < 8 || activePhones.has(digits)) continue;
        const to = String(reg.phone || "").replace(/\D/g, "");
        const RECENT_MS = 5 * 24 * 60 * 60 * 1000; // a stale welcome from months ago doesn't cover a new booking
        const messagedRecently = Object.entries(log).some(
          ([k, at]) => k.startsWith(`${to}:`) && Date.now() - new Date(at).getTime() < RECENT_MS
        );
        if (!messagedRecently && !seen.has(digits)) {
          seen.set(digits, { name: reg.full_name || reg.name || "", phone: to, date: dateStr, session: session.session_name });
        }
      }
    }
  }
  return Array.from(seen.values());
}

// Reported once each, not on every tick - an alert that repeats is an alert
// people learn to swipe away.
async function run(monitor) {
  const state = store.getArboxState();
  const reported = state.watchdogReported || {};
  const lines = [];

  for (const s of silentAutomations(monitor)) {
    const key = `silent:${s.name}:${new Date().toISOString().slice(0, 10)}`;
    if (reported[key]) continue;
    reported[key] = true;
    lines.push(
      s.failing
        ? `⚠️ "${s.name}" נכשלת: ${s.failing}`
        : `⚠️ "${s.name}" דלוקה אבל לא רצה ${s.hours ? `${s.hours} שעות` : "מעולם"}. כנראה תקלה.`
    );
    events.failure(s.name, s.failing || "לא רצה זמן רב מדי");
  }

  // חוק ברזל (Nadav, 24/10/2026): every message that did not reach a phone is reported to him by
  // name/number, so he can find the person another way. Read from the permanent delivery log
  // (src/delivery.js), not the short last-40 list: failed, or still not "delivered" after 30 minutes.
  const delivery = require("./delivery");
  const missed = delivery.undelivered({ minMinutes: 30, maxHours: 72, exclude: [process.env.ADMIN_PHONE || ""] });
  if (missed.length) {
    // names from what the bot already knows about members (phone -> name), last 9 digits
    const names = {};
    for (const v of Object.values(state.userStreaks || {})) if (v && v.phone && v.name) names[String(v.phone).replace(/\D/g, "").slice(-9)] = v.name;
    const who = (m) => `${names[m.phone] || ""} 0${m.phone}`.trim();
    const list = missed.slice(0, 15).map((m) => `${who(m)}${m.status === "failed" ? ` (נכשל${m.error ? `: ${m.error}` : ""})` : " (לא נמסר)"}${m.label ? ` [${m.label}]` : ""}`);
    lines.push(`📵 ${missed.length} הודעות לא הגיעו לטלפון: ${list.join(" · ")}${missed.length > 15 ? " · ועוד" : ""}`);
    for (const m of missed) {
      events.record({ kind: "decision", automation: "מסירה", phone: m.to, outcome: "לא הגיע", reason: m.error || (m.status === "failed" ? "נכשל" : "לא נמסר תוך 30 דקות") });
    }
    delivery.markReported(missed.map((m) => m.id));
  }

  const uncontacted = await unwelcomedVisitors().catch(() => []);
  for (const v of uncontacted) {
    const key = `uncontacted:${v.phone}:${v.date}`;
    if (reported[key]) continue;
    reported[key] = true;
    lines.push(
      `👀 ${v.name || ""} 0${v.phone.slice(-9)} רשום ל-${v.session || "אימון"} ב-${v.date}, לא מנוי פעיל ולא קיבל שום הודעה - תבדוק ידנית, כנראה חוסר בסיווג.`
    );
    events.failure("בדיקת תקינות", `לא זוהה כליד/ניסיון: ${v.name || v.phone}`);
  }

  store.setArboxState({
    watchdogReported: reported,
    watchdogLastDeliveryCheck: new Date().toISOString(),
  });

  if (!lines.length) return { alerts: 0 };

  const admin = process.env.ADMIN_PHONE;
  if (admin) {
    // Plain text, best effort, never allowed to throw - a warning that breaks
    // the thing it is warning about is worse than no warning.
    try {
      await require("./whatsapp").sendText(admin, lines.join("\n\n"));
    } catch (e) {
      // Free text reaches him only inside WhatsApp's 24-hour window; outside it, the approved
      // announcement template (one line - template parameters cannot carry newlines).
      try {
        await require("./whatsapp").sendOwnerTemplate(admin, "general_announcement", [lines.join(" | ").replace(/\s*\n+\s*/g, " ").slice(0, 900)]);
      } catch (e2) {
        console.error("Watchdog could not reach Nadav:", e.message, "/", e2.message);
      }
    }
  }
  return { alerts: lines.length };
}

module.exports = { run, silentAutomations, recentFailedDeliveries, unwelcomedVisitors, SILENCE_HOURS };
