// The coach-swap screen. Kept in its own file rather than inside admin.js
// because it is self-contained, and admin.js is already long.
//
// The preview is not decoration: applying rewrites dozens of real Arbox
// sessions and there is no undo, so what is on screen when you press the button
// is exactly what changes.
const express = require("express");
const arbox = require("./arbox");
const coachSwap = require("./coach-swap");

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function register(router, { requireAuth, layout, sidebar }) {
  router.get("/coaches", requireAuth, async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const date = req.query.date || today;
    const fromTime = req.query.fromTime || "17:00";
    const toTime = req.query.toTime || "22:00";

    let staff = [];
    let preview = { count: 0, sessions: [] };
    let error = null;
    try {
      staff = ((await arbox.getStaffMembers()).data || []).filter((s) => s.active !== 0);
      preview = await coachSwap.preview({ date, fromTime, toTime });
    } catch (e) {
      error = e.message;
    }

    const staffOptions = staff
      .map((s) => {
        const name = [s.first_name, s.last_name].filter(Boolean).join(" ");
        return '<option value="' + esc(s.user_id) + '">' + esc(name) + "</option>";
      })
      .join("");

    const rows = preview.count
      ? preview.sessions
          .map(
            (s) =>
              "<tr><td class=\"mono\">" + esc(s.time) + "</td><td>" + esc(s.name) +
              "</td><td class=\"muted\">" + esc(s.currentCoach) + "</td></tr>"
          )
          .join("")
      : '<tr><td colspan="3"><div class="empty-state">' +
        (error ? esc(error) : "אין שיעורים בטווח הזה") +
        "</div></td></tr>";

    let banner = "";
    if (req.query.swapped) {
      const failedNote =
        req.query.failed && req.query.failed !== "0" ? " · נכשלו: " + esc(req.query.failed) : "";
      banner =
        '<div class="card card-pad" style="margin-bottom:14px;background:var(--green-soft);color:var(--green);">הוחלפו ' +
        esc(req.query.swapped) + " שיעורים." + failedNote + "</div>";
    } else if (req.query.error) {
      banner =
        '<div class="card card-pad" style="margin-bottom:14px;background:var(--red-soft);color:var(--red);">ההחלפה נכשלה. תראה בלוג.</div>';
    }

    const applyForm = preview.count
      ? '<div class="section"><div class="card card-pad">' +
        '<form method="POST" action="/admin/coaches/swap" onsubmit="return confirm(\'להחליף מאמן ב-' +
        preview.count + " שיעורים? אי אפשר לבטל.')\">" +
        '<input type="hidden" name="date" value="' + esc(date) + '">' +
        '<input type="hidden" name="fromTime" value="' + esc(fromTime) + '">' +
        '<input type="hidden" name="toTime" value="' + esc(toTime) + '">' +
        '<div class="toggle-desc" style="margin-bottom:8px">המאמן החדש לכל ' + preview.count +
        " השיעורים שלמעלה</div>" +
        '<select name="newCoachId" required style="padding:10px;border-radius:9px;border:1px solid var(--border);min-width:220px">' +
        '<option value="">בחר מאמן</option>' + staffOptions + "</select>" +
        '<button class="btn-primary" type="submit" style="margin-right:8px">החלף</button>' +
        "</form></div></div>"
      : "";

    const body =
      sidebar("coaches") +
      '<div class="main">' +
      '<div class="page-header"><div><h1 class="page-title">🔄 החלפת מאמן</h1>' +
      '<div class="page-sub">מחליף מאמן בכל השיעורים בטווח שעות, בפעולה אחת</div></div></div>' +
      banner +
      '<div class="section"><div class="card card-pad">' +
      '<form method="GET" action="/admin/coaches" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">' +
      '<div><div class="toggle-desc">תאריך</div><input type="date" name="date" value="' + esc(date) + '" style="max-width:170px"></div>' +
      '<div><div class="toggle-desc">משעה</div><input type="time" name="fromTime" value="' + esc(fromTime) + '" style="max-width:130px"></div>' +
      '<div><div class="toggle-desc">עד שעה</div><input type="time" name="toTime" value="' + esc(toTime) + '" style="max-width:130px"></div>' +
      '<button class="btn-ghost" type="submit">הצג</button>' +
      "</form></div></div>" +
      '<div class="section"><div class="section-header"><div class="section-title">שיעורים בטווח</div>' +
      '<div class="section-count">' + preview.count + "</div></div>" +
      '<div class="card"><table><thead><tr><th>שעה</th><th>אימון</th><th>מאמן נוכחי</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div></div>" +
      applyForm +
      "</div>";

    res.send(layout("החלפת מאמנים", "coaches", body));
  });

  router.post("/coaches/swap", express.urlencoded({ extended: false }), requireAuth, async (req, res) => {
    const { date, fromTime, toTime, newCoachId } = req.body;
    const back =
      "/admin/coaches?date=" + encodeURIComponent(date) +
      "&fromTime=" + encodeURIComponent(fromTime) +
      "&toTime=" + encodeURIComponent(toTime);
    try {
      const r = await coachSwap.apply({ date, fromTime, toTime, newCoachId });
      res.redirect(back + "&swapped=" + r.changed + "&failed=" + r.failed.length);
    } catch (e) {
      console.error("Coach swap failed:", e.message);
      res.redirect(back + "&error=1");
    }
  });
}

module.exports = { register };
