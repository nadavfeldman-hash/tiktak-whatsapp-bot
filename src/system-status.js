// Control over this bot is spread across four places - the admin panel, Render's
// environment variables, 360dialog, and Meta - and that is exactly how a
// customer got messaged after the panel toggle said "off": an environment
// variable was quietly overriding it. This gathers the real, effective state of
// every switch into one view, and says where each one actually lives so there is
// no guessing about which knob to turn.
const store = require("./store");
const monitor = require("./arbox-monitor");

const D360_BASE = "https://waba-v2.360dialog.io";

async function d360(path) {
  const key = process.env.D360_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${D360_BASE}${path}`, {
      headers: { "D360-API-KEY": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // a slow or unreachable 360dialog must never break the panel
  }
}

// Can the bot answer someone who writes in? Requires both the switch and a
// webhook that actually points at us - a webhook aimed elsewhere is the silent
// way this breaks.
function autoReplyOn() {
  return process.env.ENABLE_AUTO_REPLY === "true";
}

function automationsEffective() {
  const override = process.env.ENABLE_CUSTOMER_AUTOMATIONS;
  if (override === "false") return false;
  if (override === "true") return true;
  return !!store.getSettings().customerAutomationsEnabled;
}

async function collect() {
  const [webhook, templates, health] = await Promise.all([
    d360("/v1/configs/webhook"),
    d360("/v1/configs/templates?limit=200"),
    d360("/health_status"),
  ]);

  const ourWebhook = `${process.env.RENDER_EXTERNAL_URL || "https://tiktak-whatsapp-bot.onrender.com"}/webhook`;
  const webhookUrl = webhook?.url || null;
  const webhookPointsAtUs = webhookUrl === ourWebhook;

  const tpl = templates?.waba_templates || [];
  const approved = tpl.filter((t) => t.status === "approved").length;
  const pending = tpl.filter((t) => t.status === "pending").length;
  const rejected = tpl.filter((t) => t.status === "rejected").length;

  const entities = health?.health_status?.entities || [];
  const entity = (type) => entities.find((e) => e.entity_type === type);

  // Every check's last outcome, worst first - a failing check is the thing you
  // want to see, not the twelve that are fine.
  const runs = Object.entries(monitor.lastRun || {}).map(([name, r]) => ({ name, ...r }));
  const failing = runs.filter((r) => r.ok === false);

  return {
    // Can a customer who writes in get an answer?
    replies: {
      on: autoReplyOn() && webhookPointsAtUs,
      switchOn: autoReplyOn(),
      webhookUrl,
      webhookPointsAtUs,
      livesIn: "ENABLE_AUTO_REPLY ב-Render, ו-webhook ב-360dialog",
    },
    // Can the bot start conversations on its own?
    automations: {
      on: automationsEffective() && !monitor.HARD_STOP_ACTIVE,
      hardStop: Boolean(monitor.HARD_STOP_ACTIVE),
      envOverride: process.env.ENABLE_CUSTOMER_AUTOMATIONS ?? null,
      storedSetting: !!store.getSettings().customerAutomationsEnabled,
      livesIn: "HARD_STOP בקוד, ENABLE_CUSTOMER_AUTOMATIONS ב-Render, והמתג בפאנל",
    },
    templates: { approved, pending, rejected, total: tpl.length, livesIn: "360dialog" },
    number: {
      canSend: health?.health_status?.can_send_message || null,
      waba: entity("WABA")?.can_send_message || null,
      business: entity("BUSINESS")?.can_send_message || null,
      businessError: entity("BUSINESS")?.errors?.[0]?.error_description || null,
      livesIn: "Meta",
    },
    checks: { total: runs.length, failing },
    arboxConfigured: Boolean(process.env.ARBOX_API_KEY),
  };
}

module.exports = { collect };
