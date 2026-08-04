const fs = require("fs");
const path = require("path");

// Overridable so production hosting can point this at a persistent disk
// mount instead of the app's own (often ephemeral) working directory.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
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

function setArboxState(state) {
  writeJson(ARBOX_STATE_FILE, state);
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
