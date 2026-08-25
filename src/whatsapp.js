const GRAPH_VERSION = "v20.0";

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

function recentlySent(to, templateName) {
  const store = require("./store");
  const log = store.getArboxState().sentTemplateLog || {};
  const at = log[`${to}:${templateName}`];
  if (!at) return false;
  return Date.now() - new Date(at).getTime() < DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
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
async function sendTemplate(to, templateName, params = []) {
  if (recentlySent(to, templateName)) {
    console.log(`Skipping duplicate template ${templateName} to ${to} (sent within ${DUPLICATE_WINDOW_DAYS} days)`);
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

module.exports = { sendText, sendTemplate, sendBurst, markAsRead, extractIncomingText };
