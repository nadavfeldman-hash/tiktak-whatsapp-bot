const BASE_URL = "https://arboxserver.arboxapp.com/api/public";

async function arboxRequest(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "api-key": process.env.ARBOX_API_KEY,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Arbox API error ${res.status}: ${body}`);
  }
  return res.json();
}

function getLocations() {
  return arboxRequest("/v3/locations");
}

function getLeads(params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/leads${query ? `?${query}` : ""}`);
}

// Since the switch (24/10/2026) bookings, cancellations and the calendar live in TIKTAK's own system, not in
// Arbox - Arbox's copy of them stopped. Those reads go to TIKTAK for every day from the switch on, and to Arbox
// only for the days before it. When TIKTAK cannot be reached the read fails, so an automation skips its round
// rather than mistaking an empty Arbox calendar for "nobody came".
const LEAGUE_URL = () => process.env.LEAGUE_URL || "https://tiktak-league.onrender.com";

async function ours(path, params) {
  const res = await fetch(`${LEAGUE_URL()}${path}?${new URLSearchParams(params)}`, {
    headers: { "x-api-key": process.env.ARBOX_API_KEY },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TIKTAK ${path} ${res.status}`);
  return res.json();
}

const dayBefore = (d) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};

// Our calendar names the coach only; the bot needs their phone and Arbox id (coach notices, replacements).
let staffCache = { at: 0, list: [] };
async function staffByName(name) {
  if (!name) return null;
  if (Date.now() - staffCache.at > 60 * 60 * 1000) {
    try {
      staffCache = { at: Date.now(), list: (await getStaffMembers()).data || [] };
    } catch {}
  }
  const full = (s) => [s.first_name, s.last_name].filter(Boolean).join(" ").trim();
  const n = String(name).trim();
  const hit = staffCache.list.find((s) => full(s) === n) ||
    (() => {
      const same = staffCache.list.filter((s) => String(s.first_name || "").trim() === n.split(" ")[0]);
      return same.length === 1 ? same[0] : null;
    })();
  return hit ? { name: n, user_id: hit.user_id, phone: hit.phone || null } : { name: n };
}

// Days from `since` on come from TIKTAK; earlier days from Arbox. `split` gets the Arbox reader for a clipped range.
async function merged(oursPath, params, fromKey, toKey, arboxRead) {
  const from = params[fromKey], to = params[toKey];
  const mine = await ours(oursPath, { [fromKey]: from || "", [toKey]: to || "" });
  if (!mine.own || !mine.since) return arboxRead(params);
  const page = Number(params.page || 1);
  const before = from && from < mine.since ? await arboxRead({ ...params, [toKey]: to && to < mine.since ? to : dayBefore(mine.since) }) : null;
  const theirs = before ? before.data || [] : [];
  const keep = (r) => !r.date || r.date >= mine.since || (r.cancelled_time && r.cancelled_time.slice(0, 10) >= mine.since);
  const fresh = page === 1 ? (mine.data || []).filter(keep) : [];
  return { ...(before || {}), data: [...theirs, ...fresh], extra: before ? before.extra : {} };
}

function getReport(reportName, params = {}) {
  if (reportName === "bookingCancellationReport") {
    return merged("/api/hooks/cancellations", params, "fromDate", "toDate", (p) => arboxReport(reportName, p));
  }
  return arboxReport(reportName, params);
}

function arboxReport(reportName, params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/reports/${reportName}${query ? `?${query}` : ""}`);
}

function getTasks(params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/tasks${query ? `?${query}` : ""}`);
}

function getStaffMembers() {
  return arboxRequest("/v3/users/allStaffMembers");
}

function arboxSchedule(params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/schedule${query ? `?${query}` : ""}`);
}

async function getSchedule(params = {}) {
  const res = await merged("/api/hooks/schedule", params, "from_date", "to_date", arboxSchedule);
  for (const session of res.data || []) {
    if (session.staff_member && !session.staff_member.user_id) session.staff_member = await staffByName(session.staff_member.name);
  }
  return res;
}

function updateScheduleStaff(scheduleId, staffMemberId) {
  return arboxRequest("/v3/schedule", {
    method: "PATCH",
    body: JSON.stringify({ schedule_id: scheduleId, staff_member_id: staffMemberId }),
  });
}

function getConvertedLeads(params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/leads/converted${query ? `?${query}` : ""}`);
}

function getLostLeads(params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/leads/lost${query ? `?${query}` : ""}`);
}

// Both of these lists are returned oldest-first, and the endpoints ignore every
// sort parameter we tried - so asking for the first 50 gets the 50 oldest, and
// somebody marked lost or converted today sits on the last page, invisible.
// That is why marking a lead lost appeared to do nothing. Walk every page.
async function fetchAllPages(fetchPage) {
  let all = [];
  let page = 1;
  while (page <= 20) {
    const result = await fetchPage({ limit: 200, page });
    all = all.concat(result.data || []);
    if (!result.extra?.pagination?.next_page_url) break;
    page++;
  }
  return all;
}

function getAllConvertedLeads() {
  return fetchAllPages(getConvertedLeads);
}

function getAllLostLeads() {
  return fetchAllPages(getLostLeads);
}

function getUser(userId) {
  return arboxRequest(`/v3/users/${userId}`);
}

async function getAllActiveMembers() {
  let members = [];
  let page = 1;
  while (true) {
    const result = await getReport("activeMembersReport", { limit: 200, page });
    members = members.concat(result.data || []);
    if (!result.extra?.pagination?.next_page_url) break;
    page++;
  }
  return members;
}

// Who is this WhatsApp number? Checked against leads first (a stranger writing
// in is usually a lead) and then active members. The whole directory is small
// enough that this is cheap, and the result is cached by the caller.
async function findContactByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const matches = (p) => String(p || "").replace(/\D/g, "").endsWith(digits.slice(-9));

  try {
    const leads = (await getLeads({ limit: 200 })).data || [];
    const lead = leads.find((l) => matches(l.phone));
    if (lead) {
      return { name: lead.first_name, gender: lead.gender, source: "lead", status: lead.lead_status };
    }
  } catch {
    // fall through to members
  }

  try {
    const member = (await getAllActiveMembers()).find((m) => matches(m.phone));
    if (member) {
      return { name: member.first_name || member.full_name, gender: member.gender, source: "member" };
    }
  } catch {
    // unknown caller - the bot will simply write neutrally
  }
  return null;
}

module.exports = {
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
