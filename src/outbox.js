// Nothing reaches a customer that Nadav has not looked at and approved.
//
// Until now each of the seventeen checks both decided who qualified and sent to
// them, in the same breath. That is why every mistake in a decision became a
// message on a real phone within two minutes, with nobody in between. Widening
// one query from 50 records to 515 sent 46 people a message about something that
// happened months ago, and there was no point at which a person could have seen
// it coming.
//
// So the two halves are separated here. Checks no longer send; they propose. A
// proposal sits in this queue, with the person's name and the exact words, until
// Nadav approves it in the admin panel. Approving drains it through the ordinary
// sender, which still applies every existing guard and the fuse underneath them.
//
// The property this buys is the one that matters: a bug can now only ever fill a
// list. It cannot reach anybody. Whatever goes wrong next - a query that widens,
// a date that parses oddly, a check nobody thought about - the worst case is a
// queue that looks obviously wrong, on a screen, before anything is sent.

const fs = require("fs");
const path = require("path");
const store = require("./store");

const FILE = path.join(store.dataDir, "outbox.json");

// A proposal nobody got round to approving stops being worth sending. A birthday
// greeting three days late, or a "see you tomorrow" for a session that already
// happened, is worse than silence.
const EXPIRY_HOURS = 36;

// If one automation proposes more than this in a single cycle, the whole batch
// is held together and flagged rather than queued item by item. Real events do
// not arrive twenty at a time; a number like that always means the code started
// seeing something differently, which is exactly the failure that has happened
// twice. Held batches are shown as one line to approve or discard as a unit, so
// a mistake of this shape is one glance and one click, not fifty.
const BATCH_LIMIT = 8;

function read() {
  try {
    if (!fs.existsSync(FILE)) return { items: [], nextId: 1 };
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { items: [], nextId: 1 };
  }
}

