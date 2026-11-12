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

// 29/10: leads live in TIKTAK's own system too (every Meta lead). Once the owner moves leads off Arbox
// (TIKTAK's cutover step "leads_own"), they are read only from there; until then from Arbox plus every
// TIKTAK lead Arbox doesn't have (matched by phone, so nobody is welcomed twice).
async function getLeads(params = {}) {
  let mine = null;
  try { mine = await ours("/api/hooks/leads", {}); } catch {}
  const cut = (list) => ({ data: list.slice(0, Number(params.limit) || 200) });
  if (mine && mine.own) return cut(mine.data || []);
  const query = new URLSearchParams(params).toString();
  let theirs;
  try {
    theirs = await arboxRequest(`/v3/leads${query ? `?${query}` : ""}`);
  } catch (e) {
    if (mine && (mine.data || []).length) return cut(mine.data);
    throw e;
  }
  // 8/11: Meta leads stopped reaching Arbox (שירונה, 17:03) and live only in TIKTAK's system, so reading
  // Arbox alone meant a new lead got no welcome at all. Add every TIKTAK lead Arbox doesn't have - same
  // phone counts once (Arbox's copy kept), so nobody is welcomed twice.
  const key = (p) => String(p || "").replace(/\D/g, "").slice(-9);
  const known = new Set((theirs.data || []).map((l) => key(l.phone)).filter(Boolean));
  const extra = ((mine && mine.data) || []).filter((l) => key(l.phone) && !known.has(key(l.phone)));
  if (!extra.length) return theirs;
  const at = (l) => new Date(l.created_time || 0).getTime() || 0;
  return { ...theirs, data: cut([...(theirs.data || []), ...extra].sort((a, b) => at(b) - at(a))).data };
}

// Since the switch (24/10/2026) bookings, cancellations and the calendar live in TIKTAK's own system, not in
// Arbox - Arbox's copy of them stopped. Those reads go to TIKTAK for every day from the switch on, and to Arbox
// only for the days before it. When TIKTAK cannot be reached the read fails, so an automation skips its round
// rather than mistaking an empty Arbox calendar for "nobody came".
const LEAGUE_URL = () => process.env.LEAGUE_URL || "https://tiktak-league.onrender.com";

const ours_ = (path, params) => ours(path, params);
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
  // 29/10: debts and declined charges of the payments TIKTAK charges itself, added to Arbox's (no member is in
  // both). Once Arbox is closed, or doesn't answer, TIKTAK's alone.
  // Birthdays: Arbox's plus TIKTAK's (same phone once); TIKTAK's alone when Arbox doesn't answer.
  if (reportName === "birthdayReport") return withOurs("/api/hooks/birthdays", { fromDate: params.fromDate || "", toDate: params.toDate || "" }, () => arboxReport(reportName, params), true);
  if (reportName === "debtReport") return withOurs("/api/hooks/debts", {}, () => arboxReport(reportName, params));
  if (reportName === "transactionsReport") return withOurs("/api/hooks/failed-payments", { fromDate: params.fromDate || "", toDate: params.toDate || "" }, () => arboxReport(reportName, params));
  return arboxReport(reportName, params);
}

async function withOurs(path, params, arboxRead, samePhoneOnce = false) {
  let mine = [];
  try { mine = (await ours(path, params)).data || []; } catch {}
  try {
    const r = await arboxRead();
    const tail = (p) => String(p || "").replace(/\D/g, "").slice(-9);
    const seen = new Set((r.data || []).map((x) => tail(x.phone)));
    return { ...r, data: [...(r.data || []), ...mine.filter((x) => !samePhoneOnce || !seen.has(tail(x.phone)))] };
  } catch (e) {
    if (mine.length) return { data: mine };
    throw e;
  }
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

// Arbox's active members, plus the ones who joined on TIKTAK's own site (Arbox never hears of them). If Arbox
// doesn't answer (or once it is closed), TIKTAK's own copy of the whole list is used instead.
async function getAllActiveMembers() {
  let ours = null;
  try { ours = (await ours_("/api/hooks/members", {})).data || []; } catch {}
  let members = [];
  try {
    let page = 1;
    while (true) {
      const result = await arboxReport("activeMembersReport", { limit: 200, page });
      members = members.concat(result.data || []);
      if (!result.extra?.pagination?.next_page_url) break;
      page++;
    }
  } catch (e) {
    if (ours && ours.length) return ours;
    throw e;
  }
  const tail = (p) => String(p || "").replace(/\D/g, "").slice(-9);
  const have = new Set(members.map((m) => tail(m.phone)));
  for (const m of ours || []) if (m.own && !have.has(tail(m.phone))) members.push(m);
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
  // 12/11: every lead in TIKTAK's own system with its current status (src/server.js /api/hooks/leads)
  ownLeads: () => ours("/api/hooks/leads", {}),
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
