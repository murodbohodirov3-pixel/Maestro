import { configuredFeatures } from "../src/config.js";
import type { VercelRequest, VercelResponse } from "../src/vercel.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    service: "maestro-telegram-agents",
    mode: "diagnostics-and-approved-content",
    features: configuredFeatures()
  });
}
