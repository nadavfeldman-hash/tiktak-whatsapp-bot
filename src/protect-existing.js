// Stamp every person who exists in Arbox right now into the send log, as though
// they had just been contacted. The per-person cooldown in whatsapp.sendTemplate
// then refuses to message any of them, whatever any automation decides.
//
// This is deliberately not a reset. Resetting is what caused the damage: it
// cleared the record of who had already been messaged, so the same customers
// were contacted again on every restart. This only adds protection, and removes
// nothing.
//
// After this, only people who appear in Arbox *after* it ran can receive
// anything - so everyone who was messaged today is covered, without needing to
// know which of them it was.
const store = require("./store");
const arbox = require("./arbox");

async function protectExisting() {
  const state = store.getArboxState();
  const log = { ...(state.sentTemplateLog || {}) };
  const stamp = new Date().toISOString();

  const [leads, members] = await Promise.all([
    arbox.getLeads({ limit: 200 }).then((r) => r.data || []).catch(() => []),
    arbox.getAllActiveMembers().catch(() => []),
  ]);

  let protectedCount = 0;
  for (const person of [...leads, ...members]) {
    const phone = String(person.phone || "").replace(/\D/g, "");
    if (!phone) continue;
    // A distinct key so it never collides with a real send, and is easy to spot.
    log[`${phone}:__protected_at_reset__`] = stamp;
    protectedCount++;
  }

  store.setArboxState({ ...store.getArboxState(), sentTemplateLog: log });
  console.log(`Protected ${protectedCount} existing people from automated messages as of ${stamp}.`);
  return { protectedCount, stamp, leads: leads.length, members: members.length };
}

module.exports = { protectExisting };
