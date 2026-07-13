import { getConfig } from "../src/config.js";
import { secureEqual } from "../src/telegram.js";
import type { VercelRequest, VercelResponse } from "../src/vercel.js";

const WEBHOOK_URL = "https://maestro-telegram-agents.vercel.app/api/telegram";
const EXPECTED_BOT_USERNAME = "maestro_ai_team_bot";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("[maestro-agents] webhook setup configuration error", error);
    return res.status(503).json({ ok: false, error: "service_not_configured" });
  }

  const header = req.headers["x-maestro-content-secret"];
  const suppliedSecret = Array.isArray(header) ? header[0] : header || "";
  if (!secureEqual(suppliedSecret, config.maestroContentSecret)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const bot = await telegram(config.telegramToken, "getMe");
    if (bot.result?.username !== EXPECTED_BOT_USERNAME) {
      return res.status(409).json({
        ok: false,
        error: "unexpected_bot",
        username: bot.result?.username || null
      });
    }

    const registered = await telegram(config.telegramToken, "setWebhook", {
      url: WEBHOOK_URL,
      secret_token: config.webhookSecret,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
    if (!registered.ok) throw new Error("Telegram rejected setWebhook");

    const info = await telegram(config.telegramToken, "getWebhookInfo");
    return res.status(200).json({
      ok: true,
      bot: `@${bot.result.username}`,
      webhook: info.result?.url || null,
      pendingUpdates: info.result?.pending_update_count || 0,
      lastError: info.result?.last_error_message || null
    });
  } catch (error) {
    console.error("[maestro-agents] webhook setup failed", error);
    return res.status(502).json({ ok: false, error: "telegram_setup_failed" });
  }
}

async function telegram(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed (${response.status})`);
  return await response.json() as {
    ok: boolean;
    result?: { username?: string; url?: string; pending_update_count?: number; last_error_message?: string };
  };
}
