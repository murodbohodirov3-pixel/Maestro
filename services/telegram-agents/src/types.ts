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
