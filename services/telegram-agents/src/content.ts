import { getConfig } from "./config.js";
import type { ContentJob, ReelDraft } from "./types.js";

type ContentAction = "create" | "get" | "list" | "approve" | "cancel" | "start" | "complete" | "fail";

export async function createContentJob(ownerTelegramId: string, draft: ReelDraft): Promise<ContentJob> {
  const result = await request({ action: "create", ownerTelegramId, draft });
  return result.job as ContentJob;
}

export async function getContentJob(ownerTelegramId: string, jobId: number): Promise<ContentJob> {
  const result = await request({ action: "get", ownerTelegramId, jobId });
  return result.job as ContentJob;
}

export async function listContentJobs(ownerTelegramId: string): Promise<ContentJob[]> {
  const result = await request({ action: "list", ownerTelegramId });
  return (result.jobs || []) as ContentJob[];
}

export async function approveContentJob(ownerTelegramId: string, jobId: number): Promise<ContentJob> {
  const result = await request({ action: "approve", ownerTelegramId, jobId });
  return result.job as ContentJob;
}

export async function cancelContentJob(ownerTelegramId: string, jobId: number): Promise<ContentJob> {
  const result = await request({ action: "cancel", ownerTelegramId, jobId });
  return result.job as ContentJob;
}

async function request(payload: Record<string, unknown> & { action: ContentAction }): Promise<Record<string, unknown>> {
  const config = getConfig();
  const response = await fetch(config.maestroContentUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agents-content-secret": config.maestroContentSecret
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("[maestro-agents] content request failed", {
      action: payload.action,
      status: response.status,
      body: body.slice(0, 300)
    });
    throw new Error(`Content jobs unavailable (${response.status})`);
  }
  return await response.json() as Record<string, unknown>;
}
