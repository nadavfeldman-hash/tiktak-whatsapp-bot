// A fuse in front of every outgoing template, sitting underneath all the
// per-automation logic.
//
// Every incident this bot has caused has had the same shape: some check decided
// that a large group of people all qualified at the same moment, and the code
// dutifully messaged all of them. The weekly summary reaching every member. A
// widened query making 465 old leads look new. Each time the fix was another
// `if` inside that particular check - and each time the next incident came from
// a different check that did not have it.
//
// This is the guard that does not depend on any check being written correctly.
// It counts what actually leaves the building, and if that count stops looking
// like a gym's normal day it cuts the power and tells Nadav. Real activity here
// is a handful of messages an hour: a lead arrives, someone's status moves,
// somebody has a birthday. Twenty in an hour is never real.
//
// It is a fuse and not a throttle on purpose. A throttle would slow a flood
// down and then deliver it anyway. Once this trips, everything stops until a
// person looks at it and resets it from the admin panel.

const store = require("./store");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Set when the automations sent on their own with nothing above them. Since
// then a proposal has to pass a per-automation switch, a de-duplication rule and
// a seven-day repeat rule before it reaches here, and Nadav works in bursts -
// six status changes in four minutes on an ordinary morning took this to seven
// of eight, one away from locking him out of his own tool for no reason.
//
// Twenty an hour still leaves it doing its job: the day this was written to
// prevent put forty-six messages out in three seconds. A fuse that trips during
// normal work gets resented and then ignored, and an ignored fuse protects
// nobody.
// Overridable for a one-off approved broadcast (e.g. an urgent schedule change
// that has to reach everyone the same day) - Nadav raises these by hand in
// Render for the day and brings them back down afterward. Unset, nothing
// changes from the defaults below.
// Overridable for a one-off approved broadcast (e.g. an urgent schedule change
// that has to reach everyone the same day) - Nadav raises these by hand in
// Render for the day and brings them back down afterward. Unset, nothing
// changes from the defaults below. Back to normal as of 2026-10-21: the
// power-outage broadcast (2026-10-20) is done.
const MAX_PER_HOUR = Number(process.env.FUSE_MAX_PER_HOUR) || 20;
const MAX_PER_DAY = Number(process.env.FUSE_MAX_PER_DAY) || 60;

function fuseState() {
  return store.getArboxState().fuse || {};
}

function isTripped() {
  return Boolean(fuseState().trippedAt);
}

function status() {
  const f = fuseState();
  const recent = recentSends();
  return {
    tripped: Boolean(f.trippedAt),
    trippedAt: f.trippedAt || null,
    reason: f.reason || null,
    lastHour: countSince(recent, HOUR_MS),
    lastDay: countSince(recent, DAY_MS),
    maxPerHour: MAX_PER_HOUR,
    maxPerDay: MAX_PER_DAY,
  };
}

// The running tally of sends, kept separately from sentTemplateLog. That log is
// keyed by person and template, so a second send to the same pair overwrites the
// first and the flood undercounts itself - exactly when the count matters most.
function recentSends() {
  const list = store.getArboxState().recentSendTimes || [];
  const cutoff = Date.now() - DAY_MS;
  return list.filter((t) => new Date(t).getTime() >= cutoff);
}

function countSince(times, windowMs) {
  const cutoff = Date.now() - windowMs;
  return times.filter((t) => new Date(t).getTime() >= cutoff).length;
}

// Called before a send. Returns a reason to refuse, or null to allow.
function blockReason() {
  if (isTripped()) {
    return `הנתיך קפץ ב-${fuseState().trippedAt} (${fuseState().reason}) - צריך איפוס ידני`;
  }
  const recent = recentSends();
  if (countSince(recent, HOUR_MS) >= MAX_PER_HOUR) {
    return trip(`${MAX_PER_HOUR} הודעות בשעה האחרונה`);
  }
  if (countSince(recent, DAY_MS) >= MAX_PER_DAY) {
    return trip(`${MAX_PER_DAY} הודעות ביממה האחרונה`);
  }
  return null;
}

function trip(reason) {
  const state = store.getArboxState();
  store.setArboxState({ ...state, fuse: { trippedAt: new Date().toISOString(), reason } });
  console.error(`FUSE TRIPPED: ${reason}. All template sending is now stopped.`);
  notifyAdmin(reason);
  return `הנתיך קפץ: ${reason}`;
}

// Best effort, and never allowed to throw: if warning Nadav fails, the fuse must
// still hold. Sent as plain text rather than a template so it cannot itself be
// stopped by the very thing it is reporting.
// 22/11 Nadav ("שלא יקרה יותר"): the fuse tripped at 14:58 and he only found out an hour later, by noticing
// leads he had moved to "ללא מענה" never got a message - the WhatsApp text alone got lost in his regular
// chat traffic. A second, distinct channel (our own app push) alongside it, so a trip is hard to miss.
function notifyAdmin(reason) {
  const admin = process.env.ADMIN_PHONE;
  if (!admin) return;
  const text = `🛑 עצרתי את כל ההודעות האוטומטיות.\nהסיבה: ${reason}.\nזה חריג ולא אמור לקרות ביום רגיל - כנראה יש תקלה.\nכלום לא ייצא עד שתאפס בפאנל.`;
  require("./whatsapp").sendText(admin, text).catch(() => {});
  fetch(`${require("./arbox").LEAGUE_URL()}/api/hooks/push`, {
    method: "POST", headers: require("./arbox").leagueHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ phone: admin, title: "🛑 הנתיך קפץ - הודעות נעצרו", body: reason }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

// Called after a send actually succeeds.
function record() {
  const state = store.getArboxState();
  const times = (state.recentSendTimes || []).concat(new Date().toISOString());
  const cutoff = Date.now() - DAY_MS;
  store.setArboxState({
    ...state,
    recentSendTimes: times.filter((t) => new Date(t).getTime() >= cutoff),
  });
}

function reset() {
  const state = store.getArboxState();
  store.setArboxState({ ...state, fuse: {}, recentSendTimes: [] });
  console.log("Fuse reset by hand.");
}

module.exports = { blockReason, record, reset, status, isTripped, MAX_PER_HOUR, MAX_PER_DAY };
