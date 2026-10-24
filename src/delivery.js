// Did it reach the phone? Every message WhatsApp accepted from us, and every receipt it sends back
// (sent -> delivered -> read, or failed), kept per message id and per phone - for good, not the
// last 40.
//
// Why (24/10/2026): the power-cut notice of 20/10 said "נשלח" for a member who never got it, and
// nobody could say whether it had reached his phone - the receipts had already rolled out of the
// short list in arbox-state. "נשלח" only means WhatsApp took the message from us; "delivered" is
// the phone, "read" is blue ticks (when read receipts are on).
//
// Messages sent from a script on another machine still land here: their receipts arrive on this
// server's webhook with the recipient's number, so a phone's history is complete even when the
// outgoing side was recorded elsewhere.
const fs = require("fs");
const path = require("path");
const DATA_DIR = require("./store").dataDir;

const FILE = path.join(DATA_DIR, "delivery-log.json");
const MAX_MESSAGES = 20000;
const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

const key = (p) => String(p || "").replace(/\D/g, "").slice(-9);

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { messages: {} }; }
}
function write(d) {
  const ids = Object.keys(d.messages);
  if (ids.length > MAX_MESSAGES) {
    ids.sort((a, b) => String(d.messages[a].at).localeCompare(String(d.messages[b].at)));
    for (const id of ids.slice(0, ids.length - MAX_MESSAGES)) delete d.messages[id];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, FILE);
}

// After WhatsApp accepted a message: its id, who it went to, and what it was (template name or a
// broadcast label).
function recordOutgoing(id, to, label) {
  if (!id) return;
  const d = read();
  const now = new Date().toISOString();
  const m = d.messages[id] || { id, history: [] };
  Object.assign(m, { to: String(to), phone: key(to), label: label || m.label || null, at: m.at || now });
  if (!m.status) { m.status = "accepted"; m.statusAt = now; }
  m.history.push({ status: "accepted", at: now });
  d.messages[id] = m;
  write(d);
}

// A receipt from the webhook ({ id, status, recipient_id, timestamp, errors }).
function recordStatus(s) {
  if (!s || !s.id) return;
  const d = read();
  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString();
  const m = d.messages[s.id] || { id: s.id, to: s.recipient_id, phone: key(s.recipient_id), label: null, at, history: [] };
  const error = s.errors ? s.errors.map((e) => `${e.code || ""} ${e.title || e.message || ""}`.trim()).join("; ") : null;
  m.history.push({ status: s.status, at, error });
  // receipts can arrive out of order: keep the furthest one, and a failure always wins
  if ((RANK[s.status] ?? -1) >= (RANK[m.status] ?? -1)) { m.status = s.status; m.statusAt = at; if (error) m.error = error; }
  d.messages[s.id] = m;
  write(d);
}

// Everything we know about one phone, newest first.
function forPhone(phone) {
  const k = key(phone);
  return Object.values(read().messages).filter((m) => m.phone === k).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// One send (by label), per person: delivered / read / only accepted / failed.
function forLabel(label) {
  const rows = Object.values(read().messages).filter((m) => m.label === label);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { label, total: rows.length, counts, rows: rows.map((r) => ({ to: r.to, status: r.status, statusAt: r.statusAt, error: r.error || null })) };
}

module.exports = { recordOutgoing, recordStatus, forPhone, forLabel, _file: FILE };
