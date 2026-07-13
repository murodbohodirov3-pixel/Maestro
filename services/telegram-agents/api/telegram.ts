import { handleDirectCommand, normalizeUserRequest } from "../src/commands.js";
import { handleContentCommand } from "../src/content-workflow.js";
import { getConfig } from "../src/config.js";
import { runCoordinator } from "../src/openai.js";
import { secureEqual, sendTelegramMessage, sendTyping } from "../src/telegram.js";
import type { VercelRequest, VercelResponse } from "../src/vercel.js";

interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number };
    from?: { id?: number };
  };
}

const recentUpdates = new Map<number, number>();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("[maestro-agents] configuration error", error);
    return res.status(503).json({ ok: false, error: "service_not_configured" });
  }

  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader || "";
  if (!secureEqual(secret, config.webhookSecret)) {
    return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
  }

  const update = req.body as TelegramUpdate;
  const updateId = update.update_id;
  const chatId = update.message?.chat?.id;
  const fromId = update.message?.from?.id;
  const text = update.message?.text?.trim();

  if (!chatId || !fromId || !text) return res.status(200).json({ ok: true, ignored: true });
  if (String(fromId) !== config.ownerTelegramId) {
    await sendTelegramMessage(chatId, "Доступ запрещён.");
    return res.status(200).json({ ok: true, denied: true });
  }
  if (updateId != null && isDuplicate(updateId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    await sendTyping(chatId);
    const contentAnswer = await handleContentCommand(text);
    const directAnswer = contentAnswer ?? await handleDirectCommand(text);
    const answer = directAnswer ?? await runCoordinator(normalizeUserRequest(text));
    await sendTelegramMessage(chatId, answer);
    return res.status(200).json({ ok: true });
  } catch (error) {
    const reference = updateId == null ? "unknown" : String(updateId);
    console.error("[maestro-agents] request failed", { reference, error });
    await sendTelegramMessage(
      chatId,
      `Не удалось завершить анализ. Данные Maestro не изменялись. Код ошибки: ${reference}.`
    );
    return res.status(200).json({ ok: false, reference });
  }
}

function isDuplicate(updateId: number): boolean {
  const now = Date.now();
  for (const [id, timestamp] of recentUpdates) {
    if (now - timestamp > 10 * 60_000) recentUpdates.delete(id);
  }
  if (recentUpdates.has(updateId)) return true;
  recentUpdates.set(updateId, now);
  return false;
}
