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
// Which switches are actually on, in the running process. Environment
// variables set in the Render dashboard cannot be read from anywhere else, so
// without this every "did the toggle take effect?" question turns into guesswork
// and screenshots. Booleans and one date only - no secrets.

// Every word that reaches a customer from the conversation path goes through
// here, and here it is queued rather than sent. Nadav approves it in the panel.
// Kept as one function so there is a single place to look when asking "can
// anything get out without him" - the answer has to be checkable, not remembered.
function queueReply(to, body, incomingText) {
  // Answering people in chat is a switch of its own, like every automation.
  if (!arboxMonitor.automationOn("תשובה בשיחה")) {
    console.log(`Chat replies are off - not queueing a reply to ${to}.`);
    return;
  }
  require("./outbox").propose({
    to,
    kind: "text",
    body,
    automation: "תשובה בשיחה",
    personName: to,
    incoming: incomingText || "",
  });
  console.log(`Reply to ${to} queued for approval, not sent.`);
}

app.get("/status", (req, res) => {
  const override = process.env.ENABLE_CUSTOMER_AUTOMATIONS;
  res.json({
    autoReply: process.env.ENABLE_AUTO_REPLY === "true",
    customerAutomations: {
      envOverride: override === undefined ? null : override,
      storedSetting: !!store.getSettings().customerAutomationsEnabled,
      // HARD_STOP in arbox-monitor beats every other switch, so it has to be
      // part of "effective" here too - reporting true while the code refuses to
      // send is exactly the kind of mismatch that caused trouble already.
      hardStop: Boolean(arboxMonitor.HARD_STOP_ACTIVE),
      effective: arboxMonitor.HARD_STOP_ACTIVE
        ? false
        : override === "false"
          ? false
          : override === "true"
            ? true
            : !!store.getSettings().customerAutomationsEnabled,
    },
    automationsStartFrom: process.env.AUTOMATIONS_START_DATE || "built-in default",
    // Which automations are on, and which send without waiting. Reading this
    // off the rendered dashboard meant parsing HTML and guessing; a wrong guess
    // about whether something is armed is exactly the guess not to get wrong.
    automations: {
      enabled: store.getSettings().enabledAutomations || [],
      sendWithoutApproval: store.getSettings().autoApproveAutomations || [],
    },
    // The fuse underneath everything: how many messages have actually left in
    // the last hour and day, and whether it has cut the power.
    fuse: require("./fuse").status(),
    // What actually reached a phone, as WhatsApp reports it back.
    delivery: (store.getArboxState().deliveryStatus || []).slice(-40),
    // How many messages are waiting for Nadav. Nothing here has been sent.
    awaitingApproval: require("./outbox").counts(),
    shadowMode: require("./whatsapp").shadowMode(),
    // What the monitor currently believes each lead's status is. Without seeing
    // this there is no way to tell a "nothing changed" from a bug.
    leadStatusSnapshot: store.getArboxState().leadStatusSnapshot || null,
    notifiedLeadKeys: (store.getArboxState().notifiedLeadNoResponseKeys || []).length,
    monitorLastRun: arboxMonitor.lastRun,
    // Exactly what was sent, to whom, and when. Without this, "who got four
    // messages and why" can only be guessed at from the outside.
    sentTemplateLog: store.getArboxState().sentTemplateLog || {},
    // Where state is written, and whether that path survived the last restart.
    dataDir: store.dataDir,
    dataDirIsPersistent: store.dataDir === "/var/data" || Boolean(process.env.DATA_DIR),
    stateKeys: Object.keys(store.getArboxState()),
    weeklySummary: {
      lastRun: store.getArboxState().lastAttendanceTrendCheckDate || null,
    },
    sendsVia: process.env.D360_API_KEY ? "360dialog" : "graph",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    arboxConfigured: Boolean(process.env.ARBOX_API_KEY),
  });
});

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
      // Kept, not just logged. WhatsApp accepting a message means only that it
      // took it; whether it reached the phone arrives later, here. Without this
      // the honest answer to "did they get it?" was a shrug - the send log said
      // sent, and sent is not delivered. Now the answer is a fact.
      const state = store.getArboxState();
      const recent = (state.deliveryStatus || []).concat(
        statuses.map((s) => ({
          at: new Date().toISOString(),
          to: s.recipient_id,
          status: s.status,
          error: s.errors ? s.errors.map((e) => e.title || e.message).join("; ") : null,
        }))
      );
      store.setArboxState({ ...state, deliveryStatus: recent.slice(-200) });
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

    // Marking the message read is a blue tick and nothing more. It used to sit
    // unguarded at the top of this block, so a hiccup on that one call threw the
    // whole thing into the catch below and the customer got "sorry, technical
    // problem" instead of an answer - a cosmetic call breaking the only part
    // that matters.
    try {
      await whatsapp.markAsRead(incoming.id);
    } catch (e) {
      console.log("Could not mark as read (harmless):", e.message);
    }

    if (incoming.unsupported) {
      queueReply(incoming.from, "כרגע אני תומך רק בהודעות טקסט. אפשר לכתוב לי מה תרצה?", "(הודעה שאינה טקסט)");
      return;
    }

    if (RESET_COMMANDS.includes(incoming.text.trim())) {
      store.resetConversation(incoming.from);
      queueReply(incoming.from, "השיחה אופסה, מתחילים מאפס 🙏", incoming.text);
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

    // Nadav writing to his own bot gets answered directly - he is talking to a
    // tool, not being marketed at, and asking him to approve his own answers
    // would be absurd.
    if (isAdmin) {
      await whatsapp.sendText(incoming.from, reply);
      return;
    }

    // Everyone else's answer goes into the same queue as everything else.
    //
    // This was the one way a message could still reach a customer without Nadav
    // seeing it first: the automations were routed through approval, but the
    // conversational bot answered on its own, immediately, straight from the
    // webhook. One unguarded path is the same as none, so it goes through the
    // queue with the customer's own question attached - an answer can only be
    // judged against what was asked.
    //
    // Once the answers have proved themselves this can be relaxed. Until then
    // the rule is the rule, with no exception anywhere in the code.
    require("./outbox").propose({
      to: incoming.from,
      kind: "text",
      body: reply,
      automation: "תשובה בשיחה",
      personName: incoming.from,
      incoming: incoming.text,
    });
    console.log(`Reply to ${incoming.from} queued for approval, not sent.`);
  } catch (err) {
    console.error("Error handling webhook event:", err);
    // Never leave the customer hanging with silence - always send something back,
    // even when the AI call itself failed (network glitch, rate limit, etc).
    if (incoming?.from) {
      // Queued rather than sent, like every other word that reaches a customer.
      // Silence while Nadav looks is better than a message he never agreed to.
      queueReply(incoming.from, "רגע קטן של תקלה טכנית מהצד שלי, סליחה 🙏 תוכל לכתוב שוב את מה שרצית?", incoming.text || "");
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
