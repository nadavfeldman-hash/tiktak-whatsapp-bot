// Hebrew verbs in the second person present tense are gendered, so the bot has
// to decide how to address someone from the very first line. Arbox has a gender
// field but it is filled in for only a handful of people (5 of 55 leads), so the
// first name does most of the work here.
//
// The goal is not to be clever - it is to be right often and to say "unknown"
// the rest of the time, because addressing a woman in the masculine is worse
// than writing neutrally.

const FEMALE = new Set(
  `שירה נועה תמר מיה אביגיל יעל אדל טליה שרה אסתר רבקה לאה רחל מרים חנה דבורה רות נעמי
   מיכל אביבה אורלי גלית ענת סיגל רונית לימור שרון קרן ליאת אורית מירב הילה דנה יעל
   שני עדי רוני אלה נטע גל טל שיר אור ליבי אלינה אנה מריה ויקטוריה אולגה סבטלנה נטליה
   ירדן אביב מור שקד עומר סתיו רותם אמה אריאל נועם יובל דניאל
   חגית אילנה זהבה בתיה שולמית פנינה יפה מזל סימה ציפורה חיה גילה נורית תקווה
   אפרת מעיין שירן מוריה הודיה תהילה אביטל יהודית נחמה בלה דורית סמדר ורד רינת
   אתי אילנית ליאור עינת חן ניצן שחר עדן אגם רוית קטי לנה דיאנה אירינה יוליה`
    .split(/\s+/)
    .filter(Boolean)
);

const MALE = new Set(
  `נדב יוסי דוד משה אברהם יעקב יצחק שמואל דניאל יונתן איתי איתן עידן עומר גיא רון
   אורי אסף ניר עמית תומר גיל ליאור אלון עוז ארז שי דור בר רועי אלירן ליאם נועם יובל
   אריאל אבי חיים ישראל שלמה מרדכי אליהו מאיר יהודה נתן עמוס גדעון אהרון בנימין
   מתן אמיר גור עידו יאיר איל אבנר צחי רן דין ניב סהר רותם אלעד עמרי יהונתן
   סער יהב אביב טל גל שחר עדן ניצן חן שירן ירדן מור שקד סתיו
   אלכס סרגיי דימיטרי איגור מקסים ולדימיר בוריס מיכאל אנטון ארתור`
    .split(/\s+/)
    .filter(Boolean)
);

// Names that read as female by their ending but are male.
const MALE_DESPITE_ENDING = new Set(
  "משה יהודה נחמיה זכריה ירמיה ישעיה עובדיה חנניה עוזיה אליה נתניה שמעיה אריה מיכה יונה שרגא אבישי".split(
    /\s+/
  )
);

function normalize(name) {
  return String(name || "")
    .trim()
    .replace(/["'`]/g, "")
    .split(/\s+/)[0]; // Arbox often stores the full name in first_name
}

// "male" | "female" | "unknown"
function fromName(rawName) {
  const name = normalize(rawName);
  if (!name || !/[֐-׿]/.test(name)) return "unknown";

  if (MALE_DESPITE_ENDING.has(name)) return "male";
  // A name on both lists (Noam, Yuval, Tal...) is genuinely ambiguous.
  const inFemale = FEMALE.has(name);
  const inMale = MALE.has(name);
  if (inFemale && inMale) return "unknown";
  if (inFemale) return "female";
  if (inMale) return "male";

  // Endings, for names not on either list.
  if (/(ית|את|ת)$/.test(name) && name.length > 3) return "female";
  if (/ה$/.test(name) && name.length > 2) return "female";

  return "unknown";
}

// Arbox's own field wins when someone actually set it.
function resolve({ arboxGender, name } = {}) {
  const g = String(arboxGender || "").toLowerCase();
  if (g === "male" || g === "female") return g;
  return fromName(name);
}

// The line handed to the model. Neutral phrasing is the fallback, never a guess.
function promptLine(gender, name) {
  if (gender === "male") {
    return `הלקוח שכותב לך הוא גבר${name ? ` בשם ${name}` : ""} - לכתוב אליו בלשון זכר, בטבעיות.`;
  }
  if (gender === "female") {
    return `הלקוחה שכותבת לך היא אישה${name ? ` בשם ${name}` : ""} - לכתוב אליה בלשון נקבה, בטבעיות. לא בלשון זכר.`;
  }
  return "לא ידוע אם מדובר בגבר או אישה - להקפיד על ניסוח ניטרלי כפי שהוסבר למעלה.";
}

module.exports = { fromName, resolve, promptLine };
