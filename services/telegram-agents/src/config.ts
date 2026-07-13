export interface AppConfig {
  telegramToken: string;
  webhookSecret: string;
  ownerTelegramId: string;
  openaiApiKey: string;
  coordinatorModel: string;
  specialistModel: string;
  conversationId?: string;
  maestroReportUrl: string;
  maestroReportSecret: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function getConfig(): AppConfig {
  const maestroUrl = required("MAESTRO_SUPABASE_URL").replace(/\/$/, "");

  return {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    ownerTelegramId: required("OWNER_TELEGRAM_ID"),
    openaiApiKey: required("OPENAI_API_KEY"),
    coordinatorModel: process.env.OPENAI_COORDINATOR_MODEL?.trim() || "gpt-5.4",
    specialistModel: process.env.OPENAI_SPECIALIST_MODEL?.trim() || "gpt-5.4-mini",
    conversationId: process.env.OPENAI_CONVERSATION_ID?.trim() || undefined,
    maestroReportUrl: `${maestroUrl}/functions/v1/agents-report`,
    maestroReportSecret: required("MAESTRO_REPORT_SECRET")
  };
}

export function configuredFeatures(): Record<string, boolean> {
  return {
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET),
    owner: Boolean(process.env.OWNER_TELEGRAM_ID),
    openai: Boolean(process.env.OPENAI_API_KEY),
    persistentConversation: Boolean(process.env.OPENAI_CONVERSATION_ID),
    maestroReports: Boolean(process.env.MAESTRO_SUPABASE_URL && process.env.MAESTRO_REPORT_SECRET)
  };
}
