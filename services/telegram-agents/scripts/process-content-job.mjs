import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const jobId = Number(process.argv[2]);
if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error("Usage: npm run content:run -- <job-id>");

const ownerTelegramId = required("OWNER_TELEGRAM_ID");
const contentUrl = `${required("MAESTRO_SUPABASE_URL").replace(/\/$/, "")}/functions/v1/agents-content`;
const contentSecret = required("MAESTRO_CONTENT_SECRET");
const job = await contentRequest({ action: "get", ownerTelegramId, jobId }).then((value) => value.job);

if (!job || job.status !== "approved") {
  throw new Error(`Content job #${jobId} must be approved before generation`);
}

await contentRequest({
  action: "start",
  ownerTelegramId,
  jobId,
  providerJobId: `local-pro-${jobId}-${Date.now()}`
});

try {
  const prompt = [job.higgsfield_prompt, job.negative_prompt ? `Avoid: ${job.negative_prompt}` : ""]
    .filter(Boolean).join("\n\n");
  const output = await runHiggsfield([
    "generate", "create", "seedance_2_0",
    "--prompt", prompt,
    "--aspect_ratio", "9:16",
    "--duration", "10",
    "--resolution", "720p",
    "--mode", "fast",
    "--wait",
    "--wait-timeout", "30m",
    "--json"
  ]);
  const resultUrl = findVideoUrl(JSON.parse(output));
  if (!resultUrl) throw new Error("Higgsfield completed without a video URL");
  await contentRequest({ action: "complete", ownerTelegramId, jobId, resultUrl });
  console.log(resultUrl);
} catch (error) {
  await contentRequest({
    action: "fail",
    ownerTelegramId,
    jobId,
    errorMessage: String(error instanceof Error ? error.message : error).slice(0, 1000)
  }).catch(() => undefined);
  throw error;
}

async function contentRequest(payload) {
  const response = await fetch(contentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agents-content-secret": contentSecret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Content service unavailable (${response.status})`);
  return response.json();
}

function runHiggsfield(args) {
  const executable = findHiggsfieldExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`Higgsfield failed (${code}): ${stderr.trim().slice(0, 500)}`)));
  });
}

function findHiggsfieldExecutable() {
  const explicit = process.env.HIGGSFIELD_CLI_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (process.platform === "win32" && process.env.APPDATA) {
    const candidate = join(process.env.APPDATA, "npm", "node_modules", "@higgsfield", "cli", "vendor", "hf.exe");
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "higgsfield.exe" : "higgsfield";
}

function findVideoUrl(value) {
  if (!value) return null;
  if (typeof value === "string" && /^https:\/\/.+\.(mp4|mov|webm)(\?|$)/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
  }
  return null;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
