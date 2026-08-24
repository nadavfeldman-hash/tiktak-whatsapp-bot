const Anthropic = require("@anthropic-ai/sdk");
const knowledge = require("./knowledge");
const store = require("./store");
const arbox = require("./arbox");
const gender = require("./gender");

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

שלושה כללים שגוברים על הכל:

1. אסור לחזור על שאלה שכבר שאלת - גם לא בניסוח אחר. לפני שאתה שולח הודעה, תסתכל על ההודעות
הקודמות שלך בשיחה: אם השאלה שאתה עומד לשאול כבר הופיעה באחת מהן, אל תשאל אותה. נקודה.
אם שאלת שאלה והלקוח ענה על משהו אחר - זה אומר שהוא לא רוצה לענות עליה. תוותר עליה לתמיד ותתקדם.
ואם בשתי ההודעות האחרונות שלך כבר שאלת שאלה שלא נענתה - ההודעה הבאה שלך לא תכיל שאלה בכלל,
רק תגובה למה שהוא כתב. אדם אמיתי לא חוזר על אותה שאלה שלוש פעמים, ובוט שעושה את זה מאבד את הלקוח.

2. קודם עונים על מה ששאלו. אם שואלים "מה זה בעצם?" / "מה אתם עושים?" - עונים מיד ובקצרה:
אימוני כוח אמיתיים (לא היט ולא פונקציונלי), אימון של 40 דקות, ארבע תחנות, בקבוצה קטנה, ואימון חדש
מתחיל כל 10 דקות - אז מגיעים מתי שנוח בלי להתחייב לשעה קבועה. רק אחרי שענית אפשר לשאול שאלה משלך.
לענות "קודם בוא נכיר" במקום לענות - זה מתסכל ומבריח.

3. לא יודעים אם מדובר בגבר או אישה. אסור להשתמש בלשון זכר, ואסור בשום צורה בלוכסנים - לא "את/ה",
לא "מתאמן/ת", לא "מאמן/ת". זה נראה כמו טופס ממשלתי ולא כמו אדם שכותב.
הדרך הנכונה היא לנסח מחדש בלי פנייה ישירה בגוף שני הווה. החלפות מדויקות:

  "בוא נכיר" ← "אז נכיר רגע"          "ספר לי" ← "מעניין אותי לשמוע" / "אשמח לשמוע"
  "אתה יכול להגיע" ← "אפשר להגיע"     "תגיד לי" ← "אפשר לכתוב לי"
  "מבין אותך" ← "מבין את זה לגמרי"     "אם תמשיך" ← "אם ממשיכים"
  "אתה בול בטיימינג" ← "זה בול הטיימינג"

בעבר גוף שני זהה לשני המינים ("התאמנת", "השארת", "הגעת") אז מותר להשתמש בו חופשי.
גם "לך", "שלך", "אצלך" בטוחים. לפני כל הודעה - לעבור עליה ולוודא שאין בה אף מילה בלשון זכר.
רק אם המגדר ברור מעל לכל ספק (השם, או שהלקוח כתב על עצמו בלשון מסוימת) - אפשר לעבור לדבר בהתאם.

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

// Asking the same thing three messages running is the single clearest tell that
// someone is talking to a bot, and the model slips into it however firmly the
// prompt says not to. So it's enforced here instead of asked for: once the last
// two replies both carried a question, the next one may not.
// Assistant turns are stored either as a plain string or as the raw block array
// the API returned, so pull the text out of both shapes.
function assistantText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function recentAssistantQuestionRun(history) {
  const texts = history
    .filter((m) => m.role === "assistant")
    .map(assistantText)
    .filter((t) => t.trim());
  const last = texts[texts.length - 1];
  return Boolean(last && last.includes("?"));
}

// One Arbox lookup per phone number per process - the directory barely changes
// within a conversation, and this sits on the path of every inbound message.
const contactCache = new Map();

async function lookupContact(phone) {
  if (contactCache.has(phone)) return contactCache.get(phone);
  let contact = null;
  try {
    contact = await arbox.findContactByPhone(phone);
  } catch (e) {
    console.error("Arbox contact lookup failed for", phone, e.message);
  }
  contactCache.set(phone, contact);
  return contact;
}

async function handleIncomingMessage(phone, userText, isAdmin = false) {
  const history = store.getConversation(phone);
  const messages = [...history, { role: "user", content: userText }];
  let systemPrompt = buildSystemPrompt(isAdmin);

  if (!isAdmin) {
    const contact = await lookupContact(phone);
    const who = gender.resolve({ arboxGender: contact?.gender, name: contact?.name });
    systemPrompt += `

${gender.promptLine(who, contact?.name)}`;
    if (contact?.source === "member") {
      systemPrompt += `
זה מתאמן קיים אצלנו, לא ליד חדש - לא לשאול שאלות היכרות ולא למכור מנוי.`;
    } else if (contact?.status) {
      systemPrompt += `
הסטטוס שלו ב-Arbox הוא "${contact.status}".`;
    }
  }
  if (!isAdmin && recentAssistantQuestionRun(history)) {
    systemPrompt += `

חשוב מאוד להודעה הזאת בלבד: ההודעה הקודמת שלך כבר הכילה שאלה. בהודעה הזאת אסור לך לשאול שום שאלה -
לא סימן שאלה אחד. רק להגיב למה שנכתב, לתת ערך, ולעצור. השיחה תמשיך מעצמה, והלקוח ירגיש שיחה
ולא תשאול.`;
  }
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
