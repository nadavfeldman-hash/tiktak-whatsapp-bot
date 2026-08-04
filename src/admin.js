const express = require("express");
const crypto = require("crypto");
const store = require("./store");
const arbox = require("./arbox");

const router = express.Router();
const sessions = new Set();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf("=");
        return [p.slice(0, idx), decodeURIComponent(p.slice(idx + 1))];
      })
  );
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (cookies.session && sessions.has(cookies.session)) return next();
  res.redirect("/admin");
}

function layout(title, body) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>${title} - TikTak Bot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f7; margin: 0; padding: 24px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 32px; border-bottom: 2px solid #eee; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; margin-top: 8px; }
  th, td { text-align: right; padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  th { background: #fafafa; }
  .card { background: white; border-radius: 8px; padding: 16px; margin-top: 8px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .badge.on { background: #d1fae5; color: #065f46; }
  .badge.off { background: #fee2e2; color: #991b1b; }
  button { cursor: pointer; border: none; border-radius: 6px; padding: 8px 16px; font-size: 14px; }
  .btn-primary { background: #2563eb; color: white; }
  .btn-danger { background: #dc2626; color: white; }
  form.inline { display: inline; }
  input[type=text], input[type=password], textarea { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
  .top { display: flex; justify-content: space-between; align-items: center; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

router.get("/", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session && sessions.has(cookies.session)) return res.redirect("/admin/dashboard");
  res.send(
    layout(
      "התחברות",
      `<div class="card" style="max-width:320px;margin:80px auto;">
        <h1>TikTak Bot - כניסה</h1>
        <form method="POST" action="/admin/login">
          <input type="password" name="password" placeholder="סיסמה" autofocus />
          <div style="margin-top:12px;"><button class="btn-primary" type="submit">כניסה</button></div>
        </form>
      </div>`
    )
  );
});

router.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === process.env.ADMIN_PANEL_PASSWORD) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res.redirect("/admin/dashboard");
  }
  res.redirect("/admin?error=1");
});

router.post("/logout", requireAuth, (req, res) => {
  const cookies = parseCookies(req);
  sessions.delete(cookies.session);
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/admin");
});

router.post("/toggle-automations", express.urlencoded({ extended: false }), requireAuth, (req, res) => {
  const settings = store.getSettings();
  store.setSetting("customerAutomationsEnabled", !settings.customerAutomationsEnabled);
  res.redirect("/admin/dashboard");
});

router.post("/notes/add", express.urlencoded({ extended: false }), requireAuth, (req, res) => {
  const text = (req.body.text || "").trim();
  if (text) store.addAdminNote(text);
  res.redirect("/admin/dashboard");
});

router.get("/dashboard", requireAuth, async (req, res) => {
  const conversations = store.getAllConversations();
  const appointments = store.getAppointments();
  const tickets = store.getTickets();
  const notes = store.getAdminNotes();
  const settings = store.getSettings();

  let arboxSummary = "";
  try {
    const leads = await arbox.getLeads({ limit: 5, sort: "desc" });
    arboxSummary = leads.data
      .map((l) => `<tr><td>${l.first_name || ""} ${l.last_name || ""}</td><td>${l.phone || "-"}</td><td>${l.lead_status || "-"}</td><td>${l.created_time || "-"}</td></tr>`)
      .join("");
  } catch (e) {
    arboxSummary = `<tr><td colspan="4">שגיאה בטעינת לידים מ-ARBOX: ${e.message}</td></tr>`;
  }

  const convRows = Object.entries(conversations)
    .map(([phone, messages]) => {
      const count = messages.length;
      const lastMsg = messages[messages.length - 1];
      let preview = "";
      if (lastMsg) {
        if (typeof lastMsg.content === "string") preview = lastMsg.content;
        else if (Array.isArray(lastMsg.content)) {
          const textBlock = lastMsg.content.find((b) => b.type === "text");
          preview = textBlock ? textBlock.text : "(כלי/מדיה)";
        }
      }
      preview = (preview || "").slice(0, 80).replace(/</g, "&lt;");
      return `<tr><td>${phone}</td><td>${count}</td><td>${preview}</td>
        <td><form class="inline" method="POST" action="/admin/reset-conversation"><input type="hidden" name="phone" value="${phone}"/><button class="btn-danger" type="submit" onclick="return confirm('לאפס את השיחה עם ${phone}?')">איפוס</button></form></td></tr>`;
    })
    .join("");

  const apptRows = appointments
    .slice(-20)
    .reverse()
    .map((a) => `<tr><td>${a.name || "-"}</td><td>${a.phone || "-"}</td><td>${a.date || "-"} ${a.time || ""}</td><td>${a.reason || "-"}</td></tr>`)
    .join("");

  const ticketRows = tickets
    .slice(-20)
    .reverse()
    .map((t) => `<tr><td>${t.subject || "-"}</td><td>${t.phone || "-"}</td><td>${t.priority || "-"}</td><td>${t.status || "-"}</td></tr>`)
    .join("");

  const noteRows = notes
    .slice()
    .reverse()
    .map((n) => `<tr><td>${new Date(n.addedAt).toLocaleString("he-IL")}</td><td>${n.text}</td></tr>`)
    .join("");

  const automationsOn = !!settings.customerAutomationsEnabled;

  res.send(
    layout(
      "לוח בקרה",
      `<div class="top">
        <h1>TikTak Bot - לוח בקרה</h1>
        <form method="POST" action="/admin/logout"><button type="submit">התנתקות</button></form>
      </div>

      <div class="card">
        <div class="top">
          <div>אוטומציות ללקוחות (ימי הולדת, תשלום שנכשל, לידים):
            <span class="badge ${automationsOn ? "on" : "off"}">${automationsOn ? "פעיל" : "כבוי"}</span>
          </div>
          <form method="POST" action="/admin/toggle-automations">
            <button class="${automationsOn ? "btn-danger" : "btn-primary"}" type="submit">${automationsOn ? "כבה" : "הדלק"}</button>
          </form>
        </div>
      </div>

      <h2>לידים אחרונים מ-ARBOX</h2>
      <table><tr><th>שם</th><th>טלפון</th><th>סטטוס</th><th>נוצר</th></tr>${arboxSummary}</table>

      <h2>שיחות וואטסאפ (${Object.keys(conversations).length})</h2>
      <table><tr><th>טלפון</th><th>מס' הודעות</th><th>הודעה אחרונה</th><th></th></tr>${convRows}</table>

      <h2>תורים שנקבעו (20 אחרונים)</h2>
      <table><tr><th>שם</th><th>טלפון</th><th>תאריך/שעה</th><th>סיבה</th></tr>${apptRows}</table>

      <h2>פניות תמיכה (20 אחרונות)</h2>
      <table><tr><th>נושא</th><th>טלפון</th><th>עדיפות</th><th>סטטוס</th></tr>${ticketRows}</table>

      <h2>עדכונים שנלמדו לבוט</h2>
      <table><tr><th>תאריך</th><th>טקסט</th></tr>${noteRows}</table>
      <div class="card">
        <form method="POST" action="/admin/notes/add">
          <textarea name="text" rows="2" placeholder="עדכון חדש לבוט..."></textarea>
          <div style="margin-top:8px;"><button class="btn-primary" type="submit">הוסף</button></div>
        </form>
      </div>
      `
    )
  );
});

router.post("/reset-conversation", express.urlencoded({ extended: false }), requireAuth, (req, res) => {
  if (req.body.phone) store.resetConversation(req.body.phone);
  res.redirect("/admin/dashboard");
});

module.exports = router;
