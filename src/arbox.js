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

module.exports = { getLocations, getLeads, getReport, getTasks };
