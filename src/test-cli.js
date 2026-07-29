// Local chat simulator - talks to the same ai.js logic that runs in
// production, without needing any WhatsApp/Meta credentials.
// Usage: npm run chat

require("dotenv").config();
const readline = require("node:readline");
const ai = require("./ai");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY חסר ב-.env - זה הדבר היחיד שצריך בשביל הבדיקה הזו.");
  process.exit(1);
}

const FAKE_PHONE = "test-user";

console.log("סימולטור צ'אט מקומי (אותה לוגיקה בדיוק כמו בפרודקשן, בלי WhatsApp).");
console.log("הקלד הודעה ולחץ Enter. Ctrl+C ליציאה.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "אתה: " });
rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();

  try {
    const reply = await ai.handleIncomingMessage(FAKE_PHONE, text);
    console.log(`בוט: ${reply}\n`);
  } catch (err) {
    console.error("שגיאה:", err.message);
  }
  rl.prompt();
});
