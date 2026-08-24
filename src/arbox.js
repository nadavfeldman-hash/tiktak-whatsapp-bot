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

function getReport(reportName, params = {}) {
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

function getSchedule(params = {}) {
  const query = new URLSearchParams(params).toString();
  return arboxRequest(`/v3/schedule${query ? `?${query}` : ""}`);
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
  updateScheduleStaff,
  getConvertedLeads,
  getLostLeads,
  getUser,
  getAllActiveMembers,
};
