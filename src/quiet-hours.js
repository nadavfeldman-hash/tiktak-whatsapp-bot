// When the business does not write to people.
//
// Two rules, and neither has an exception. A message at three in the morning
// wakes somebody up, and a message on Shabbat reaches customers who keep it - in
// both cases from a business they pay, and in both cases the damage is done the
// moment the phone buzzes. There is nothing so urgent here that it cannot wait
// until morning: every message this system sends is a follow-up, a reminder or a
// greeting.
//
// Messages are held, not dropped. The queue keeps an approved message and tries
// again next cycle, so one that qualifies at midnight goes out after eight the
// next morning rather than disappearing.

// Nights. Deliberately wide at both ends: nobody thanks a gym for a message at
// half past six.
const NIGHT_START_HOUR = 21; // from 21:00
const NIGHT_END_HOUR = 8; // until 08:00

// Shabbat. Its real start moves through the year - about 16:15 in December,
// 19:30 in June - and its end moves with it. Rather than compute sunset, this
// takes the earliest plausible start and the latest plausible end, so the quiet
// period always covers the real one. An hour of extra quiet on a Friday
// afternoon costs nothing; a message that lands during Shabbat cannot be undone.
const SHABBAT_START_FRIDAY_HOUR = 15;
const SHABBAT_END_SATURDAY_HOUR = 21;

// The festivals, by their Hebrew date. Israeli observance - one day for the
// festival days that are two in the diaspora.
//
// Read from the Hebrew calendar built into Node rather than a table of dates, so
// this does not quietly expire in a year and start messaging people on Yom
// Kippur because nobody remembered to extend a list.
const FESTIVALS = {
  Tishri: { 1: "ראש השנה", 2: "ראש השנה", 10: "יום כיפור", 15: "סוכות", 22: "שמחת תורה" },
  Nisan: { 15: "פסח", 21: "שביעי של פסח" },
  Sivan: { 6: "שבועות" },
};

const hebrewFormat = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "numeric" });

function hebrewDate(date) {
  const parts = hebrewFormat.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { month: get("month"), day: Number(get("day")) };
}

function festivalOn(date) {
  const { month, day } = hebrewDate(date);
  return FESTIVALS[month]?.[day] || null;
}

// Returns the reason to hold, or null when it is fine to send.
function holdReason(now = new Date()) {
  const day = now.getDay(); // 5 = Friday, 6 = Saturday
  const hour = now.getHours();

  // A festival, like Shabbat, begins the evening before. The Hebrew calendar
  // rolls at sunset while this rolls at midnight, so the eve is handled the same
  // way Friday is: quiet from the afternoon of the civil day before.
  const today = festivalOn(now);
  if (today && hour < SHABBAT_END_SATURDAY_HOUR) return today;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const eve = festivalOn(tomorrow);
  if (eve && hour >= SHABBAT_START_FRIDAY_HOUR) return `ערב ${eve}`;

  if (day === 6 && hour < SHABBAT_END_SATURDAY_HOUR) return "שבת";
  if (day === 5 && hour >= SHABBAT_START_FRIDAY_HOUR) return "שבת";
  if (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR) return "שעות לילה";
  return null;
}

function isQuiet(now = new Date()) {
  return holdReason(now) !== null;
}

// When the current quiet period ends - so the panel can say "held until Sunday
// morning" rather than only "held".
function nextOpening(now = new Date()) {
  const next = new Date(now);
  for (let i = 0; i < 24 * 4; i++) {
    next.setHours(next.getHours() + 1, 0, 0, 0);
    if (!isQuiet(next)) return next;
  }
  return next;
}

module.exports = {
  holdReason,
  festivalOn,
  isQuiet,
  nextOpening,
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
  SHABBAT_START_FRIDAY_HOUR,
  SHABBAT_END_SATURDAY_HOUR,
};