function write(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function isExpired(item) {
  return Date.now() - new Date(item.proposedAt).getTime() > EXPIRY_HOURS * 60 * 60 * 1000;
}

// One person, one automation, one pending proposal. Without this a check that
// runs every two minutes queues the same person thirty times an hour.
function alreadyPending(items, p) {
  // A reply is an answer to one particular thing somebody asked, so two of them
  // to the same person are two different messages and both belong in the queue.
  // Automated messages are the opposite: a check running every two minutes would
  // otherwise queue the same person thirty times an hour.
  if (p.kind === "text") return false;
  // "Not finished with" rather than "still pending". Approving an item takes it
  // out of pending, but it is not sent until the next cycle - and in that gap
  // the checks were free to queue the very same message again, because it was
  // no longer pending and not yet in the send log. A duplicate for the same
  // person appeared in the panel within a minute of approving the first, which
  // is the one thing that must never happen.
  const OPEN = ["pending", "held", "approved"];
  return items.some((i) => OPEN.includes(i.status) && i.to === p.to && i.template === p.template);
}

// Called by the checks in place of sending. Returns the queued item, or null if
// it was a duplicate of something already waiting.
function propose(p) {
  const data = read();
  if (alreadyPending(data.items, p)) return null;

  // Never queue something the sender would refuse anyway. Without this, an item
  // that has already gone out sits in the queue looking like work to do, gets
  // approved, and is then silently dropped - so the panel and reality disagree,
  // which is how nobody noticed people being messaged repeatedly the first time.
  // The no-repeats rules are about templates the business initiates; they have
  // nothing to say about answering a person who has just written in.
  if (p.kind !== "text") {
    const blocked = require("./whatsapp").wouldSkip(p.to, p.template, { deliberate: true });
    if (blocked) return null;
  }

  const item = {
    id: data.nextId++,
    status: "pending",
    proposedAt: new Date().toISOString(),
    to: p.to,
    // "template" is a pre-approved message the business starts; "text" is a
    // reply to somebody who has just written in, which WhatsApp allows as free
    // text for 24 hours. Both wait for approval; only how they are sent differs.
    kind: p.kind === "text" ? "text" : "template",
    template: p.template,
    params: p.params || [],
    body: p.body || "",
    // Everything below is for the human reading the queue, not for the machine.
    automation: p.automation || "לא ידוע",
    personName: p.personName || "",
    reason: p.reason || "",
    preview: p.preview || p.body || "",
    // What the customer actually asked, so the answer can be judged against it.
    incoming: p.incoming || "",
  };
  // Some automations are approved in advance, by name. Moving a lead to "no
  // answer" in Arbox is Nadav performing the decision himself - asking him to
  // then approve the consequence of his own action in a second place is a
  // formality, and formalities are what get clicked without reading.
  //
  // It changes nothing else: the proposal is still built the same way, still
  // de-duplicated, and still passes every guard on the way out. Only the wait
  // for a human is skipped, and only where he has said so.
  if (autoApproved(item.automation)) {
    item.status = "approved";
    item.autoApproved = true;
  }

  data.items.push(item);
  write(data);
  return item;
}

function autoApproved(automation) {
  const list = store.getSettings().autoApproveAutomations;
  return Array.isArray(list) && list.includes(automation);
}

// Propose a whole automation's worth of decisions at once, so an implausible
// number of them can be caught as a group before any of it is queued.
function proposeBatch(automation, proposals) {
  if (proposals.length > BATCH_LIMIT) {
    const data = read();
    data.items.push({
      id: data.nextId++,
      status: "held",
      proposedAt: new Date().toISOString(),
      automation,
      heldCount: proposals.length,
      // Kept whole: approving a held batch must send exactly what was proposed,
      // not whatever a re-run would decide later.
      batch: proposals,
    });
    write(data);
    console.log(
      `Outbox: ${automation} proposed ${proposals.length} messages at once - held as one batch for review.`
    );
    return { held: true, count: proposals.length };
  }
  const queued = proposals.map(propose).filter(Boolean);
  return { held: false, count: queued.length };
}

function pending() {
  const data = read();
  return data.items.filter((i) => (i.status === "pending" || i.status === "held") && !isExpired(i));
}

function history(limit = 60) {
  const data = read();
  return data.items
    .filter((i) => i.status !== "pending" && i.status !== "held")
    .sort((a, b) => new Date(b.proposedAt) - new Date(a.proposedAt))
    .slice(0, limit);
}

function setStatus(ids, status) {
  const data = read();
  const wanted = new Set(ids.map(Number));
  let n = 0;
  for (const item of data.items) {
    if (wanted.has(item.id) && (item.status === "pending" || item.status === "held")) {
      item.status = status;
      item.decidedAt = new Date().toISOString();
      n++;
    }
  }
  write(data);
  return n;
}

// Approval marks items to send; the actual sending happens in send(), so that a
// slow or failing WhatsApp call can never leave the panel hanging or an item in
// a state where nobody knows whether it went.
function approve(ids) {
  return setStatus(ids, "approved");
}

function reject(ids) {
  return setStatus(ids, "rejected");
}

function approveAllPending() {
  return approve(pending().map((i) => i.id));
}

function rejectAllPending() {
  return reject(pending().map((i) => i.id));
}

// Drains everything approved. Called on a timer, so approving in the panel
// returns immediately and the messages follow within a cycle.
async function send() {
  const whatsapp = require("./whatsapp");
  const data = read();
  const due = data.items.filter((i) => i.status === "approved");
  if (due.length === 0) return { sent: 0 };

  let sent = 0;
  for (const item of due) {
    // A held batch approved as a unit expands here into its individual messages.
    const messages = item.batch || [item];
    for (const m of messages) {
      try {
        const res =
          m.kind === "text"
            ? await whatsapp.sendText(m.to, m.body)
            : await whatsapp.sendTemplate(m.to, m.template, m.params, { deliberate: true });
        if (res) sent++;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (e) {
        console.error(`Outbox: failed to send to ${m.to}:`, e.message);
      }
    }
    item.status = "sent";
    item.sentAt = new Date().toISOString();
  }

  // Re-read before writing: a check may have queued something while we were
  // sending, and that proposal must not be lost.
  const fresh = read();
  const byId = new Map(data.items.map((i) => [i.id, i]));
  fresh.items = fresh.items.map((i) => (byId.get(i.id)?.status === "sent" ? byId.get(i.id) : i));
  write(fresh);

  return { sent };
}

// Drops expired proposals so the queue reflects what is still worth doing.
function sweep() {
  const data = read();
  let n = 0;
  for (const item of data.items) {
    if ((item.status === "pending" || item.status === "held") && isExpired(item)) {
      item.status = "expired";
      n++;
    }
  }
  if (n) write(data);
  return n;
}

function counts() {
  const p = pending();
  return {
    pending: p.filter((i) => i.status === "pending").length,
    held: p.filter((i) => i.status === "held").length,
    heldMessages: p.filter((i) => i.status === "held").reduce((s, i) => s + (i.heldCount || 0), 0),
  };
}

module.exports = {
  propose,
  proposeBatch,
  pending,
  history,
  approve,
  reject,
  approveAllPending,
  rejectAllPending,
  send,
  sweep,
  counts,
  BATCH_LIMIT,
  EXPIRY_HOURS,
};
