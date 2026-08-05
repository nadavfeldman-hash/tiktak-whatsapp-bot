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

module.exports = {
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
