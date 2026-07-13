export type ReportAction =
  | "business_summary"
  | "master_performance"
  | "finance_report"
  | "debt_summary"
  | "attendance_report"
  | "data_capabilities";

export type SpecialistName =
  | "analyst"
  | "finance"
  | "marketing"
  | "instagram_producer"
  | "crm"
  | "operations"
  | "technical"
  | "controller";

export interface ReportRequest {
  action: ReportAction;
  days?: number;
  from?: string;
  to?: string;
}

export interface MetricPeriod {
  from: string;
  to: string;
  days: number;
}

export interface BusinessMetrics {
  revenue: number;
  clients: number;
  newClients: number;
  returningClients: number;
  unknownClientType: number;
  transactions: number;
  averagePerClient: number;
  averagePerTransaction: number;
  cash: number;
  card: number;
  qr: number;
}

export interface BusinessSummaryReport {
  report: "business_summary";
  period: MetricPeriod;
  previousPeriod: MetricPeriod;
  current: BusinessMetrics;
  previous: BusinessMetrics;
  changePercent: Record<string, number | null>;
  caveats: string[];
}

export type MaestroReport = Record<string, unknown> & {
  report: ReportAction;
  period?: MetricPeriod;
  caveats?: string[];
};

export interface ReelDraft {
  kind: "reel";
  topic: string;
  goal: "views" | "clients" | "revenue" | "retention";
  concept: string;
  hook: string;
  shotList: string[];
  voiceover: string;
  onScreenText: string[];
  higgsfieldPrompt: string;
  negativePrompt: string;
  coverText: string;
  caption: string;
  cta: string;
  stories: string[];
  kpi: string;
}

export interface ContentJob {
  id: number;
  owner_telegram_id: string;
  kind: "reel";
  status: "draft" | "approved" | "generating" | "completed" | "failed" | "cancelled";
  topic: string;
  goal: ReelDraft["goal"];
  concept: string;
  hook: string;
  shot_list: string[];
  voiceover: string;
  on_screen_text: string[];
  higgsfield_prompt: string;
  negative_prompt: string;
  cover_text: string;
  caption: string;
  cta: string;
  stories: string[];
  kpi: string;
  provider: "higgsfield";
  provider_job_id?: string | null;
  result_url?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}
