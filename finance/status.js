// One command that answers "where do I stand this month".
// Runs anywhere - no local files, no absolute paths. Needs ARBOX_API_KEY,
// MORNING_KEY_ID and MORNING_SECRET in the environment.
//
//   node finance/status.js            - current month
//   node finance/status.js 2026-08    - any month

const arbox = require("../src/arbox");
const GI = "https://api.greeninvoice.co.il/api/v1";

const M = process.argv[2] || new Date().toISOString().slice(0, 7);
const [Y, MM] = M.split("-").map(Number);
const lastDay = new Date(Date.UTC(Y, MM, 0)).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const upto = today < lastDay ? today : lastDay;
const dayNo = Number(upto.slice(8));
const daysInMonth = Number(lastDay.slice(8));

const RATE = { "שירה כהן": 100, "לירן שם טוב": 100, "חן גביזון": 120, "דניאל": 80, "הוד ציון": 100 };
const LOAN = 3000;                       // repaid straight from the bank, never invoiced
const nf = n => Math.round(n).toLocaleString("he-IL");
const mins = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

const CAT = [
  [/קאר סנטר|car center/i, "שכר דירה"], [/meta|פייסבוק|facebook/i, "פרסום"],
  [/שירה כהן|הוד ציון|לירן שם טוב|חן גביזון|נעה דובדבני|עדן סלומון|מעיין חמו|נוגה|נגה הנסב|noga hansv|דניאל/i, "מאמנים"],
  [/עיריית|ארנונה/, "ארנונה"], [/חשמל/, "חשמל"], [/בזק|סלקום|סלולר|מדיה סטלייט/, "תקשורת"],
  [/גז|פטרול|אנרגיה/, "גז"],
  [/cloudfit|anthropic|skywork|render|heygen|360dialog|grammarly|runway|topview|ארבוקס|חשבונית ירוקה|פינטרה/i, "תוכנה"],
  [/פלאקארד|יופיגי|pelecard/i, "סליקה"],
  [/דש חשבונאות|עו"ד|ביזנס ל|תכנון עסקי|פלג|ניקיטה/i, "מקצועי"],
  [/reelax|רילקס|dream chase|מעיין השלטים|עיתון|מפה לאוזן|lsv|studiolaunch|טודוס/i, "שיווק"],
  [/ברקו סנטס/, "בישום"],
];
const cat = n => (CAT.find(([re]) => re.test(n)) || [null, "אחר"])[1];

async function txns(from, to) {
  let out = [];
  for (let p = 1; p <= 12; p++) {
    const r = await arbox.getReport("transactionsReport", { fromDate: from, toDate: to, limit: 200, page: p });
    const d = (r.result && r.result.data) || r.data || [];
    out = out.concat(d);
    if (d.length < 200) break;
  }
  return out;
}

async function morningExpenses(from, to) {
  const t = (await (await fetch("https://api.morning.co/idp/v1/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.MORNING_KEY_ID, client_secret: process.env.MORNING_SECRET,
    }),
  })).json()).accessToken;
  const H = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  let out = [];
  for (let p = 1; p <= 8; p++) {
    const d = await (await fetch(`${GI}/expenses/search`, {
      method: "POST", headers: H, body: JSON.stringify({ page: p, pageSize: 100, fromDate: from, toDate: to }),
    })).json();
    const it = d.items || []; out = out.concat(it);
    if (it.length < 100) break;
  }
  return out;
}

// merge a coach's classes into continuous shifts - classes start every 10 minutes
function shiftHours(rows) {
  const byCoach = {};
  for (const s of rows) {
    const n = ((s.staff_member && s.staff_member.name) || "").trim();
    if (!n || !s.start_time || !s.end_time) continue;
    byCoach[n] = byCoach[n] || {};
    (byCoach[n][s.date] = byCoach[n][s.date] || []).push([mins(s.start_time), mins(s.end_time)]);
  }
  const out = {};
  for (const [n, days] of Object.entries(byCoach)) {
    let total = 0;
    for (const iv of Object.values(days)) {
      iv.sort((a, b) => a[0] - b[0]);
      let [cs, ce] = iv[0], sum = 0;
      for (let i = 1; i < iv.length; i++) {
        if (iv[i][0] <= ce + 15) ce = Math.max(ce, iv[i][1]);
        else { sum += ce - cs; [cs, ce] = iv[i]; }
      }
      total += (sum + ce - cs) / 60;
    }
    out[n] = Math.round(total * 10) / 10;
  }
  return out;
}

