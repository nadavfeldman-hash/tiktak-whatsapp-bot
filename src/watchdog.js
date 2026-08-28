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

  const failed = recentFailedDeliveries(state.watchdogLastDeliveryCheck);
  if (failed.length) {
    const list = failed.slice(0, 5).map((f) => `${f.to}${f.error ? ` (${f.error})` : ""}`).join("\n");
    lines.push(`📵 ${failed.length} הודעות לא הגיעו:\n${list}`);
    for (const f of failed) {
      events.record({ kind: "decision", automation: "מסירה", phone: f.to, outcome: "לא הגיע", reason: f.error || "נכשל" });
    }
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
      console.error("Watchdog could not reach Nadav:", e.message);
    }
  }
  return { alerts: lines.length };
}

module.exports = { run, silentAutomations, recentFailedDeliveries, SILENCE_HOURS };
