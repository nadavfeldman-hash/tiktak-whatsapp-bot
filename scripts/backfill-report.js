// What would the automations have done over the last 30 days?
//
// Written to answer one question with numbers rather than assurances: if this
// had been running all month, how many people would it have written to, who,
// and about what. Nothing here can send. The WhatsApp module is never loaded -
// there is no code path from this file to a phone, by construction rather than
// by a flag someone could get wrong.
//
// It reads Arbox and applies the same thresholds the live checks apply. It is a
// report, not the live code path, so treat the counts as the shape of the
// month's volume rather than a promise of exactly which messages would appear.

require("dotenv").config();
const arbox = require("../src/arbox");

const DAYS = 30;
const ABSENCE_STAGES = [4, 8, 14];
const ABSENCE_MAX_DAYS = 30;
const STREAK_MILESTONES = [10, 25, 50, 100];
const NEW_MEMBER_CHECKIN_MILESTONES = [14, 28];

const now = new Date();
const fmt = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
};
const parse = (v) => {
  if (!v) return null;
  const d = new Date(String(v).replace(" ", "T"));
  return isNaN(d) ? null : d;
};
const within = (v, n = DAYS) => {
  const d = parse(v);
  return d && (now - d) / 86400000 <= n;
};
const fullName = (o) =>
  [o.first_name, o.last_name].filter(Boolean).join(" ") || o.full_name || "(ללא שם)";

const results = [];
function report(automation, people, note = "") {
  results.push({ automation, people, note });
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    report(label, [], `לא ניתן לבדוק: ${e.message.slice(0, 70)}`);
    return null;
  }
}

