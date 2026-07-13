import { getConfig } from "./config.js";
import type { MaestroReport, ReportRequest } from "./types.js";

export async function getMaestroReport(request: ReportRequest): Promise<MaestroReport> {
  const config = getConfig();
  const response = await fetch(config.maestroReportUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agents-report-secret": config.maestroReportSecret
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("[maestro-agents] report request failed", {
      action: request.action,
      status: response.status,
      body: body.slice(0, 300)
    });
    throw new Error(`Maestro report unavailable (${response.status})`);
  }

  return await response.json() as MaestroReport;
}