(async () => {
  for (const k of ["ARBOX_API_KEY", "MORNING_KEY_ID", "MORNING_SECRET"]) {
    if (!process.env[k]) { console.error(`חסר משתנה סביבה: ${k}`); process.exit(1); }
  }

  // ---- revenue
  const T = await txns(`${M}-01`, lastDay);
  const ok = T.filter(x => x.status === "SUCCESS");
  const fail = T.filter(x => x.status === "FAIL");
  const revenue = ok.reduce((s, x) => s + Number(x.amount || 0), 0);
  const payers = new Set(ok.map(x => x.user_id));
  const failUsers = new Set(fail.map(x => x.user_id));
  const stillOwing = [...failUsers].filter(u => !payers.has(u));
  const owed = fail.filter(x => stillOwing.includes(x.user_id)).reduce((s, x) => s + Number(x.amount || 0), 0);

  // ---- what the memberships say the month should bring
  let mem = [];
  for (let p = 1; p <= 20; p++) {
    const r = await arbox.getReport("activeMembershipsReport", { limit: 200, page: p });
    const d = (r.result && r.result.data) || r.data || [];
    mem = mem.concat(d);
    if (d.length < 200) break;
  }
  const num = v => { const n = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : 0; };
  const live = mem.filter(x => num(x.open_charges) > 0 && num(x.price) > 0);
  const expected = live.reduce((s, x) => s + num(x.price), 0);

  // ---- expenses on file
  const E = await morningExpenses(`${M}-01`, lastDay);
  const byCat = {};
  for (const e of E) {
    const n = ((e.supplier && e.supplier.name) || "?").trim();
    const ils = Number(e.amount || 0) * (e.currency === "ILS" ? 1 : Number(e.currencyRate || 1));
    byCat[cat(n)] = (byCat[cat(n)] || 0) + ils;
  }
  const spend = Object.values(byCat).reduce((s, v) => s + v, 0);
  const inVat = E.reduce((s, e) => s + Number(e.vat || 0) * (e.currency === "ILS" ? 1 : Number(e.currencyRate || 1)), 0);

  // ---- coach hours for the whole month, scheduled shifts included
  let sched = [];
  for (let p = 1; p <= 40; p++) {
    const r = await arbox.getSchedule({ from_date: `${M}-01`, to_date: lastDay, limit: 200, page: p });
    const d = (r.result && r.result.data) || r.data || [];
    sched = sched.concat(d);
    if (d.length < 200) break;
  }
  sched = [...new Map(sched.map(x => [x.schedule_id, x])).values()];
  const H = shiftHours(sched);
  const coaches = Object.entries(H).filter(([n]) => RATE[n])
    .map(([n, h]) => ({ n, h, pay: Math.round(h * RATE[n]) }))
    .sort((a, b) => b.pay - a.pay);
  const wages = coaches.reduce((s, c) => s + c.pay, 0);
  const nadav = Object.entries(H).find(([n]) => /נדב/.test(n));

  const outVat = expected * 18 / 118;
  const vatDue = outVat - inVat;

  console.log(`\n===== טיק טאק · ${M} · נכון ל-${today} (יום ${dayNo}/${daysInMonth}) =====\n`);
  console.log(`נגבה עד עכשיו      ${nf(revenue)} ₪  מ-${payers.size} משלמים`);
  console.log(`צפוי לחודש מלא     ${nf(expected)} ₪  (${live.length} מנויים פעילים, ממוצע ${nf(expected / live.length)} ₪)`);
  console.log(`חיובים שנכשלו      ${fail.length} | ${nf(fail.reduce((s, x) => s + Number(x.amount || 0), 0))} ₪`);
  console.log(`לא שילמו בכלל      ${stillOwing.length} מתאמנים | ${nf(owed)} ₪`);

  console.log(`\n--- הוצאות שנקלטו (${E.length} מסמכים) ---`);
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k.padEnd(12)} ${nf(v).padStart(8)} ₪`);
  console.log(`  ${"סה\"כ".padEnd(12)} ${nf(spend).padStart(8)} ₪   (מע"מ תשומות ${nf(inVat)})`);

  console.log(`\n--- שעות מאמנים (כולל משמרות מתוכננות) ---`);
  coaches.forEach(c => console.log(`  ${c.n.padEnd(14)} ${String(c.h).padStart(6)} ש'  ${nf(c.pay).padStart(7)} ₪`));
  console.log(`  ${"שכר לחודש".padEnd(14)} ${" ".repeat(9)}${nf(wages).padStart(7)} ₪`);
  if (nadav) console.log(`  נדב: ${nadav[1]} שעות (לא משולם)`);

  const full = upto === lastDay;
  console.log(`\n--- שורה תחתונה ---`);
  console.log(`  הכנסה צפויה       ${nf(expected).padStart(8)} ₪`);
  console.log(`  מע"מ עסקאות       ${nf(outVat).padStart(8)} ₪`);
  console.log(`  מע"מ תשומות ${full ? "      " : " עד כה"} ${nf(inVat).padStart(8)} ₪${full ? "" : "   (חלקי - עוד חשבוניות בדרך)"}`);
  if (full) console.log(`  מע"מ למדינה       ${nf(vatDue).padStart(8)} ₪`);
  console.log(`  החזר הלוואה       ${nf(LOAN).padStart(8)} ₪  (אין חשבונית, נספר ידנית)`);
  console.log(`\n  הוצאות שנקלטו עד כה ${nf(spend)} ₪ — רוב החשבונות מגיעים בסוף החודש.`);
  console.log(`  להערכה מלאה הרץ בסוף החודש, או השווה מול החודש הקודם:`);
  console.log(`    node finance/status.js ${M === new Date().toISOString().slice(0, 7) ? new Date(Date.UTC(Y, MM - 2, 1)).toISOString().slice(0, 7) : M}\n`);
})();
