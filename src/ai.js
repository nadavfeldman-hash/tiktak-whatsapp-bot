const Anthropic = require("@anthropic-ai/sdk");
const knowledge = require("./knowledge");
const store = require("./store");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_HISTORY = 20;
const MAX_TOOL_ROUNDS = 4;

const BASE_SYSTEM_PROMPT = `אתה עוזר וירטואלי שעונה בוואטסאפ מטעם העסק הבא, בתפקיד מכירות ושימור לקוחות -
לא נציג תמיכה יבש. ענה אך ורק על סמך המידע שסופק, והשתמש בכלים כשצריך.

עם ליד חדש/מישהו לא מוכר - לפני שמציעים אימון ניסיון או מנוי, לשאול מהלב (לא כחקירה) כ-3-4 שאלות
אמיתיות כדי להבין את הכאב/הסיבה/מה חסר לו - אחת בכל הודעה, לא הכל בבת אחת. אחרי כל תשובה של הלקוח,
קודם לשקף בקצרה מה שהוא אמר ולוודא שהבנת נכון, ורק אז להמשיך. ברגע שיש כמה תשובות טובות ותמונה
אמיתית - לעבור בטבעיות להצעה (מקום, מחיר, הטבות), בלי להמשיך "לחפור" מעבר לזה.

מידע על העסק:
${knowledge}`;

// Rebuilt on every message (not cached) so admin updates sent from WhatsApp
// take effect immediately, without restarting the server.
function buildSystemPrompt(isAdmin) {
  const notes = store.getAdminNotes();
  let prompt = BASE_SYSTEM_PROMPT;

  if (notes.length > 0) {
    const notesText = notes.map((n) => `- ${n.text}`).join("\n");
    prompt += `

עדכונים נוספים מנדב (חשוב - אלה גוברים על מה שכתוב למעלה אם יש סתירה, כי הם יותר עדכניים):
${notesText}`;
  }

  if (isAdmin) {
    prompt += `

חשוב: מי שכותב לך עכשיו זה נדב עצמו, הבעלים של העסק - לא לקוח. אם הוא נותן לך משוב או תיקון
על איך אתה צריך להתנהג/לענות (למשל "לא ככה, תגיד ככה במקום", "זו טעות, תזכור ש...", "מעכשיו
תמיד...") - השתמש בכלי remember_correction כדי לשמור את הלקח באופן כללי לתמיד, ותאשר לו בקצרה
שקלטת. אם הוא סתם משוחח רגיל (למשל בודק/מדמה שיחה כאילו הוא לקוח כדי לבדוק אותך) - תתייחס
לזה כרגיל, בלי לשמור כלום.`;
  }

  return prompt;
}

const BASE_TOOLS = [
  {
    name: "book_appointment",
    description: "קובע אימון (ניסיון או רגיל) עבור הלקוח ושומר אותו במערכת.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "שם מלא של הלקוח" },
        date: { type: "string", description: "תאריך מבוקש, לדוגמה 2026-07-25" },
        time: { type: "string", description: "שעה מבוקשת, לדוגמה 18:20" },
        reason: { type: "string", description: "סוג האימון/הבקשה (למשל: אימון ניסיון, אימון נוער)" },
      },
      required: ["name", "date", "time", "reason"],
    },
  },
  {
    name: "create_support_ticket",
    description: "פותח פנייה לנדב עצמו כשצריך מעורבות אנושית (תשלום, פציעה, תלונה, משהו שלא במידע הקיים).",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "כותרת קצרה לפנייה" },
        description: { type: "string", description: "פירוט הפנייה" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["subject", "description"],
    },
  },
];

const ADMIN_ONLY_TOOLS = [
  {
    name: "remember_correction",
    description:
      "שומר לצמיתות תיקון/הוראה שנדב (הבעלים) נתן על איך הבוט צריך להתנהג או לענות, כדי שזה יחול על כל השיחות העתידיות. להשתמש רק כשנדב עצמו נותן משוב מפורש על ההתנהגות, לא בשיחת לקוח רגילה.",
    input_schema: {
      type: "object",
      properties: {
        lesson: {
          type: "string",
          description: "התיקון מנוסח ככלל כללי (לא תלוי בפרטי השיחה הספציפית), שיהיה ברור גם בעתיד",
        },
      },
      required: ["lesson"],
    },
  },
];

function buildTools(isAdmin) {
  return isAdmin ? [...BASE_TOOLS, ...ADMIN_ONLY_TOOLS] : BASE_TOOLS;
}

// Slicing history to the last N messages can land right in the middle of a
// tool_use/tool_result pair, leaving an orphaned tool_result with no matching
// tool_use before it - which the API rejects outright. Drop any such leftover
// tool_result message(s) at the start once that happens.
function trimHistory(messages, maxLen) {
  let trimmed = messages.slice(-maxLen);
  while (
    trimmed.length > 0 &&
    trimmed[0].role === "user" &&
    Array.isArray(trimmed[0].content) &&
    trimmed[0].content.some((block) => block.type === "tool_result")
  ) {
    trimmed = trimmed.slice(1);
  }
  // Symmetric case: if the very last message is an assistant turn that ends
  // with tool_use blocks we never resolved (e.g. the response got cut off by
  // max_tokens mid tool-call), drop it entirely - it has no matching
  // tool_result and would break the next API call.
  while (
    trimmed.length > 0 &&
    trimmed[trimmed.length - 1].role === "assistant" &&
    Array.isArray(trimmed[trimmed.length - 1].content) &&
    trimmed[trimmed.length - 1].content.some((block) => block.type === "tool_use")
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function executeTool(name, input, phone) {
  if (name === "book_appointment") {
    const entry = store.addAppointment({ phone, ...input });
    return `נקבע תור מספר ${entry.id}.`;
  }
  if (name === "create_support_ticket") {
    const entry = store.addTicket({ phone, ...input });
    return `נפתחה פנייה מספר ${entry.id}, נציג יחזור בהקדם.`;
  }
  if (name === "remember_correction") {
    store.addAdminNote(input.lesson);
    return "נשמר לצמיתות.";
  }
  return `כלי לא מוכר: ${name}`;
}

async function handleIncomingMessage(phone, userText, isAdmin = false) {
  const history = store.getConversation(phone);
  const messages = [...history, { role: "user", content: userText }];
  const systemPrompt = buildSystemPrompt(isAdmin);
  const tools = buildTools(isAdmin);

  let finalText = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
    });

    finalText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // If the response got cut off mid-generation, any tool_use blocks in it
    // may be incomplete/malformed and can never get a matching tool_result -
    // saving them to history would permanently corrupt future API calls. Drop
    // them and treat this round as text-only.
    if (response.stop_reason === "max_tokens") {
      const textOnly = response.content.filter((block) => block.type !== "tool_use");
      messages.push({ role: "assistant", content: textOnly });
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((block) => block.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      break;
    }

    const toolResults = toolUses.map((toolUse) => ({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: executeTool(toolUse.name, toolUse.input, phone),
    }));
    messages.push({ role: "user", content: toolResults });
  }

  store.saveConversation(phone, trimHistory(messages, MAX_HISTORY));
  return finalText || "מצטער, לא הצלחתי לעבד את הבקשה. נסה שוב או נסח אחרת.";
}

module.exports = { handleIncomingMessage };
