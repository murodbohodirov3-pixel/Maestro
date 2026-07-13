import { coordinatorPrompt, specialistPrompts } from "./agents.js";
import { getConfig } from "./config.js";
import { getMaestroReport } from "./maestro.js";
import type { ReportAction, SpecialistName } from "./types.js";

interface FunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponseData {
  id: string;
  output_text?: string;
  output?: Array<FunctionCall | {
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}

const periodParameters = {
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      description: "Количество последних календарных дней, включая сегодня"
    }
  },
  required: ["days"],
  additionalProperties: false
};

const tools: ToolDefinition[] = [
  reportTool("get_business_summary", "Сводка выручки, клиентов, среднего чека и сравнение с предыдущим периодом", "business_summary"),
  reportTool("get_master_performance", "Рейтинг и динамика активных мастеров за период", "master_performance"),
  reportTool("get_finance_report", "Выручка, выплаты мастерам, расходы и расчётная прибыль за период", "finance_report"),
  reportTool("get_debt_summary", "Текущие долги, платежи и остатки отдельно по UZS и USD", "debt_summary", false),
  reportTool("get_attendance_report", "Посещаемость, опоздания и штрафы мастеров за период", "attendance_report"),
  {
    type: "function",
    name: "get_data_capabilities",
    description: "Показать, какие данные Maestro доступны и каких данных пока нет",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
  },
  {
    type: "function",
    name: "consult_specialist",
    description: "Привлечь узкого специалиста для независимого анализа проблемы",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        specialist: {
          type: "string",
          enum: ["analyst", "finance", "marketing", "crm", "operations", "technical", "controller"]
        },
        question: { type: "string", minLength: 5, maxLength: 1000 },
        days: { type: "integer", minimum: 1, maximum: 365 }
      },
      required: ["specialist", "question", "days"],
      additionalProperties: false
    }
  }
];

function reportTool(
  name: string,
  description: string,
  action: ReportAction,
  needsPeriod = true
): ToolDefinition {
  return {
    type: "function",
    name,
    description: `${description}. Внутреннее действие: ${action}.`,
    strict: true,
    parameters: needsPeriod
      ? periodParameters
      : { type: "object", properties: {}, required: [], additionalProperties: false }
  };
}

export async function runCoordinator(userText: string): Promise<string> {
  const config = getConfig();
  let input: unknown = `Сообщение владельца:\n${userText}`;
  let previousResponseId: string | undefined;

  for (let round = 0; round < 6; round += 1) {
    const response = await createResponse({
      model: config.coordinatorModel,
      instructions: coordinatorPrompt,
      input,
      tools,
      conversation: config.conversationId,
      previousResponseId
    });

    const calls = (response.output || []).filter(
      (item): item is FunctionCall => item.type === "function_call"
    );
    if (calls.length === 0) return extractText(response);

    const outputs = await Promise.all(calls.slice(0, 4).map(async (call) => ({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(await executeTool(call.name, parseArguments(call.arguments)))
    })));

    input = outputs;
    if (!config.conversationId) previousResponseId = response.id;
  }

  throw new Error("Coordinator exceeded tool-call limit");
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const days = clampDays(args.days);
  const reportActions: Record<string, ReportAction> = {
    get_business_summary: "business_summary",
    get_master_performance: "master_performance",
    get_finance_report: "finance_report",
    get_debt_summary: "debt_summary",
    get_attendance_report: "attendance_report",
    get_data_capabilities: "data_capabilities"
  };

  if (name in reportActions) {
    const action = reportActions[name];
    return getMaestroReport(action === "debt_summary" || action === "data_capabilities"
      ? { action }
      : { action, days });
  }

  if (name === "consult_specialist") {
    const specialist = String(args.specialist || "") as SpecialistName;
    if (!(specialist in specialistPrompts)) throw new Error("Unknown specialist");
    return consultSpecialist(specialist, String(args.question || ""), days);
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function consultSpecialist(
  specialist: SpecialistName,
  question: string,
  days: number
): Promise<{ specialist: SpecialistName; analysis: string }> {
  const actions = specialistReports(specialist);
  const evidence = await Promise.all(actions.map((action) => getMaestroReport(
    action === "debt_summary" || action === "data_capabilities" ? { action } : { action, days }
  )));
  const config = getConfig();
  const response = await createResponse({
    model: config.specialistModel,
    instructions: `${specialistPrompts[specialist]}\nОтвечай по-русски. Используй только приложенные отчёты как факты. Дай вывод, действия, KPI и риски.`,
    input: `Вопрос координатора:\n${question}\n\nПроверенные отчёты Maestro:\n${JSON.stringify(evidence)}`
  });

  return { specialist, analysis: extractText(response) };
}

function specialistReports(specialist: SpecialistName): ReportAction[] {
  switch (specialist) {
    case "finance": return ["business_summary", "finance_report", "debt_summary"];
    case "marketing":
    case "crm": return ["business_summary", "master_performance", "data_capabilities"];
    case "operations": return ["master_performance", "attendance_report"];
    case "technical": return ["data_capabilities"];
    case "controller": return ["business_summary", "master_performance", "finance_report"];
    default: return ["business_summary", "master_performance"];
  }
}

async function createResponse(options: {
  model: string;
  instructions: string;
  input: unknown;
  tools?: ToolDefinition[];
  conversation?: string;
  previousResponseId?: string;
}): Promise<ResponseData> {
  const config = getConfig();
  const body: Record<string, unknown> = {
    model: options.model,
    instructions: options.instructions,
    input: options.input,
    store: true
  };
  if (options.tools) body.tools = options.tools;
  if (options.conversation) body.conversation = options.conversation;
  if (options.previousResponseId) body.previous_response_id = options.previousResponseId;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[maestro-agents] OpenAI request failed", {
      status: response.status,
      body: errorBody.slice(0, 500)
    });
    throw new Error(`OpenAI unavailable (${response.status})`);
  }
  return await response.json() as ResponseData;
}

function extractText(response: ResponseData): string {
  if (response.output_text?.trim()) return response.output_text.trim();
  const text = (response.output || [])
    .flatMap((item) => "content" in item ? item.content || [] : [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Agent returned no text");
  return text;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function clampDays(value: unknown): number {
  const days = Math.trunc(Number(value) || 30);
  return Math.min(Math.max(days, 1), 365);
}
