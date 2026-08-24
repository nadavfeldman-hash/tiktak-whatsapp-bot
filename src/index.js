require("dotenv").config();
const express = require("express");
const whatsapp = require("./whatsapp");
const ai = require("./ai");
const store = require("./store");
const arboxMonitor = require("./arbox-monitor");
const adminPanel = require("./admin");

const RESET_COMMANDS = ["איפוס שיחה", "אפס שיחה", "תאפס שיחה", "reset chat"];
const ADMIN_PHONE = process.env.ADMIN_PHONE;
const UPDATE_PREFIX = "עדכון:";
const SHOW_UPDATES_COMMANDS = ["הצג עדכונים", "מה יש בזיכרון"];

const app = express();
// Coexistence syncs up to 6 months of chat history through the webhook, and
// those payloads blow past body-parser's 100kb default - we were dropping them
// with PayloadTooLargeError.
app.use(express.json({ limit: "10mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/admin", adminPanel);

// Meta calls this once to verify the webhook URL you register.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta posts incoming messages / status updates here.
app.post("/webhook", async (req, res) => {
  // Ack immediately - Meta retries aggressively if this is slow or non-2xx.
  res.sendStatus(200);

  let incoming;
  try {
    const statuses = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (statuses) {
      for (const s of statuses) {
        console.log(
          `Message status: id=${s.id} status=${s.status} to=${s.recipient_id}` +
            (s.errors ? ` errors=${JSON.stringify(s.errors)}` : "")
        );
      }
    }

    incoming = whatsapp.extractIncomingText(req.body);
    if (!incoming) return; // status update or other non-message event

    // Second safety gate, alongside ENABLE_CUSTOMER_AUTOMATIONS: while the bot's
    // answers are still being tuned, log what people send but stay silent. Only
    // the literal string "true" opens it - anything else keeps the bot quiet.
    if (process.env.ENABLE_AUTO_REPLY !== "true") {
      console.log(
        `Auto-reply OFF - not answering ${incoming.from}: ` +
          (incoming.unsupported ? "(non-text message)" : JSON.stringify(incoming.text))
      );
      return;
    }

    await whatsapp.markAsRead(incoming.id);

    if (incoming.unsupported) {
      await whatsapp.sendText(incoming.from, "כרגע אני תומך רק בהודעות טקסט. אפשר לכתוב לי מה תרצה?");
      return;
    }

    if (RESET_COMMANDS.includes(incoming.text.trim())) {
      store.resetConversation(incoming.from);
      await whatsapp.sendText(incoming.from, "השיחה אופסה, מתחילים מאפס 🙏");
      return;
    }

    const isAdmin = ADMIN_PHONE && incoming.from === ADMIN_PHONE;
    const trimmedText = incoming.text.trim();

    if (isAdmin && trimmedText.startsWith(UPDATE_PREFIX)) {
      const noteText = trimmedText.slice(UPDATE_PREFIX.length).trim();
      if (noteText) {
        store.addAdminNote(noteText);
        await whatsapp.sendText(incoming.from, `נשמר ✅ הבוט כבר יודע את זה מההודעה הבאה:\n"${noteText}"`);
      } else {
        await whatsapp.sendText(incoming.from, 'כתוב את העדכון אחרי "עדכון:", למשל: עדכון: יש עכשיו מבצע 175 שקל לחודש ראשון');
      }
      return;
    }

    if (isAdmin && SHOW_UPDATES_COMMANDS.includes(trimmedText)) {
      const notes = store.getAdminNotes();
      const list = notes.length
        ? notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n")
        : "אין עדיין עדכונים שמורים.";
      await whatsapp.sendText(incoming.from, list);
      return;
    }

    const reply = await ai.handleIncomingMessage(incoming.from, incoming.text, isAdmin);
    await whatsapp.sendText(incoming.from, reply);
  } catch (err) {
    console.error("Error handling webhook event:", err);
    // Never leave the customer hanging with silence - always send something back,
    // even when the AI call itself failed (network glitch, rate limit, etc).
    if (incoming?.from) {
      try {
        await whatsapp.sendText(incoming.from, "רגע קטן של תקלה טכנית מהצד שלי, סליחה 🙏 תוכל לכתוב שוב את מה שרצית?");
      } catch (sendErr) {
        console.error("Also failed to send the fallback error message:", sendErr);
      }
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`WhatsApp bot listening on port ${port}`));

// SEED_AUTOMATIONS=true marks everything currently outstanding as already
// handled - silently, sending nothing - so that switching automations on does
// not fire a month of backlog at once. Set it for one deploy, then remove it.
if (process.env.SEED_AUTOMATIONS === "true") {
  console.log("SEED_AUTOMATIONS is set - marking the existing backlog as handled before monitoring starts.");
  require("./seed-automations")
    .seedAutomations()
    .catch((e) => console.error("Seeding failed:", e.message))
    .finally(() => arboxMonitor.startMonitoring());
} else {
  arboxMonitor.startMonitoring();
}
