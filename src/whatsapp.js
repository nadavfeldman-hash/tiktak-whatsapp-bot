const GRAPH_VERSION = "v20.0";

function apiUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function sendText(to, body) {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
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
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
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

module.exports = { sendText, sendBurst, markAsRead, extractIncomingText };
