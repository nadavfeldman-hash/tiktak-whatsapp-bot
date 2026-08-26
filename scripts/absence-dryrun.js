// Who has actually stopped coming, and for how long.
//
// The old source for this was Arbox's absenceReport, which turns out to list
// only people absent 31 days or more - while the automation looks for 4 to 30.
// The two ranges do not overlap at any point, so the four- and eight-day
// follow-ups Nadav asked for could never fire, and never did.
//
// This works it out from attendance instead: every session in the last 35 days,
// every person who actually checked in (checked_in, not merely booked - booking
// and turning up are different things, and only one of them means somebody is
// still training), and the most recent day each of them appeared.
//
// Anyone already booked into a future session is not absent; they have a plan.
// Messaging them "we miss you" while they hold a ticket for tomorrow is the kind
// of mistake that makes the whole thing look automated.
//
// Sends nothing. Does not load the WhatsApp module.

require("dotenv").config();
const arbox = require("../src/arbox");

const STAGES = [
  { days: 4, label: "שלב 1 - 4 ימים" },
  { days: 8, label: "שלב 2 - 8 ימים" },
  { days: 14, label: "שלב 3 - שבועיים" },
];
const MAX_DAYS = 30;
const LOOKBACK_DAYS = 35;
const FUTURE_DAYS = 14;

const fmt = (d) => d.toISOString().slice(0, 10);
const shift = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

// The schedule endpoint pages, and a month here is a few thousand sessions - so
// walk every page rather than taking whatever the first one happens to hold.
async function sessionsBetween(from, to) {
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

(async () => {
  console.log(`בודק מי נעדר, לפי נוכחות אמיתית ב-${LOOKBACK_DAYS} הימים האחרונים\n`);

  // Weekly slices: one 35-day request tends to be refused or truncated.
  const past = [];
  for (let i = LOOKBACK_DAYS; i > 0; i -= 7) {
    past.push(...(await sessionsBetween(fmt(shift(-i)), fmt(shift(-Math.max(i - 7, 0))))));
  }
  const future = await sessionsBetween(fmt(shift(1)), fmt(shift(FUTURE_DAYS)));

  const lastSeen = new Map();
  const person = new Map();
  let checkins = 0;
  for (const s of past) {
    for (const r of s.registration_Details || []) {
      if (r.checked_in !== 1) continue;
      checkins++;
      const id = String(r.user_id);
      person.set(id, { name: r.full_name, phone: r.phone, membership: r.membership_type });
      if (!lastSeen.has(id) || s.date > lastSeen.get(id)) lastSeen.set(id, s.date);
    }
  }

  const booked = new Set();
  for (const s of future) {
    for (const r of s.registration_Details || []) booked.add(String(r.user_id));
  }

  console.log(`אימונים שנבדקו: ${past.length}`);
  console.log(`כניסות בפועל (check-in): ${checkins}`);
  console.log(`מתאמנים שונים שהגיעו: ${lastSeen.size}`);
  console.log(`רשומים כבר לאימון עתידי (לא נחשבים נעדרים): ${booked.size}\n`);

  const today = new Date(fmt(new Date()));
  const buckets = STAGES.map(() => []);
  let active = 0;
  let gone = 0;
  let hasPlan = 0;

  for (const [id, date] of lastSeen) {
    const gap = Math.round((today - new Date(date)) / 86400000);
    if (gap < STAGES[0].days) {
      active++;
      continue;
    }
    if (gap > MAX_DAYS) {
      gone++;
      continue;
    }
    if (booked.has(id)) {
      hasPlan++;
      continue;
    }
    let stage = -1;
    STAGES.forEach((s, i) => {
      if (gap >= s.days) stage = i;
    });
    buckets[stage].push({ ...person.get(id), gap, date });
  }

  console.log(`מתאמנים פעילים (הגיעו ב-3 הימים האחרונים): ${active}`);
  console.log(`נעדרים מעל ${MAX_DAYS} יום - עזבו, לא נוגעים: ${gone}`);
  console.log(`נעדרים אבל כבר רשומים קדימה - מדלגים: ${hasPlan}\n`);
  console.log("=".repeat(56));

  let total = 0;
  STAGES.forEach((s, i) => {
    const list = buckets[i].sort((a, b) => a.gap - b.gap);
    total += list.length;
    console.log(`\n### ${s.label}: ${list.length} אנשים`);
    list.forEach((p) => console.log(`    ${p.name}  ·  ${p.gap} ימים  ·  ${p.phone || "אין טלפון"}`));
  });

  console.log("\n" + "=".repeat(56));
  console.log(`סה"כ היו מקבלים הודעה עכשיו: ${total}`);
  console.log("\nלא נשלחה שום הודעה.");
})();
