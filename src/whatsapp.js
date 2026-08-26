const fuse = require("./fuse");

const GRAPH_VERSION = "v20.0";

// Read fresh each time so it can be flipped from the admin panel without a
// redeploy - a redeploy is the last thing you want in the middle of an incident.
function shadowMode() {
  if (process.env.SHADOW_MODE === "true") return true;
  return Boolean(require("./store").getSettings().shadowMode);
}

// The number is hosted by 360dialog (Coexistence onboarding, Aug 2026), so we
// send through their gateway rather than Graph. Same JSON payloads, different
// base URL and auth header. Falls back to Graph if D360_API_KEY isn't set.
function useD360() {
  return Boolean(process.env.D360_API_KEY);
}

function apiUrl() {
  if (useD360()) return "https://waba-v2.360dialog.io/messages";
  return `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

function authHeaders() {
  if (useD360()) return { "D360-API-KEY": process.env.D360_API_KEY };
  return { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
}

// A last line of defence in front of every template send, whatever called it.
//
// Guards on individual automations kept missing one: the weekly attendance
// summary had none, so switching automations on sent it to every member at
// once, and three leads written to by hand were then messaged again by the new
// lead check. Per-automation guards are easy to forget; this one is impossible
// to route around, because everything goes through here.
const DUPLICATE_WINDOW_DAYS = 7;
// However many automations decide someone qualifies, a person hears from us at
// most once a day. Guarding per template name was not enough: the evening-before
// and same-day trial reminders are two different templates, so both went to the
// same customer within the hour and the per-template check waved them through.
// The limit belongs to the person, not the message.
const PER_PERSON_COOLDOWN_HOURS = 24;

function sentLog() {
  return require("./store").getArboxState().sentTemplateLog || {};
}

// Returns the reason to skip, or null to allow.
//
// `deliberate` marks a message Nadav triggered himself by moving a lead's status
// in Arbox, as opposed to one an automation decided on its own from a passive
// condition like an absence or a birthday. A deliberate message always goes:
// he has just acted on that person and expects them to hear from us, so the
// daily cooldown and the blanket protection do not apply to it. The
// same-template rule still does, so nobody ever gets the same words twice.
function skipReason(to, templateName, { deliberate = false } = {}) {
  const log = sentLog();
  const now = Date.now();

  const sameTemplate = log[`${to}:${templateName}`];
  if (sameTemplate && now - new Date(sameTemplate).getTime() < DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return `already sent this template within ${DUPLICATE_WINDOW_DAYS} days`;
  }

  if (deliberate) return null;

  // Any template at all to this person recently.
  const lastAny = Object.entries(log)
    .filter(([key]) => key.startsWith(`${to}:`))
    .map(([, at]) => new Date(at).getTime())
    .sort((a, b) => b - a)[0];
  if (lastAny && now - lastAny < PER_PERSON_COOLDOWN_HOURS * 60 * 60 * 1000) {
    return `already messaged this person within ${PER_PERSON_COOLDOWN_HOURS}h`;
  }

  return null;
}

function recordSent(to, templateName) {
  const store = require("./store");
  const state = store.getArboxState();
  const log = state.sentTemplateLog || {};
  log[`${to}:${templateName}`] = new Date().toISOString();
  store.setArboxState({ ...state, sentTemplateLog: log });
}

async function sendText(to, body) {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("WhatsApp send failed:", res.status, errText);
    throw new Error(`WhatsApp send failed: ${res.status} ${errText}`);
  }
  return res;
}

// Sends an approved message template - the only way to reach someone who
// hasn't messaged us in the last 24h (WhatsApp blocks free-form text outside
// that window). `params` are plain strings filled into the template's {{1}},
// {{2}}, ... slots in order.
async function sendTemplate(to, templateName, params = [], options = {}) {
  const skip = skipReason(to, templateName, options);
  if (skip) {
    console.log(`Skipping ${templateName} to ${to}: ${skip}`);
    return null;
  }

  // The fuse (see fuse.js) is checked last, so it sees only messages that
  // everything else already approved. It knows nothing about why any particular
  // message qualified - only how many are leaving - which is what makes it hold
  // when a check is wrong in a way nobody predicted.
  // A broadcast is exempt, and only a broadcast. The fuse exists to stop volume
  // nobody intended; a broadcast is volume stated on screen, counted, and
  // confirmed by hand a second time. Left fused it would stop after eight of a
  // hundred and ninety-one and lock everything - a worse outcome than the one it
  // guards against, and one that would teach everybody to distrust the fuse.
  const blocked = options.bulkApprovedByAdmin ? null : fuse.blockReason();
  if (blocked) {
    console.error(`Blocked ${templateName} to ${to}: ${blocked}`);
    return null;
  }

  // Shadow mode: work out every message, send none of them. This is what any
  // change to the automations should run under first - the log then says
  // precisely who would have been written to, on real data, with no way for a
  // mistake to reach a customer.
  if (shadowMode()) {
    console.log(`[SHADOW] would send ${templateName} to ${to} [${params.join(" | ")}]`);
    recordSent(to, templateName);
    return null;
  }

  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "he" },
        components:
          params.length > 0
            ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text) })) }]
            : [],
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("WhatsApp template send failed:", res.status, errText);
    throw new Error(`WhatsApp template send failed: ${res.status} ${errText}`);
  }
  recordSent(to, templateName);
  fuse.record();
  return res;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends each non-empty line as its own WhatsApp message, with a short pause
// between them, instead of one long paragraph.
async function sendBurst(to, text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    await sendText(to, line);
    await sleep(600 + Math.random() * 500);
  }
}

async function markAsRead(messageId) {
  await fetch(apiUrl(), {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  });
}

// Extracts the first inbound text message from a webhook payload, or null if
// this payload isn't an inbound text message (e.g. a status update).
function extractIncomingText(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  if (!message) return null;
  if (message.type !== "text") {
    return { from: message.from, id: message.id, unsupported: true };
  }
  return { from: message.from, id: message.id, text: message.text.body };
}

module.exports = {
  sendText,
  sendTemplate,
  sendBurst,
  markAsRead,
  extractIncomingText,
  shadowMode,
  // So the approval queue can decline to list something that would be refused
  // at send time, and the panel never shows work that is not really there.
  wouldSkip: skipReason,
};
