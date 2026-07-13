import { approveContentJob, cancelContentJob, createContentJob, getContentJob, listContentJobs } from "./content.js";
import { getConfig } from "./config.js";
import { createReelDraft } from "./openai.js";
import type { ContentJob } from "./types.js";

export async function handleContentCommand(text: string): Promise<string | null> {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, "");
  const config = getConfig();

  if (command === "/reel") {
    const topic = text.trim().replace(/^\/reel(?:@\w+)?\s*/i, "").trim();
    const draft = await createReelDraft(topic || "привлечение новых клиентов Maestro");
    const job = await createContentJob(config.ownerTelegramId, draft);
    return formatDraft(job);
  }

  if (command === "/approve") {
    const id = parseJobId(text);
    const job = await approveContentJob(config.ownerTelegramId, id);
    return [
      `✅ Задание #${job.id} подтверждено.`,
      "Оно готово к передаче в Higgsfield, но кредиты ещё не списаны.",
      "Локальный исполнитель запустит генерацию через ваш оплаченный Higgsfield Pro. Статус: /content " + job.id
    ].join("\n");
  }

  if (command === "/cancel") {
    const id = parseJobId(text);
    const job = await cancelContentJob(config.ownerTelegramId, id);
    return `🛑 Задание #${job.id} отменено. Кредиты не списывались.`;
  }

  if (command === "/content") {
    const rawId = text.trim().split(/\s+/)[1];
    if (rawId) return formatStatus(await getContentJob(config.ownerTelegramId, parseJobId(text)));
    const jobs = await listContentJobs(config.ownerTelegramId);
    if (!jobs.length) return "Контент-заданий пока нет. Создайте первое командой /reel <тема>.";
    return ["Последние контент-задания:", ...jobs.map((job) => `#${job.id} · ${statusLabel(job.status)} · ${job.topic}`)].join("\n");
  }

  return null;
}

export function formatDraft(job: ContentJob): string {
  const shots = job.shot_list;
  const screenText = job.on_screen_text;
  return [
    `🎬 Reels #${job.id} — ЧЕРНОВИК`,
    "",
    `Цель: ${job.goal}`,
    `Идея: ${job.concept}`,
    `Хук: ${job.hook}`,
    "",
    "Кадры:",
    ...shots.map((shot, index) => `${index + 1}. ${shot}`),
    "",
    `Озвучка: ${job.voiceover || "без озвучки"}`,
    `Текст на экране: ${screenText.join(" · ") || "нет"}`,
    `Обложка: ${job.cover_text}`,
    "",
    `Подпись: ${job.caption}`,
    `CTA: ${job.cta}`,
    `KPI: ${job.kpi}`,
    "",
    "Higgsfield ещё не запущен.",
    `Подтвердить: /approve ${job.id}`,
    `Отменить: /cancel ${job.id}`
  ].join("\n");
}

export function formatStatus(job: ContentJob): string {
  return [
    `Контент #${job.id}`,
    `Статус: ${statusLabel(job.status)}`,
    `Тема: ${job.topic}`,
    job.result_url ? `Результат: ${job.result_url}` : "Результата пока нет.",
    job.error_message ? `Ошибка: ${job.error_message}` : ""
  ].filter(Boolean).join("\n");
}

export function parseJobId(text: string): number {
  const value = Number(text.trim().split(/\s+/)[1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Укажите номер задания, например /approve 12");
  return value;
}

function statusLabel(status: ContentJob["status"]): string {
  return ({
    draft: "ожидает подтверждения",
    approved: "подтверждено",
    generating: "создаётся в Higgsfield",
    completed: "готово",
    failed: "ошибка",
    cancelled: "отменено"
  })[status];
}
