// Regression test: runs a fixed set of tricky conversations through the same
// ai.js logic the bot uses live, and flags responses that repeat known past
// mistakes. Run after every knowledge.js/ai.js change: npm run test:scenarios
//
// This is not a strict pass/fail suite - the checks are simple keyword
// heuristics. Always read the printed transcript yourself; the checks just
// point out the specific regressions we've already caught once.

require("dotenv").config();
const ai = require("./ai");
const store = require("./store");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY חסר ב-.env");
  process.exit(1);
}

const SCENARIOS = [
  {
    name: "ליד קר - לא לקפוץ למחיר מוקדם מדי",
    phone: "test-scenario-cold-lead",
    turns: [
      { user: "היי ראיתי אתכם באינסטגרם, מתעניין אולי לנסות" },
      { user: "לא התאמנתי היום, שמעתי שיש לכם משהו עם מסכים" },
      {
        user: "כן, התאמנתי בעבר בחדר כושר רגיל, הפסקתי לפני שנה כי לא היה לי כוח להתמיד",
        checks: [{ type: "notContains", text: 'ש"ח', reason: "לא אמורים להגיע למחיר אחרי שאלה 2-3 בלבד" }],
      },
    ],
  },
  {
    name: "היסוס + נושא צדדי - לא לחזור ללחוץ",
    phone: "test-scenario-hesitation-tangent",
    turns: [
      { user: "היי, מחפש להתחטב, לא מתאמן כרגע" },
      { user: "לא יודע, אחשוב על זה" },
      {
        user: "התייעצתי עם אישתי ונראה",
        checks: [
          { type: "notContains", text: "בוא נקבע", reason: "זה בדיוק הטעות שתפסנו - התלהבות מ'נראה' כאילו זה כן" },
          { type: "notContains", text: "תאריך קונקרטי", reason: "אותו דבר" },
        ],
      },
      {
        user: "תן לי מתכון לפסטה",
        checks: [
          { type: "notContains", text: "מתי מתאים לך", reason: "חזרה ללחוץ אחרי נושא צדדי - זו הייתה השריפה של הליד" },
          { type: "notContains", text: "בוא נקבע", reason: "אותו דבר" },
        ],
      },
    ],
  },
  {
    name: "התנגדות מרחק - לא להסכים שזה רחוק מדי",
    phone: "test-scenario-distance",
    turns: [
      {
        user: "היי, אני גר בגבעת שמואל, לא בטוח ששווה לי לנסוע עד פתח תקווה כל פעם",
        checks: [{ type: "notContains", text: "אתה צודק שזה רחוק", reason: "אמורים למסגר את זה כנגיש, לא להסכים שזה רחוק" }],
      },
    ],
  },
  {
    name: "בקשת ביטול - בלי הבטחת החזר כספי",
    phone: "test-scenario-cancellation",
    turns: [
      {
        user: "אני רוצה לבטל את המנוי שלי ולקבל החזר על החודש הזה",
        checks: [
          { type: "notContains", text: "נחזיר לך", reason: "אין החזרים לפי המדיניות - אסור להבטיח" },
          { type: "notContains", text: "בוודאי נחזיר", reason: "אותו דבר" },
        ],
      },
    ],
  },
  {
    name: "לא להניח מגדר/העדפות מרמזים עקיפים",
    phone: "test-scenario-no-assumptions",
    turns: [
      { user: "ראיתי באינסטגרם" },
      { user: "לא מתאמנת כרגע, בעבר עשיתי פילאטיס" },
      {
        user: "שנה בערך, ולא הרגשתי שינוי גדול",
        checks: [
          { type: "notContains", text: "קבוצת נשים", reason: "אסור להניח שהיא רוצה נשים בלבד רק כי עשתה פילאטיס" },
          { type: "notContains", text: "נשים בלבד", reason: "אותו דבר" },
        ],
      },
    ],
  },
  {
    name: "לקוח אגרסיבי - להישאר רגוע",
    phone: "test-scenario-aggressive",
    turns: [
      {
        user: "אתם גנבים מזוינים, חייבתם אותי שוב בלי רשות, אני אתבע אתכם",
        checks: [
          { type: "notContains", text: "אל תדבר אליי ככה", reason: "לא להגיב באותה אנרגיה/להיעלב" },
          { type: "toolUsed", tool: "create_support_ticket", reason: "צריך עדיין לפתוח פנייה אמיתית לנדב בנושא החיוב" },
        ],
      },
    ],
  },
  {
    name: "בקשת פריסת תשלומים - אין אפשרות כזו",
    phone: "test-scenario-installments",
    turns: [
      {
        user: "אין לי עכשיו את כל הסכום בבת אחת, אפשר לפרוס את זה לכמה תשלומים?",
        checks: [{ type: "notContains", text: "בטח אפשר לפרוס", reason: "אין אפשרות פריסה - אסור להבטיח" }],
      },
    ],
  },
  {
    name: "אדמין נותן כמה תיקונים ארוכים בבת אחת - לא לשבור את השיחה",
    phone: "test-scenario-multi-correction",
    isAdmin: true,
    turns: [
      {
        user:
          "יש לי כמה תיקונים בבת אחת: ראשית, לפני שמציעים אימון ניסיון תמיד לשאול קודם איך ההסבר על המקום נשמע ללקוח. שנית, כשלקוח אומר שהוא צריך לחשוב על זה, לשאול בעדינות על מה בדיוק לפני שמוותרים. שלישית, כשלקוח רוצה להתייעץ עם בן/בת הזוג, לשאול מה הוא חושב שהיא תגיד ולהסביר שכדאי להכיר את המקום קודם. תזכור את כל שלושת אלה לצמיתות.",
        checks: [{ type: "historyValid", reason: "התיקונים לא אמורים להשאיר קריאת-כלי תקועה בלי תוצאה" }],
      },
      {
        user: "עוד משהו - תודה על השיתוף פעולה",
        checks: [{ type: "historyValid", reason: "השיחה אמורה להמשיך כרגיל אחרי סבב התיקונים" }],
      },
    ],
  },
];

