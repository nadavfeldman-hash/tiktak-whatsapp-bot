// Lift the blanket protection from leads that sit in a "ללא מענה" status, so
// that changing their status actually produces the follow-up message.
//
// The protection stamped every existing person as recently contacted, which is
// what stops the day's mistakes repeating - but it also blocks the one flow
// Nadav wants to use right now. This removes it for exactly those leads and
// nobody else: members and every other lead stay shielded.
const store = require("./store");
const arbox = require("./arbox");

async function unprotectStatusLeads() {
  const leads = (await arbox.getLeads({ limit: 200 })).data || [];
  const targets = leads.filter((l) => /ללא מענה/.test(l.lead_status || "") && l.phone);

  const state = store.getArboxState();
  const log = { ...(state.sentTemplateLog || {}) };

  let removed = 0;
  for (const lead of targets) {
    const phone = String(lead.phone).replace(/\D/g, "");
    // Only the blanket protection marker - a genuine send stays recorded, so
    // nobody gets the same message twice.
    const key = `${phone}:__protected_at_reset__`;
    if (log[key]) {
      delete log[key];
      removed++;
    }
  }

  // Two leads were marked as already-notified while a guard was silently
  // blocking their message, so they would be skipped forever. Unprotecting
  // someone has to clear that mark too, or nothing changes for them.
  const stillNotified = (state.notifiedLeadNoResponseKeys || []).filter((key) => {
    const userId = String(key).split(":")[0];
    return !targets.some((l) => String(l.user_id) === userId);
  });
  const clearedMarks = (state.notifiedLeadNoResponseKeys || []).length - stillNotified.length;

  // Written directly rather than through the merging setter, which by design
  // never lets this log lose entries.
  const fs = require("fs");
  const path = require("path");
  const file = path.join(store.dataDir, "arbox-state.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...current, sentTemplateLog: log, notifiedLeadNoResponseKeys: stillNotified }, null, 2)
  );

  console.log(`Unprotected ${removed} leads in a "ללא מענה" status, clearing ${clearedMarks} stale notified marks.`);
  return { removed, considered: targets.length, clearedMarks };
}

module.exports = { unprotectStatusLeads };
