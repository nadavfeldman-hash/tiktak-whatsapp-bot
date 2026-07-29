# בוט וואטסאפ לשירות לקוחות

בוט וואטסאפ עסקי המבוסס על WhatsApp Cloud API (Meta) ו-Claude (Anthropic) לשיחה חכמה,
מענה לשאלות נפוצות, קביעת תורים ופתיחת פניות תמיכה.

## מה הבוט יודע לעשות

- לענות על שאלות נפוצות לפי המידע ב-[src/knowledge.js](src/knowledge.js)
- לנהל שיחה חופשית עם לקוחות דרך Claude
- לקבוע תורים/פגישות (נשמר ב-`data/appointments.json`)
- לפתוח פניות תמיכה כשאין תשובה זמינה (נשמר ב-`data/tickets.json`)

## התקנה

### 1. התקנת Node.js

Node.js לא מותקן על המחשב הזה. הורד והתקן מ-https://nodejs.org (גרסה 18 ומעלה),
ואז הפעל מחדש את הטרמינל.

### 2. התקנת תלויות הפרויקט

```powershell
cd C:\Users\User\whatsapp-bot
npm install
```

### 3. הגדרת משתני סביבה

העתק את `.env.example` לקובץ בשם `.env` ומלא:

```powershell
Copy-Item .env.example .env
```

- `WHATSAPP_TOKEN` - ה-Access Token מה-App שלך ב-Meta for Developers
- `WHATSAPP_PHONE_NUMBER_ID` - מזהה מספר הטלפון מתוך WhatsApp > API Setup
- `WHATSAPP_VERIFY_TOKEN` - כל מחרוזת שתבחר (תזין את אותה מחרוזת גם בהגדרות ה-Webhook ב-Meta)
- `ANTHROPIC_API_KEY` - מפתח API מ-https://console.anthropic.com

### 4. עריכת מידע העסק

ערוך את [src/knowledge.js](src/knowledge.js) עם שם העסק, שעות פעילות, מדיניות ושאלות נפוצות אמיתיות.
הבוט לא ימציא תשובות שלא מופיעות שם - הוא יפתח פנייה לנציג אנושי במקום.

### 5. הרצה מקומית

```powershell
npm start
```

השרת יאזין על הפורט שהוגדר ב-`.env` (ברירת מחדל 3000).

### 6. חשיפת השרת לאינטרנט (לצורך פיתוח)

Meta צריכה כתובת HTTPS ציבורית כדי לשלוח webhooks. לפיתוח מקומי אפשר להשתמש ב-ngrok:

```powershell
ngrok http 3000
```

קח את כתובת ה-`https://...ngrok...` שתקבל.

### 7. חיבור ה-Webhook ב-Meta for Developers

באפליקציה שלך ב-Meta for Developers > WhatsApp > Configuration:

- Callback URL: `https://<הכתובת-שלך>/webhook`
- Verify Token: אותה מחרוזת מ-`WHATSAPP_VERIFY_TOKEN`
- לחץ Verify and Save
- הירשם (Subscribe) לשדה `messages`

מרגע זה כל הודעה נכנסת תגיע ל-`POST /webhook` והבוט יענה אוטומטית.

## מבנה הפרויקט

```
src/
  index.js      שרת Express + נקודות ה-webhook
  whatsapp.js   שליחה/קבלה מול WhatsApp Cloud API
  ai.js         אינטגרציה עם Claude, כולל כלים לקביעת תור/פתיחת פנייה
  knowledge.js  מידע העסק ושאלות נפוצות - ערוך את זה
  store.js      שמירת שיחות/תורים/פניות כקבצי JSON תחת data/
```

## הערות

- מצב שמירה נוכחי הוא קבצי JSON מקומיים - מספיק להתחלה, לא מתאים לעומס גבוה
  או לפריסה על כמה שרתים (כדאי לשדרג ל-DB אמיתי בהמשך אם צריך).
- הבוט תומך כרגע רק בהודעות טקסט; הודעות מסוג אחר (תמונה, קול וכו') מקבלות מענה כללי.
- אין וולידציה על חתימת ה-webhook (`X-Hub-Signature-256`) - כדאי להוסיף לפני שעולים לפרודקשן.
