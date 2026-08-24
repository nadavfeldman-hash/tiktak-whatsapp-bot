// One-off helper: (re)submits every template in templates.json to Meta through
// 360dialog. Meta rejects any template that has {{n}} placeholders but no
// example values with INVALID_FORMAT, so an example row is generated from the
// number of placeholders each body uses.
const fs = require("fs");
const { execSync } = require("child_process");

const KEY = fs
  .readFileSync(".env", "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("D360_API_KEY="))
  .slice("D360_API_KEY=".length)
  .trim();

const BASE = "https://waba-v2.360dialog.io/v1/configs/templates";
const TMP = "payload.tmp.json";

function api(method, url, body) {
  let cmd = `curl -sS --max-time 30 -X ${method} "${url}" -H "D360-API-KEY: ${KEY}"`;
  if (body) {
    fs.writeFileSync(TMP, JSON.stringify(body));
    cmd += ` -H "Content-Type: application/json" --data-binary @${TMP}`;
  }
  try {
    return JSON.parse(execSync(cmd).toString());
  } catch (e) {
    return { error: { message: String(e.message).slice(0, 120) } };
  }
}

// Plausible sample values, so the reviewer sees a realistic message.
const SAMPLES = ["דנה", "כוח מלא", "19:50", "יוסי", "נדב"];

function exampleFor(body) {
  const count = new Set(body.match(/\{\{(\d+)\}\}/g) || []).size;
  if (count === 0) return null;
  return { body_text: [SAMPLES.slice(0, count)] };
}

const templates = JSON.parse(fs.readFileSync("templates.json", "utf8"));

console.log("=== מוחק תבניות דחויות ===");
const existing = api("GET", BASE).waba_templates || [];
for (const t of existing) {
  if (t.status === "rejected" || t.name.startsWith("zz_")) {
    api("DELETE", `${BASE}/${t.name}`);
    console.log("  נמחק: " + t.name);
  }
}

console.log("");
console.log("=== מגיש " + templates.length + " תבניות ===");
let ok = 0;
const failed = [];
for (const t of templates) {
  const component = { type: "BODY", text: t.body };
  const example = exampleFor(t.body);
  if (example) component.example = example;

  const res = api("POST", BASE, {
    name: t.name,
    category: t.category,
    language: "he",
    components: [component],
  });

  if (res.id) {
    ok++;
    console.log("  OK   " + t.name);
  } else {
    const msg =
      (res.error && (res.error.error_user_msg || res.error.message)) ||
      JSON.stringify(res).slice(0, 150);
    failed.push(t.name + " :: " + msg);
    console.log("  FAIL " + t.name + "  " + msg);
  }
}

if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
console.log("");
console.log("=== " + ok + "/" + templates.length + " הוגשו ===");
if (failed.length) console.log(failed.join("\n"));
