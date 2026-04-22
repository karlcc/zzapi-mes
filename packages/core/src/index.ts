import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas (derived from spec/openapi.yaml)
// ---------------------------------------------------------------------------

export const PingResponseSchema = z.object({
  ok: z.boolean(),
  sap_time: z.string().regex(/^[0-9]{14}$/, "YYYYMMDDHHMMSS"),
});

export const PoResponseSchema = z.object({
  ebeln: z.string().max(10),
  aedat: z.string().regex(/^[0-9]{8}$/, "YYYYMMDD"),
  lifnr: z.string().max(10),
  eindt: z.string().regex(/^[0-9]{8}$/, "YYYYMMDD"),
});

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

// ---------------------------------------------------------------------------
// Inferred TS types (for convenience; the Zod schemas are the source of truth)
// ---------------------------------------------------------------------------

export type PingResponse = z.infer<typeof PingResponseSchema>;
export type PoResponse = z.infer<typeof PoResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Config & error types
// ---------------------------------------------------------------------------

export interface SapClientConfig {
  /** SAP host, e.g. http://sapdev.fastcell.hk:8000 */
  host: string;
  /** SAP client, e.g. 200 */
  client: number;
  /** Basic-auth username */
  user: string;
  /** Basic-auth password */
  password: string;
  /** Request timeout in ms (default 30000) */
  timeout?: number;
}

/** Back-compat alias — existing SDK consumers still reference this name. */
export type ZzapiMesConfig = SapClientConfig;

export class ZzapiMesHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ZzapiMesHttpError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Prepends http:// if the host string has no scheme. */
export function ensureProtocol(host: string): string {
  if (/^https?:\/\//.test(host)) return host;
  return `http://${host}`;
}

// ---------------------------------------------------------------------------
// SAP client (direct ICF access with Basic Auth)
// ---------------------------------------------------------------------------

export class SapClient {
  private host: string;
  private client: number;
  private auth: string;
  private timeout: number;

  constructor(config: SapClientConfig) {
    this.host = ensureProtocol(config.host).replace(/\/+$/, "");
    this.client = config.client;
    this.auth = btoa(`${config.user}:${config.password}`);
    this.timeout = config.timeout ?? 30_000;
  }

  /** Health check — no DB hit, safe for monitoring probes. */
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>({ path: "/sap/bc/zzapi_mes_ping" });
  }

  /** Look up a purchase order by ebeln. */
  async getPo(ebeln: string): Promise<PoResponse> {
    return this.request<PoResponse>({ path: "/sap/bc/zzapi_mes", params: { ebeln } });
  }

  private async request<T>(opts: { path: string; params?: Record<string, string> }): Promise<T> {
    const { path, params = {} } = opts;
    const query = new URLSearchParams({ ...params, "sap-client": String(this.client) });
    const url = `${this.host}${path}?${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${this.auth}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ZzapiMesHttpError(res.status, `Non-JSON response (HTTP ${res.status})`);
    }

    if ("error" in json) {
      throw new ZzapiMesHttpError(res.status, json.error as string);
    }

    return json as T;
  }
}

/** Back-compat alias so existing @zzapi-mes/sdk consumers keep working. */
export const ZzapiMesClient = SapClient;

export { HubClient } from "./hub-client.js";
export type { HubClientConfig } from "./hub-client.js";