function runCheck(check, replyText, phone) {
  if (check.type === "toolUsed") {
    const history = store.getConversation(phone);
    const used = history.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((block) => block.type === "tool_use" && block.name === check.tool)
    );
    return { failed: !used, check };
  }
  if (check.type === "historyValid") {
    const history = store.getConversation(phone);
    const last = history[history.length - 1];
    const dangling =
      last &&
      last.role === "assistant" &&
      Array.isArray(last.content) &&
      last.content.some((block) => block.type === "tool_use");
    return { failed: dangling, check };
  }
  const found = replyText.includes(check.text);
  const failed = check.type === "notContains" ? found : !found;
  return { failed, check };
}

async function runScenario(scenario) {
  console.log(`\n${"=".repeat(60)}\n${scenario.name}\n${"=".repeat(60)}`);
  store.resetConversation(scenario.phone);

  let anyFailed = false;
  for (const turn of scenario.turns) {
    console.log(`\nלקוח: ${turn.user}`);
    let reply;
    try {
      reply = await ai.handleIncomingMessage(scenario.phone, turn.user, !!scenario.isAdmin);
    } catch (err) {
      anyFailed = true;
      console.log(`  ❌ FAIL: קריאה ל-API נכשלה עם שגיאה - ${err.message}`);
      break;
    }
    console.log(`בוט:  ${reply.replace(/\n/g, "\n      ")}`);

    for (const check of turn.checks || []) {
      const { failed } = runCheck(check, reply, scenario.phone);
      if (failed) {
        anyFailed = true;
        console.log(`  ❌ FAIL: ${check.reason}`);
      } else {
        console.log(`  ✅ OK: ${check.reason}`);
      }
    }
  }
  return !anyFailed;
}

async function main() {
  let allPassed = true;
  for (const scenario of SCENARIOS) {
    const passed = await runScenario(scenario);
    allPassed = allPassed && passed;
  }
  console.log(`\n${"=".repeat(60)}`);
  console.log(allPassed ? "כל הבדיקות עברו ✅ (אבל תמיד תקרא את השיחות בעצמך למעלה!)" : "יש כשלים ❌ - תסתכל למעלה על ה-FAIL");
}

main();
