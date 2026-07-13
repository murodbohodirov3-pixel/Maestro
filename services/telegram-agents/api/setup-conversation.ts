import { getConfig } from "../src/config.js";
import { secureEqual } from "../src/telegram.js";
import type { VercelRequest, VercelResponse } from "../src/vercel.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("[maestro-agents] conversation setup configuration error", error);
    return res.status(503).json({ ok: false, error: "service_not_configured" });
  }

  const header = req.headers["x-maestro-content-secret"];
  const suppliedSecret = Array.isArray(header) ? header[0] : header || "";
  if (!secureEqual(suppliedSecret, config.maestroContentSecret)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/conversations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ metadata: { product: "maestro-telegram-agents", owner: "primary" } }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`OpenAI conversation create failed (${response.status})`);
    const conversation = await response.json() as { id?: string };
    if (!conversation.id?.startsWith("conv_")) throw new Error("OpenAI returned no conversation id");
    return res.status(201).json({ ok: true, conversationId: conversation.id });
  } catch (error) {
    console.error("[maestro-agents] conversation setup failed", error);
    return res.status(502).json({ ok: false, error: "conversation_setup_failed" });
  }
}
