export interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): unknown;
}
