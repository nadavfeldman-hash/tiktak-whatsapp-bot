const express = require("express");
const crypto = require("crypto");
const store = require("./store");
const arbox = require("./arbox");
const whatsapp = require("./whatsapp");
const systemStatus = require("./system-status");

const router = express.Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function timeAgo(isoOrDateStr) {
  if (!isoOrDateStr) return "-";
  const d = new Date(isoOrDateStr.replace(" ", "T"));
  if (isNaN(d)) return isoOrDateStr;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "עכשיו";
  if (mins < 60) return `לפני ${mins} דק'`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `לפני ${hours} שע'`;
  const days = Math.floor(hours / 24);
  return `לפני ${days} ימים`;
}

function layout(title, activePage, body) {
  const navItem = (href, icon, label, key) =>
    `<a href="${href}" class="nav-item${activePage === key ? " active" : ""}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - TikTak Bot</title>
<style>
  :root {
    --bg: #f4f5f7;
    --surface: #ffffff;
    --border: #e6e8eb;
    --text: #16181d;
    --text-muted: #6b7280;
    --accent: #ff5a1f;
    --accent-dark: #e04a15;
    --accent-soft: #fff1ea;
    --green: #059669;
    --green-soft: #e7f9f1;
    --red: #dc2626;
    --red-soft: #fdecec;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    background: var(--bg);
    margin: 0;
    color: var(--text);
    display: flex;
    min-height: 100vh;
  }
  a { color: inherit; text-decoration: none; }

  /* Sidebar */
  .sidebar {
    width: 220px;
    flex-shrink: 0;
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 6px 10px 22px; }
  .brand-logo { width: 34px; height: 34px; border-radius: 9px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .brand-name { font-weight: 700; font-size: 15px; }
  .brand-sub { font-size: 11px; color: var(--text-muted); }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; font-size: 14px; color: var(--text-muted); font-weight: 500; }
  .nav-item:hover { background: var(--bg); color: var(--text); }
  .nav-item.active { background: var(--accent-soft); color: var(--accent-dark); }
  .nav-icon { font-size: 15px; width: 18px; text-align: center; }
  .sidebar-footer { margin-top: auto; padding-top: 12px; }

  /* Main */
  .main { flex: 1; padding: 26px 32px; max-width: 1180px; }
  .page-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 22px; flex-wrap: wrap; gap: 12px; }
  .page-title { font-size: 22px; font-weight: 700; margin: 0; }
  .page-sub { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

  /* Stat cards */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 26px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); }
  .stat-label { font-size: 12px; color: var(--text-muted); font-weight: 600; }
  .stat-value { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .stat-icon { font-size: 18px; float: left; opacity: .7; }

  /* Cards / sections */
  .section { margin-bottom: 30px; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .section-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .section-count { font-size: 12px; color: var(--text-muted); font-weight: 500; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .card-pad { padding: 18px 20px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: right; padding: 10px 16px; color: var(--text-muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; border-bottom: 1px solid var(--border); background: #fafbfc; }
  td { text-align: right; padding: 11px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #fafbfc; }
  .muted { color: var(--text-muted); }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; direction: ltr; text-align: right; unicode-bidi: plaintext; }
  .empty-state { padding: 34px 20px; text-align: center; color: var(--text-muted); font-size: 13.5px; }

  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.on { background: var(--green-soft); color: var(--green); }
  .badge.off { background: var(--red-soft); color: var(--red); }
  .badge.neutral { background: #f1f2f4; color: var(--text-muted); }
  .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: currentColor; }

  button { cursor: pointer; border: none; border-radius: 9px; padding: 8px 16px; font-size: 13.5px; font-weight: 600; transition: opacity .15s; }
  button:hover { opacity: .88; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-danger { background: var(--red); color: white; }
  .btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  .btn-sm { padding: 5px 11px; font-size: 12.5px; border-radius: 7px; }
  form.inline { display: inline; }

  input[type=text], input[type=password], textarea {
    width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; font-size: 14px;
    font-family: inherit; background: var(--bg);
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; background: white; }
  textarea { resize: vertical; }

  .toggle-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .toggle-desc { font-size: 13px; color: var(--text-muted); margin-top: 2px; max-width: 480px; }

  /* Login page */
  .login-wrap { min-height: 100vh; width: 100%; display: flex; align-items: center; justify-content: center; }
  .login-card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); padding: 36px 32px; width: 100%; max-width: 340px; text-align: center; }
  .login-logo { width: 52px; height: 52px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 26px; margin: 0 auto 14px; }

  @media (max-width: 760px) {
    body { flex-direction: column; }
    .sidebar { width: 100%; flex-direction: row; overflow-x: auto; border-left: none; border-bottom: 1px solid var(--border); padding: 10px; }
    .brand { display: none; }
    .sidebar-footer { display: none; }
    .nav-item { flex-shrink: 0; }
    .main { padding: 18px; }
    table { font-size: 12.5px; }
    th, td { padding: 8px 10px; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function sidebar(activePage) {
  return `<div class="sidebar">
    <div class="brand">
      <div class="brand-logo">🥊</div>
      <div>
        <div class="brand-name">TikTak Bot</div>
        <div class="brand-sub">לוח בקרה</div>
      </div>
    </div>
    <a href="/admin/dashboard" class="nav-item${activePage === "dashboard" ? " active" : ""}"><span class="nav-icon">🏠</span><span>סקירה כללית</span></a>
    <a href="/admin/dashboard#conversations" class="nav-item"><span class="nav-icon">💬</span><span>שיחות</span></a>
    <a href="/admin/dashboard#appointments" class="nav-item"><span class="nav-icon">📅</span><span>תורים</span></a>
    <a href="/admin/dashboard#tickets" class="nav-item"><span class="nav-icon">🎫</span><span>פניות</span></a>
    <a href="/admin/dashboard#notes" class="nav-item"><span class="nav-icon">🧠</span><span>מה הבוט למד</span></a>
    <a href="/admin/dashboard#automations" class="nav-item"><span class="nav-icon">⚙️</span><span>אוטומציות</span></a>
    <a href="/admin/dashboard#broadcast" class="nav-item"><span class="nav-icon">📢</span><span>הודעה כללית</span></a>
    <div class="sidebar-footer">
      <form method="POST" action="/admin/logout"><button class="btn-ghost" style="width:100%" type="submit">התנתקות</button></form>
    </div>
  </div>`;
}

router.get("/", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session && sessions.has(cookies.session)) return res.redirect("/admin/dashboard");
  const error = req.query.error ? `<div style="color:var(--red);font-size:13px;margin-top:10px;">סיסמה שגויה, נסה שוב</div>` : "";
  res.send(
    layout(
      "התחברות",
      "",
      `<div class="login-wrap">
        <div class="login-card">
          <div class="login-logo">🥊</div>
          <div style="font-weight:700;font-size:17px;margin-bottom:2px;">TikTak Bot</div>
          <div class="muted" style="font-size:13px;margin-bottom:20px;">כניסה ללוח הבקרה</div>
          <form method="POST" action="/admin/login">
            <input type="password" name="password" placeholder="סיסמה" autofocus />
            <div style="margin-top:14px;"><button class="btn-primary" style="width:100%" type="submit">כניסה</button></div>
          </form>
          ${error}
        </div>
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

// Wipe everything the bot remembers about customers and restart the clock, all
// in one action - splitting the two is what makes a reset dangerous, because a
// cleared memory with no new starting line means everyone looks new at once.
router.post("/factory-reset", express.urlencoded({ extended: false }), requireAuth, async (req, res) => {
  if ((req.body.confirm || "").trim() !== "אפס") {
    return res.redirect("/admin/dashboard?reset=needsconfirm#danger");
  }
  try {
    const result = await require("./factory-reset").factoryReset();
    res.redirect(`/admin/dashboard?reset=done&suppressed=${result.suppressed}#danger`);
  } catch (e) {
    console.error("Factory reset failed:", e.message);
    res.redirect("/admin/dashboard?reset=error#danger");
  }
});

router.post("/protect-existing", requireAuth, async (req, res) => {
  try {
    const r = await require("./protect-existing").protectExisting();
    res.redirect(`/admin/dashboard?protected=${r.protectedCount}#danger`);
  } catch (e) {
    console.error("Protect existing failed:", e.message);
    res.redirect("/admin/dashboard?protected=error#danger");
  }
});

router.post("/unprotect-status-leads", requireAuth, async (req, res) => {
  try {
    const r = await require("./unprotect-leads").unprotectStatusLeads();
    res.redirect(`/admin/dashboard?unprotected=${r.removed}#danger`);
  } catch (e) {
    console.error("Unprotect failed:", e.message);
    res.redirect("/admin/dashboard?unprotected=error#danger");
  }
});

router.post("/toggle-automations", express.urlencoded({ extended: false }), requireAuth, (req, res) => {
  const settings = store.getSettings();
  store.setSetting("customerAutomationsEnabled", !settings.customerAutomationsEnabled);
  res.redirect("/admin/dashboard#automations");
});

router.post("/notes/add", express.urlencoded({ extended: false }), requireAuth, (req, res) => {
  const text = (req.body.text || "").trim();
  if (text) store.addAdminNote(text);
  res.redirect("/admin/dashboard#notes");
});

router.post("/reset-conversation", express.urlencoded({ extended: false }), requireAuth, (req, res) => {
  if (req.body.phone) store.resetConversation(req.body.phone);
  res.redirect("/admin/dashboard#conversations");
});

router.post("/broadcast", express.urlencoded({ extended: false }), requireAuth, async (req, res) => {
  const text = (req.body.text || "").trim();
  if (!text) return res.redirect("/admin/dashboard?broadcast=empty#broadcast");

  let members;
  try {
    members = await arbox.getAllActiveMembers();
  } catch (e) {
    return res.redirect("/admin/dashboard?broadcast=error#broadcast");
  }
  const recipients = members.filter((m) => m.phone && m.allow_sms !== "no");

  // Respond immediately - sending to potentially hundreds of people, paced to
  // avoid WhatsApp throttling, would otherwise time out the HTTP request.
  res.redirect(`/admin/dashboard?broadcast=started&count=${recipients.length}#broadcast`);

  (async () => {
    let sent = 0;
    for (const member of recipients) {
      try {
        await whatsapp.sendTemplate(member.phone.replace("+", ""), "general_announcement", [text]);
        sent++;
      } catch (e) {
        console.error("Broadcast failed for", member.phone, e.message);
      }
      await sleep(3000);
    }
    console.log(`Broadcast finished: ${sent}/${recipients.length} sent.`);
  })();
});

router.get("/dashboard", requireAuth, async (req, res) => {
  const conversations = store.getAllConversations();
  const appointments = store.getAppointments();
  const tickets = store.getTickets();
  const notes = store.getAdminNotes();
  const settings = store.getSettings();

  let leads = [];
  let arboxError = null;
  try {
    const result = await arbox.getLeads({ limit: 8, sort: "desc" });
    leads = result.data || [];
  } catch (e) {
    arboxError = e.message;
  }

  const today = new Date().toISOString().slice(0, 10);
  const newLeadsToday = leads.filter((l) => (l.created_time || "").startsWith(today)).length;
  const openTickets = tickets.filter((t) => t.status === "open").length;
  const convCount = Object.keys(conversations).length;

  const leadRows = leads.length
    ? leads
        .map(
          (l) => `<tr>
        <td>${esc([l.first_name, l.last_name].filter(Boolean).join(" ") || "(ללא שם)")}</td>
        <td class="mono">${esc(l.phone) || '<span class="muted">-</span>'}</td>
        <td><span class="badge neutral">${esc(l.lead_status) || "-"}</span></td>
        <td class="muted">${esc(l.lead_source) || "-"}</td>
        <td class="muted">${timeAgo(l.created_time)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5"><div class="empty-state">${arboxError ? `שגיאה בטעינה מ-ARBOX: ${esc(arboxError)}` : "אין לידים להצגה"}</div></td></tr>`;

  const convEntries = Object.entries(conversations).sort((a, b) => b[1].length - a[1].length);
  const convRows = convEntries.length
    ? convEntries
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
          preview = esc((preview || "").slice(0, 90));
          return `<tr>
            <td class="mono">${esc(phone)}</td>
            <td><span class="badge neutral">${count} הודעות</span></td>
            <td class="muted">${preview || "-"}</td>
            <td>
              <form class="inline" method="POST" action="/admin/reset-conversation">
                <input type="hidden" name="phone" value="${esc(phone)}"/>
                <button class="btn-ghost btn-sm" type="submit" onclick="return confirm('לאפס את השיחה עם ${esc(phone)}?')">איפוס</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4"><div class="empty-state">אין עדיין שיחות</div></td></tr>`;

  const apptRows = appointments.length
    ? appointments
        .slice(-20)
        .reverse()
        .map(
          (a) => `<tr>
        <td>${esc(a.name) || "-"}</td>
        <td class="mono">${esc(a.phone) || "-"}</td>
        <td>${esc(a.date) || "-"} ${esc(a.time) || ""}</td>
        <td class="muted">${esc(a.reason) || "-"}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4"><div class="empty-state">אין עדיין תורים שנקבעו</div></td></tr>`;

  const ticketRows = tickets.length
    ? tickets
        .slice(-20)
        .reverse()
        .map((t) => {
          const prioClass = t.priority === "high" ? "off" : t.priority === "low" ? "neutral" : "on";
          return `<tr>
        <td>${esc(t.subject) || "-"}</td>
        <td class="mono">${esc(t.phone) || "-"}</td>
        <td><span class="badge ${prioClass}">${esc(t.priority) || "-"}</span></td>
        <td><span class="badge ${t.status === "open" ? "off" : "neutral"}">${esc(t.status) || "-"}</span></td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="4"><div class="empty-state">אין פניות תמיכה</div></td></tr>`;

  const noteRows = notes.length
    ? notes
        .slice()
        .reverse()
        .map(
          (n) => `<tr>
        <td class="muted" style="white-space:nowrap;">${new Date(n.addedAt).toLocaleDateString("he-IL")}</td>
        <td>${esc(n.text)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="2"><div class="empty-state">עדיין לא נלמדו עדכונים</div></td></tr>`;

  const automationsOn = !!settings.customerAutomationsEnabled;

  // The two questions that actually matter - can the bot answer people, and can
  // it start conversations - answered from the real state of every switch
  // rather than from any single one of them.
  let sys = null;
  try {
    sys = await systemStatus.collect();
  } catch (e) {
    console.error("System status failed:", e.message);
  }

  const statusRow = (label, on, detail, where) => `
    <tr>
      <td><strong>${esc(label)}</strong></td>
      <td><span class="badge ${on ? "on" : "off"}"><span class="dot"></span>${on ? "פעיל" : "כבוי"}</span></td>
      <td class="muted">${detail}</td>
      <td class="muted" style="font-size:12px">${esc(where)}</td>
    </tr>`;

  const systemSection = !sys
    ? `<div class="empty-state">לא ניתן היה לקרוא את מצב המערכת כרגע</div>`
    : `<table class="table">
        <thead><tr><th>מה</th><th>מצב</th><th>פירוט</th><th>נשלט מ-</th></tr></thead>
        <tbody>
          ${statusRow(
            "מענה לפניות נכנסות",
            sys.replies.on,
            sys.replies.switchOn
              ? sys.replies.webhookPointsAtUs
                ? "הבוט עונה למי שכותב"
                : "המתג דלוק אך ה-webhook לא מפנה לכאן"
              : "המתג כבוי",
            sys.replies.livesIn
          )}
          ${statusRow(
            "הודעות יזומות (אוטומציות)",
            sys.automations.on,
            sys.automations.hardStop
              ? "עצירה קשה פעילה בקוד - גוברת על הכל"
              : sys.automations.on
                ? "הבוט יוזם פניות ללקוחות"
                : "כבוי",
            sys.automations.livesIn
          )}
          <tr>
            <td><strong>תבניות</strong></td>
            <td><span class="badge ${sys.templates.approved > 0 ? "on" : "off"}"><span class="dot"></span>${sys.templates.approved} מאושרות</span></td>
            <td class="muted">${sys.templates.pending} בבדיקה${sys.templates.rejected ? ` · ${sys.templates.rejected} נדחו` : ""}</td>
            <td class="muted" style="font-size:12px">${esc(sys.templates.livesIn)}</td>
          </tr>
          <tr>
            <td><strong>המספר אצל Meta</strong></td>
            <td><span class="badge ${sys.number.canSend === "AVAILABLE" ? "on" : "neutral"}"><span class="dot"></span>${esc(sys.number.canSend || "לא ידוע")}</span></td>
            <td class="muted">${sys.number.businessError ? esc(sys.number.businessError) : "תקין"}</td>
            <td class="muted" style="font-size:12px">${esc(sys.number.livesIn)}</td>
          </tr>
          ${
            sys.checks.failing.length
              ? sys.checks.failing
                  .map(
                    (f) => `<tr>
                      <td><strong>⚠️ ${esc(f.name)}</strong></td>
                      <td><span class="badge off"><span class="dot"></span>נכשלה</span></td>
                      <td class="muted" colspan="2">${esc(String(f.error).slice(0, 160))}</td>
                    </tr>`
                  )
                  .join("")
              : ""
          }
        </tbody>
      </table>`;

  let broadcastBanner = "";
  if (req.query.broadcast === "started") {
    broadcastBanner = `<div class="card card-pad" style="margin-bottom:14px;background:var(--green-soft);color:var(--green);">נשלח בתהליך ל-${esc(req.query.count)} לקוחות (בקצב איטי, ייקח כמה דקות).</div>`;
  } else if (req.query.broadcast === "empty") {
    broadcastBanner = `<div class="card card-pad" style="margin-bottom:14px;background:var(--red-soft);color:var(--red);">צריך לכתוב טקסט לפני שליחה.</div>`;
  } else if (req.query.broadcast === "error") {
    broadcastBanner = `<div class="card card-pad" style="margin-bottom:14px;background:var(--red-soft);color:var(--red);">שגיאה בטעינת רשימת הלקוחות מ-ARBOX.</div>`;
  }

  res.send(
    layout(
      "סקירה כללית",
      "dashboard",
      `${sidebar("dashboard")}
      <div class="main">
        <div class="page-header">
          <div>
            <h1 class="page-title">היי נדב 👋</h1>
            <div class="page-sub">ככה נראה המצב אצל TikTak Fit עכשיו</div>
          </div>
          <span class="badge ${automationsOn ? "on" : "off"}"><span class="dot"></span>אוטומציות ללקוחות: ${automationsOn ? "פעיל" : "כבוי"}</span>
        </div>

        ${broadcastBanner}

        <div class="stats-grid">
          <div class="stat-card"><div class="stat-icon">💬</div><div class="stat-label">שיחות פעילות</div><div class="stat-value">${convCount}</div></div>
          <div class="stat-card"><div class="stat-icon">✨</div><div class="stat-label">לידים חדשים היום</div><div class="stat-value">${newLeadsToday}</div></div>
          <div class="stat-card"><div class="stat-icon">📅</div><div class="stat-label">תורים שנקבעו</div><div class="stat-value">${appointments.length}</div></div>
          <div class="stat-card"><div class="stat-icon">🎫</div><div class="stat-label">פניות פתוחות</div><div class="stat-value">${openTickets}</div></div>
        </div>

        ${
          req.query.reset === "done"
            ? `<div class="card card-pad" style="margin-bottom:14px;background:var(--green-soft);color:var(--green);">האיפוס הושלם. ${esc(req.query.suppressed || "0")} הודעות שהמצב הקיים היה מפעיל נחסמו ונרשמו כטופלו. מכאן — רק אירועים חדשים.</div>`
            : req.query.reset === "needsconfirm"
              ? `<div class="card card-pad" style="margin-bottom:14px;background:var(--red-soft);color:var(--red);">צריך להקליד את המילה "אפס" כדי לאשר.</div>`
              : req.query.reset === "error"
                ? `<div class="card card-pad" style="margin-bottom:14px;background:var(--red-soft);color:var(--red);">האיפוס נכשל. תראה בלוג.</div>`
                : ""
        }

        <div class="section" id="system">
          <div class="section-header">
            <div class="section-title">🚦 מצב המערכת</div>
            <div class="page-sub" style="margin:0">מה פעיל עכשיו, ואיפה משנים כל דבר</div>
          </div>
          ${systemSection}
        </div>

        <div class="section" id="leads">
          <div class="section-header"><div class="section-title">✨ לידים אחרונים מ-ARBOX</div></div>
          <div class="card"><table><tr><th>שם</th><th>טלפון</th><th>סטטוס</th><th>מקור</th><th>נוצר</th></tr>${leadRows}</table></div>
        </div>

        <div class="section" id="conversations">
          <div class="section-header"><div class="section-title">💬 שיחות וואטסאפ</div><div class="section-count">${convCount} סה"כ</div></div>
          <div class="card"><table><tr><th>טלפון</th><th>הודעות</th><th>הודעה אחרונה</th><th></th></tr>${convRows}</table></div>
        </div>

        <div class="section" id="appointments">
          <div class="section-header"><div class="section-title">📅 תורים שנקבעו</div><div class="section-count">20 אחרונים</div></div>
          <div class="card"><table><tr><th>שם</th><th>טלפון</th><th>תאריך/שעה</th><th>סיבה</th></tr>${apptRows}</table></div>
        </div>

        <div class="section" id="tickets">
          <div class="section-header"><div class="section-title">🎫 פניות תמיכה</div><div class="section-count">20 אחרונות</div></div>
          <div class="card"><table><tr><th>נושא</th><th>טלפון</th><th>עדיפות</th><th>סטטוס</th></tr>${ticketRows}</table></div>
        </div>

        <div class="section" id="notes">
          <div class="section-header"><div class="section-title">🧠 מה הבוט למד ממך</div><div class="section-count">${notes.length} עדכונים</div></div>
          <div class="card">
            <table><tr><th style="width:110px">תאריך</th><th>עדכון</th></tr>${noteRows}</table>
            <div class="card-pad" style="border-top:1px solid var(--border);">
              <form method="POST" action="/admin/notes/add">
                <textarea name="text" rows="2" placeholder="לדוגמה: מעכשיו אל תציע חודש ניסיון, רק אימון בודד..."></textarea>
                <div style="margin-top:10px;"><button class="btn-primary" type="submit">שמור עדכון חדש</button></div>
              </form>
            </div>
          </div>
        </div>

        <div class="section" id="automations">
          <div class="section-header"><div class="section-title">⚙️ אוטומציות ללקוחות</div></div>
          <div class="card card-pad toggle-row">
            <div>
              <div style="font-weight:600;">ימי הולדת, תשלום שנכשל, ליד חדש/אבוד, תזכורות ומעקבים</div>
              <div class="toggle-desc">כשזה פעיל, הבוט שולח הודעות אוטומטיות ישירות ללקוחות על סמך מה שקורה ב-ARBOX - לא רק אליך.</div>
            </div>
            <form method="POST" action="/admin/toggle-automations">
              <button class="${automationsOn ? "btn-danger" : "btn-primary"}" type="submit">${automationsOn ? "כבה אוטומציות" : "הדלק אוטומציות"}</button>
            </form>
          </div>
        </div>

        <div class="section" id="danger">
          <div class="section-header"><div class="section-title">🔄 התחלה מאפס</div></div>
          <div class="card card-pad">
            <div class="toggle-desc" style="margin-bottom:10px;max-width:none;">
              מוחק את כל מה שהבוט זוכר על לקוחות - שיחות, תורים, פניות, ומי כבר קיבל איזו הודעה -
              וקובע את הרגע הזה כנקודת האפס. <strong>אף אחד לא יקבל הודעה על שום דבר שקרה עד עכשיו.</strong>
              מכאן והלאה רק אירועים חדשים: מי שנרשם, מי שנעדר, מי שביטל, מי ששינה סטטוס.
            </div>
            <form method="POST" action="/admin/factory-reset" onsubmit="return confirm('למחוק את כל הזיכרון על הלקוחות ולהתחיל מאפס? אי אפשר לבטל.')">
              <input type="text" name="confirm" placeholder='הקלד "אפס" כדי לאשר' style="max-width:220px" />
              <button class="btn-danger" type="submit" style="margin-right:8px">אפס והתחל מהיום</button>
            </form>
          </div>
        </div>

        <div class="section" id="broadcast">
          <div class="section-header"><div class="section-title">📢 הודעה כללית לכל הלקוחות</div></div>
          <div class="card card-pad">
            <div class="toggle-desc" style="margin-bottom:10px;max-width:none;">נשלח לכל הלקוחות הפעילים שהסכימו לקבל הודעות (allow_sms), בקצב איטי כדי לא להיחסם. אי אפשר לבטל אחרי שליחה - תבדוק היטב לפני.</div>
            <form method="POST" action="/admin/broadcast" onsubmit="return confirm('לשלוח את ההודעה הזו לכל הלקוחות הפעילים? אי אפשר לבטל.')">
              <textarea name="text" rows="3" placeholder="לדוגמה: בשישי הקרוב נפתח שעה מאוחר יותר, 09:00 במקום 08:00"></textarea>
              <div style="margin-top:10px;"><button class="btn-primary" type="submit">שלח לכל הלקוחות</button></div>
            </form>
          </div>
        </div>
      </div>`
    )
  );
});

module.exports = router;
