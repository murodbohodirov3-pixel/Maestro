import { getConfig } from "./config.js";

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  const config = getConfig();
  for (const chunk of splitText(text, 3900)) {
    const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Telegram send failed (${response.status})`);
  }
}

export async function sendTyping(chatId: number | string): Promise<void> {
  const config = getConfig();
  await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined);
}

export function splitText(text: string, max: number): string[] {
  const result: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.6) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.6) cut = max;
    result.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) result.push(rest);
  return result;
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
