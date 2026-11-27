// 27/11/2026 - Arbox is gone. Nadav: "אין יותר ארבוקס... זה רק אנחנו".
//
// Every read the bot makes now comes from TIKTAK's own system (tiktak-league) and nothing else. Arbox
// rejected our API key from 24/11, and because the bot still read leads, members and reports from Arbox
// (and proved itself to our server with that same Arbox key) 11 automations failed silently for 3 days.
//
// The file keeps its name and its function names so the automations that call it don't change; what is
// behind every function is our system only. There is no Arbox fallback anywhere: a read that fails, fails,
// and the automation skips its round (and the failure is logged) rather than guessing.

const LEAGUE_URL = () => process.env.LEAGUE_URL || "https://tiktak-league.onrender.com";

// The bot proves itself to our server with the WhatsApp (360dialog) key - the same key our server keeps as
// secret_d360_key. The old x-api-key header stays for now so nothing breaks while both sides deploy.
function leagueHeaders(extra = {}) {
  return { "x-bot-key": process.env.D360_API_KEY || "", "x-api-key": process.env.ARBOX_API_KEY || "", ...extra };
}

async function ours(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${LEAGUE_URL()}${path}${q ? `?${q}` : ""}`, {
    headers: leagueHeaders(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TIKTAK ${path} ${res.status}`);
  return res.json();
}

const cut = (list, limit) => list.slice(0, Number(limit) || 200);

// Leads in our system (every Meta lead + the ones opened in the dashboard), newest first, without the
// lost/archived ones.
async function getLeads(params = {}) {
  const r = await ours("/api/hooks/leads");
  return { data: cut(r.data || [], params.limit) };
}

// Every lead including lost/archived, with the status Nadav set in our dashboard. user_id is "own-<id>" -
// the same key the bot has used for our leads since 12/11, so a lead it already knows is not "new".
async function allLeadsWithStatus() {
  const r = await ours("/api/hooks/leads", { all: "1" });
  return (r.data || []).map((l) => ({ ...l, user_id: `own-${l.id}`, allow_sms: l.allow_sms || "yes" }));
}

const isLost = (l) => /אבוד|ארכיון/.test(String(l.lead_status || ""));

async function getReport(reportName, params = {}) {
  switch (reportName) {
    case "leadsInProcessReport":
      return { data: (await allLeadsWithStatus()).filter((l) => !isLost(l)) };
    case "bookingCancellationReport":
      return ours("/api/hooks/cancellations", { fromDate: params.fromDate || "", toDate: params.toDate || "" });
    case "birthdayReport":
      return ours("/api/hooks/birthdays", { fromDate: params.fromDate || "", toDate: params.toDate || "" });
    case "debtReport":
      return ours("/api/hooks/debts");
    case "transactionsReport":
      return ours("/api/hooks/failed-payments", { fromDate: params.fromDate || "", toDate: params.toDate || "" });
    default:
      throw new Error(`no source for ${reportName} in TIKTAK's system`);
  }
}

// Tasks are read by checkDueTasks straight from /api/hooks/tasks; nothing else to add here.
async function getTasks() {
  return { data: [] };
}

// Our calendar names the coach only. Coach phones are not in our system yet, so coach notices that need a
// phone are skipped (and logged) until they are.
async function getStaffMembers() {
  return { data: [] };
}

function staffByName(name) {
  return name ? { name: String(name).trim() } : null;
}

async function getSchedule(params = {}) {
  const res = await ours("/api/hooks/schedule", { from_date: params.from_date || "", to_date: params.to_date || "" });
  for (const session of res.data || []) {
    if (session.staff_member && !session.staff_member.user_id) session.staff_member = staffByName(session.staff_member.name);
  }
  return res;
}

const arboxSchedule = getSchedule;

async function updateScheduleStaff() {
  throw new Error("coach swaps are done in TIKTAK's dashboard (/api/hooks/class-coach)");
}

async function getAllLostLeads() {
  return (await allLeadsWithStatus()).filter(isLost);
}

async function getAllConvertedLeads() {
  return [];
}
const getConvertedLeads = async () => ({ data: [] });
const getLostLeads = async () => ({ data: await getAllLostLeads() });

async function getUser() {
  throw new Error("no per-user lookup - our rows already carry the phone");
}

async function getAllActiveMembers() {
  return (await ours("/api/hooks/members")).data || [];
}

async function getLocations() {
  return { data: [] };
}

// Who is this WhatsApp number? Leads first (a stranger writing in is usually a lead), then active members.
async function findContactByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const matches = (p) => String(p || "").replace(/\D/g, "").endsWith(digits.slice(-9));
  try {
    const lead = ((await getLeads({ limit: 500 })).data || []).find((l) => matches(l.phone));
    if (lead) return { name: lead.first_name, gender: lead.gender, source: "lead", status: lead.lead_status };
  } catch {}
  try {
    const member = (await getAllActiveMembers()).find((m) => matches(m.phone));
    if (member) return { name: member.first_name || member.full_name, gender: member.gender, source: "member" };
  } catch {}
  return null;
}

module.exports = {
  leagueHeaders,
  LEAGUE_URL,
  ownLeads: () => ours("/api/hooks/leads"),
  allLeadsWithStatus,
  findContactByPhone,
  getLocations,
  getLeads,
  getReport,
  getTasks,
  getStaffMembers,
  getSchedule,
  arboxSchedule,
  updateScheduleStaff,
  getConvertedLeads,
  getLostLeads,
  getAllConvertedLeads,
  getAllLostLeads,
  getUser,
  getAllActiveMembers,
};