(async () => {
  console.log(`בדיקה יבשה: מה האוטומציות היו עושות ב-${DAYS} הימים האחרונים`);
  console.log(`מ-${fmt(daysAgo(DAYS))} עד ${fmt(now)}\n`);
  console.log("שום הודעה לא נשלחת. הסקריפט הזה לא טוען בכלל את מודול השליחה.\n");

  // --- new leads ---------------------------------------------------------
  await safe("ליד חדש", async () => {
    const leads = (await arbox.getLeads({ limit: 200 })).data || [];
    const fresh = leads.filter((l) => within(l.created_time) && l.phone);
    report("ליד חדש", fresh.map((l) => ({ name: fullName(l), phone: l.phone, when: fmt(parse(l.created_time)) })));
  });

  // --- converted / lost --------------------------------------------------
  await safe("מצטרף חדש", async () => {
    const conv = await arbox.getAllConvertedLeads();
    // These lists carry no conversion date, so the month cannot be isolated.
    // Reported as a total with that stated, rather than guessed at.
    report("מצטרף חדש", [], `${conv.length} לידים שהומרו בסה"כ בארבוקס - אין תאריך המרה בנתונים, אז אי אפשר לבודד את החודש. בפועל היו נשלחות רק המרות חדשות מרגע ההדלקה.`);
  });

  await safe("ליד אבוד", async () => {
    const lost = await arbox.getAllLostLeads();
    report("ליד אבוד", [], `${lost.length} לידים אבודים בסה"כ בארבוקס - גם כאן אין תאריך, אז רק סגירות חדשות היו נשלחות.`);
  });

  // --- absences ----------------------------------------------------------
  await safe("נעדר מהאימונים", async () => {
    const result = await arbox.getReport("absenceReport", {
      fromDate: fmt(daysAgo(DAYS)),
      toDate: fmt(now),
      limit: 300,
    });
    const rows = result.data || [];
    const people = [];
    for (const r of rows) {
      const last = parse(r.last_seen || r.last_attendance || r.date);
      if (!last || !r.phone) continue;
      const gap = Math.floor((now - last) / 86400000);
      if (gap > ABSENCE_MAX_DAYS) continue;
      const stage = ABSENCE_STAGES.filter((s) => gap >= s).length;
      if (stage === 0) continue;
      people.push({ name: fullName(r), phone: r.phone, when: `${gap} ימים`, extra: `שלב ${stage}` });
    }
    report("נעדר מהאימונים", people, "אחרי 4 / 8 / 14 ימים, הודעה אחת לכל שלב");
  });

  // --- birthdays ---------------------------------------------------------
  await safe("יום הולדת", async () => {
    const members = await arbox.getAllActiveMembers();
    const people = [];
    for (const m of members) {
      const b = parse(m.birthday || m.birth_date);
      if (!b || !m.phone) continue;
      for (let i = 0; i < DAYS; i++) {
        const d = daysAgo(i);
        if (b.getMonth() === d.getMonth() && b.getDate() === d.getDate()) {
          people.push({ name: fullName(m), phone: m.phone, when: fmt(d) });
          break;
        }
      }
    }
    report("יום הולדת", people);
  });

  // --- new member check-ins ---------------------------------------------
  await safe("צ'ק-אין מצטרף חדש", async () => {
    const members = await arbox.getAllActiveMembers();
    const people = [];
    for (const m of members) {
      const joined = parse(m.start_date || m.created_at || m.join_date);
      if (!joined || !m.phone) continue;
      const age = Math.floor((now - joined) / 86400000);
      for (const milestone of NEW_MEMBER_CHECKIN_MILESTONES) {
        if (age >= milestone && age < milestone + DAYS && age - milestone < DAYS) {
          people.push({ name: fullName(m), phone: m.phone, when: `יום ${milestone}` });
          break;
        }
      }
    }
    report("צ'ק-אין מצטרף חדש", people, "ביום ה-14 וביום ה-28 מההצטרפות");
  });

  // --- late cancellations ------------------------------------------------
  await safe("ביטול מאוחר", async () => {
    // Arbox caps this report at about a month; ask in weekly slices so the
    // whole period is covered rather than silently truncated.
    const all = [];
    for (let i = 0; i < DAYS; i += 7) {
      const res = await arbox.getReport("bookingCancellationReport", {
        fromDate: fmt(daysAgo(Math.min(i + 7, DAYS))),
        toDate: fmt(daysAgo(i)),
        limit: 200,
        group_by: "user",
      });
      all.push(...(res.data || []));
    }
    const byUser = all.filter((c) => c.cancelled_by === "user" && c.phone);
    report(
      "ביטול מאוחר",
      byUser.map((c) => ({ name: fullName(c), phone: c.phone, when: c.date })),
      "רק ביטולים של המתאמן עצמו, ורק אם לא נרשם לאימון אחר באותו יום - כאן לא נבדקה ההרשמה מחדש, אז המספר האמיתי נמוך יותר"
    );
  });

  // --- streaks -----------------------------------------------------------
  await safe("רצף אימונים", async () => {
    report(
      "רצף אימונים",
      [],
      `נספר שבוע-שבוע מרגע ההדלקה (ציוני דרך ${STREAK_MILESTONES.join(", ")}). אי אפשר לשחזר רצפים אחורה כי הספירה מתחילה מאפס - בחודש הראשון לא היה יוצא כמעט כלום.`
    );
  });

  // --- output ------------------------------------------------------------
  console.log("=".repeat(58));
  let total = 0;
  for (const r of results) {
    console.log(`\n### ${r.automation}: ${r.people.length}`);
    if (r.note) console.log(`    ${r.note}`);
    total += r.people.length;
    for (const p of r.people.slice(0, 40)) {
      const bits = [p.name, p.when, p.extra].filter(Boolean).join("  ·  ");
      console.log(`    ${bits}`);
    }
    if (r.people.length > 40) console.log(`    ... ועוד ${r.people.length - 40}`);
  }
  console.log("\n" + "=".repeat(58));
  console.log(`סה"כ הודעות שהיו מוצעות בחודש: ${total}`);
  console.log(`ממוצע ליום: ${(total / DAYS).toFixed(1)}`);
  console.log("\nלא נשלחה שום הודעה.");
})();
