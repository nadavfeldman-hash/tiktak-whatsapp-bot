// What the system decided, and why.
//
// Until now the only record of a decision was the message itself. If nothing
// arrived there was no way to tell the difference between "the check never saw
// it", "it saw it and a guard blocked it", "it sent and WhatsApp dropped it" and
// "the check crashed halfway". Every one of those questions was answered by
// guessing, out loud, to Nadav, more than once.
//
// So every decision is written down here with its reason, whether or not it led
// to a message. The failures matter more than the successes: a message that went
// out is visible on the phone, and one that did not is visible nowhere else.
//
// Append-only, capped, and never read by the logic itself - it exists to be read
// by a person.

const fs = require("fs");
const path = require("path");
const store = require("./store");

const FILE = path.join(store.dataDir, "events.json");
const MAX = 500;

function read() {
  try {
    if (!fs.existsSync(FILE)) return [];
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

// Writing must never be able to break a check: an event is a note about work,
// not the work.
function record(entry) {
  try {
    const all = read();
    all.push({ at: new Date().toISOString(), ...entry });
    fs.writeFileSync(FILE, JSON.stringify(all.slice(-MAX)));
  } catch (e) {
    console.error("Could not record event:", e.message);
  }
}

// A decision about one person: what was considered, and what came of it.
function decision({ automation, person, phone, outcome, reason }) {
  record({ kind: "decision", automation, person, phone, outcome, reason: reason || null });
  const label = reason ? `${outcome} (${reason})` : outcome;
  console.log(`Event: ${automation} → ${person || phone} → ${label}`);
}

// A check that threw. These used to vanish into a .catch that printed to a
// console nobody can read, so an automation could be dead for a week and look
// exactly like an automation with nothing to do.
function failure(automation, error) {
  record({ kind: "failure", automation, reason: String(error).slice(0, 200) });
  console.error(`Event: ${automation} FAILED - ${error}`);
}

function recent(limit = 100) {
  return read().slice(-limit).reverse();
}

// Everything that did not end in a message, newest first. This is the list to
// read when somebody asks why they did not hear from us.
function notSent(limit = 60) {
  return read()
    .filter((e) => e.kind === "failure" || (e.kind === "decision" && e.outcome !== "נשלח"))
    .slice(-limit)
    .reverse();
}

module.exports = { record, decision, failure, recent, notSent };
