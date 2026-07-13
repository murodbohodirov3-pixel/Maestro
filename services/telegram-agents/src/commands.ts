import { getMaestroReport } from "./maestro.js";
import type { BusinessSummaryReport } from "./types.js";

const HELP = `
Команда Maestro готова.

/today — показатели за сегодня
/week — последние 7 дней
/month — последние 30 дней
/problems — найти главные проблемы бизнеса
/help — список команд

Или напишите проблему обычным текстом: «мало клиентов», «упал доход», «кто из мастеров просел?».
`.trim();

export async function handleDirectCommand(text: string): Promise<string | null> {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, "");
  if (command === "/start" || command === "/help") return HELP;

  const days = command === "/today" ? 1 : command === "/week" ? 7 : command === "/month" ? 30 : null;
  if (!days) return null;

  const report = await getMaestroReport({ action: "business_summary", days }) as unknown as BusinessSummaryReport;
  return formatBusinessSummary(report);
}

export function normalizeUserRequest(text: string): string {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, "");
  if (command === "/problems") {
    return "Найди три главные проблемы бизнеса за последние 30 дней. Сначала изучи показатели, мастеров и финансы, затем подключи контролёра. Дай приоритетный план на 14 дней.";
  }
  return text.trim();
}

function money(value: number): string {
  return Math.round(value || 0).toLocaleString("ru-RU");
}

function delta(value: number | null | undefined): string {
  if (value == null) return "нет базы сравнения";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatBusinessSummary(report: BusinessSummaryReport): string {
  const { current, changePercent, period } = report;
  return [
    `📊 Maestro: ${period.from} — ${period.to}`,
    "",
    `Выручка: ${money(current.revenue)} сум (${delta(changePercent.revenue)})`,
    `Клиенты: ${current.clients} (${delta(changePercent.clients)})`,
    `Новые: ${current.newClients} · постоянные: ${current.returningClients}`,
    `Средний чек на клиента: ${money(current.averagePerClient)} сум (${delta(changePercent.averagePerClient)})`,
    `Продаж: ${current.transactions}`,
    "",
    `Оплата: наличные ${money(current.cash)} · карта ${money(current.card)} · QR ${money(current.qr)}`,
    "",
    "Сравнение выполнено с предыдущим периодом такой же длины."
  ].join("\n");
}
