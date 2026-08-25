const fs = require("fs");
const path = require("path");

// Where state lives, in order of preference: an explicit DATA_DIR, then the
// persistent disk Render mounts at /var/data, then the working directory.
//
// This ordering is not a nicety. render.yaml declares that disk, but DATA_DIR
// was never set in the Render dashboard, so everything was being written inside
// the container - and a container's filesystem is discarded on every deploy.
// Each deploy therefore wiped the bot's entire memory: who had been messaged,
// who had been handled, which leads were already known. The automations then
// saw every member and lead as brand new and messaged them again. Every fix
// pushed caused a deploy, which caused another wipe, which caused another round
// of messages - one customer received four. Falling back to the mounted disk
// when it exists makes the memory survive deploys without depending on a
// dashboard setting anyone has to remember.
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const renderDisk = "/var/data";
  try {
    if (fs.existsSync(renderDisk)) return renderDisk;
  } catch {
    // not on Render, or no permission - fall through to the local directory
  }
  return path.join(__dirname, "..", "data");
}

const DATA_DIR = resolveDataDir();
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const APPOINTMENTS_FILE = path.join(DATA_DIR, "appointments.json");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const ADMIN_NOTES_FILE = path.join(DATA_DIR, "admin-notes.json");
const ARBOX_STATE_FILE = path.join(DATA_DIR, "arbox-state.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function ensureFile(file, defaultValue) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
}

function readJson(file, defaultValue) {
  ensureFile(file, defaultValue);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getConversation(phone) {
  const conversations = readJson(CONVERSATIONS_FILE, {});
  return conversations[phone] || [];
}

function saveConversation(phone, messages) {
  const conversations = readJson(CONVERSATIONS_FILE, {});
  conversations[phone] = messages;
  writeJson(CONVERSATIONS_FILE, conversations);
}

function resetConversation(phone) {
  const conversations = readJson(CONVERSATIONS_FILE, {});
  delete conversations[phone];
  writeJson(CONVERSATIONS_FILE, conversations);
}

function addAppointment(record) {
  const appointments = readJson(APPOINTMENTS_FILE, []);
  const entry = { id: appointments.length + 1, createdAt: new Date().toISOString(), ...record };
  appointments.push(entry);
  writeJson(APPOINTMENTS_FILE, appointments);
  return entry;
}

function addTicket(record) {
  const tickets = readJson(TICKETS_FILE, []);
  const entry = { id: tickets.length + 1, createdAt: new Date().toISOString(), status: "open", ...record };
  tickets.push(entry);
  writeJson(TICKETS_FILE, tickets);
  return entry;
}

function getAdminNotes() {
  return readJson(ADMIN_NOTES_FILE, []);
}

function addAdminNote(text) {
  const notes = readJson(ADMIN_NOTES_FILE, []);
  const entry = { text, addedAt: new Date().toISOString() };
  notes.push(entry);
  writeJson(ADMIN_NOTES_FILE, notes);
  return entry;
}

function getArboxState() {
  return readJson(ARBOX_STATE_FILE, { lastLeadCheckTime: null });
}

// Every automation check runs concurrently and each one does read-modify-write
// on this single file, so a plain overwrite means the last writer wins and
// silently discards whatever the others recorded in the meantime. That is how
// the lead-status snapshot kept vanishing: it was written, then clobbered by a
// check that had read the state before it. Re-reading here and merging keeps
// each check's own keys intact.
function setArboxState(state) {
  const current = readJson(ARBOX_STATE_FILE, {});
  const merged = { ...current, ...state };

  // sentTemplateLog is the record of who must not be messaged again, and it is
  // the one key that must never shrink. A top-level merge is not enough for it:
  // a check that read the state a moment earlier writes its whole stale copy
  // back, and that copy's older, smaller log replaces the current one wholesale.
  // That silently erased protection for 230 people once. Merged key by key, and
  // never allowed to lose entries.
  merged.sentTemplateLog = { ...(current.sentTemplateLog || {}), ...(state.sentTemplateLog || {}) };

  writeJson(ARBOX_STATE_FILE, merged);
}

function getAppointments() {
  return readJson(APPOINTMENTS_FILE, []);
}

function getTickets() {
  return readJson(TICKETS_FILE, []);
}

function getAllConversations() {
  return readJson(CONVERSATIONS_FILE, {});
}

function getSettings() {
  return readJson(SETTINGS_FILE, { customerAutomationsEnabled: false });
}

function setSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

module.exports = {
  dataDir: DATA_DIR,
  getConversation,
  saveConversation,
  resetConversation,
  addAppointment,
  addTicket,
  getAdminNotes,
  addAdminNote,
  getArboxState,
  setArboxState,
  getAppointments,
  getTickets,
  getAllConversations,
  getSettings,
  setSetting,
};
