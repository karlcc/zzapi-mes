import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas (source of truth: spec/openapi.yaml → generated/schemas.ts)
// ---------------------------------------------------------------------------

export {
  PingResponseSchema,
  PoResponseSchema,
  ErrorResponseSchema,
  ProdOrderResponseSchema,
  MaterialResponseSchema,
  StockResponseSchema,
  PoItemsResponseSchema,
  RoutingResponseSchema,
  WorkCenterResponseSchema,
  ConfirmationRequestSchema,
  ConfirmationResponseSchema,
  GoodsReceiptRequestSchema,
  GoodsReceiptResponseSchema,
  GoodsIssueRequestSchema,
  GoodsIssueResponseSchema,
  TokenResponseSchema,
  HealthzResponseSchema,
} from "./generated/schemas.js";

import {
  PingResponseSchema,
  PoResponseSchema,
  ErrorResponseSchema,
  ProdOrderResponseSchema,
  MaterialResponseSchema,
  StockResponseSchema,
  PoItemsResponseSchema,
  RoutingResponseSchema,
  WorkCenterResponseSchema,
  ConfirmationRequestSchema,
  ConfirmationResponseSchema,
  GoodsReceiptRequestSchema,
  GoodsReceiptResponseSchema,
  GoodsIssueRequestSchema,
  GoodsIssueResponseSchema,
  TokenResponseSchema,
  HealthzResponseSchema,
} from "./generated/schemas.js";

// ---------------------------------------------------------------------------
// Inferred TS types (for convenience; the Zod schemas are the source of truth)
// ---------------------------------------------------------------------------

export type PingResponse = z.infer<typeof PingResponseSchema>;
export type PoResponse = z.infer<typeof PoResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type ProdOrderResponse = z.infer<typeof ProdOrderResponseSchema>;
export type MaterialResponse = z.infer<typeof MaterialResponseSchema>;
export type StockResponse = z.infer<typeof StockResponseSchema>;
export type PoItemsResponse = z.infer<typeof PoItemsResponseSchema>;
export type RoutingResponse = z.infer<typeof RoutingResponseSchema>;
export type WorkCenterResponse = z.infer<typeof WorkCenterResponseSchema>;
export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;
export type ConfirmationResponse = z.infer<typeof ConfirmationResponseSchema>;
export type GoodsReceiptRequest = z.infer<typeof GoodsReceiptRequestSchema>;
export type GoodsReceiptResponse = z.infer<typeof GoodsReceiptResponseSchema>;
export type GoodsIssueRequest = z.infer<typeof GoodsIssueRequestSchema>;
export type GoodsIssueResponse = z.infer<typeof GoodsIssueResponseSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

// ---------------------------------------------------------------------------
// Scopes — single source of truth for all authorized scopes
// ---------------------------------------------------------------------------

export const ALL_SCOPES = [
  "ping",
  "po",
  "prod_order",
  "material",
  "stock",
  "routing",
  "work_center",
  "conf",
  "gr",
  "gi",
] as const;

export type Scope = typeof ALL_SCOPES[number];

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
  /** Hook called before each SAP request */
  onRequest?: (ctx: { url: string; method: string }) => void;
  /** Hook called after each SAP response */
  onResponse?: (ctx: { url: string; status: number; durationMs: number }) => void;
}

/** Back-compat alias — existing SDK consumers still reference this name. */
export type ZzapiMesConfig = SapClientConfig;

export class ZzapiMesHttpError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  /** Original HTTP status from a prior idempotency-checked request (409 duplicate only). */
  readonly originalStatus?: number;
  constructor(status: number, message: string, retryAfter?: number, originalStatus?: number) {
    super(message);
    this.name = "ZzapiMesHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.originalStatus = originalStatus;
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
  private onRequest?: SapClientConfig["onRequest"];
  private onResponse?: SapClientConfig["onResponse"];

  constructor(config: SapClientConfig) {
    this.host = ensureProtocol(config.host).replace(/\/+$/, "");
    this.client = config.client;
    this.auth = btoa(`${config.user}:${config.password}`);
    this.timeout = config.timeout ?? 30_000;
    this.onRequest = config.onRequest;
    this.onResponse = config.onResponse;
  }

  /** Health check — no DB hit, safe for monitoring probes. */
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>({ path: "/sap/bc/zzapi/mes/ping" });
  }

  /** Look up a purchase order by ebeln. */
  async getPo(ebeln: string): Promise<PoResponse> {
    return this.request<PoResponse>({ path: "/sap/bc/zzapi/mes/handler", params: { ebeln } });
  }

  /** Look up a production order by aufnr. */
  async getProdOrder(aufnr: string): Promise<ProdOrderResponse> {
    return this.request<ProdOrderResponse>({ path: "/sap/bc/zzapi/mes/prod_order", params: { aufnr } });
  }

  /** Look up material master by matnr, optionally filtered by plant. */
  async getMaterial(matnr: string, werks?: string): Promise<MaterialResponse> {
    const params: Record<string, string> = { matnr };
    if (werks) params.werks = werks;
    return this.request<MaterialResponse>({ path: "/sap/bc/zzapi/mes/material", params });
  }

  /** Look up stock/availability for a material at a plant. */
  async getStock(matnr: string, werks: string, lgort?: string): Promise<StockResponse> {
    const params: Record<string, string> = { matnr, werks };
    if (lgort) params.lgort = lgort;
    return this.request<StockResponse>({ path: "/sap/bc/zzapi/mes/stock", params });
  }

  /** Look up PO line items by ebeln. */
  async getPoItems(ebeln: string): Promise<PoItemsResponse> {
    return this.request<PoItemsResponse>({ path: "/sap/bc/zzapi/mes/po_items", params: { ebeln } });
  }

  /** Look up routing/recipe for a material at a plant. */
  async getRouting(matnr: string, werks: string): Promise<RoutingResponse> {
    return this.request<RoutingResponse>({ path: "/sap/bc/zzapi/mes/routing", params: { matnr, werks } });
  }

  /** Look up work center details. */
  async getWorkCenter(arbpl: string, werks: string): Promise<WorkCenterResponse> {
    return this.request<WorkCenterResponse>({ path: "/sap/bc/zzapi/mes/wc", params: { arbpl, werks } });
  }

  /** Post a production order confirmation. */
  async postConfirmation(data: ConfirmationRequest): Promise<ConfirmationResponse> {
    return this.postRequest<ConfirmationResponse>("/sap/bc/zzapi/mes/conf", data);
  }

  /** Post a goods receipt against a purchase order. */
  async postGoodsReceipt(data: GoodsReceiptRequest): Promise<GoodsReceiptResponse> {
    return this.postRequest<GoodsReceiptResponse>("/sap/bc/zzapi/mes/gr", data);
  }

  /** Post a goods issue for a production order. */
  async postGoodsIssue(data: GoodsIssueRequest): Promise<GoodsIssueResponse> {
    return this.postRequest<GoodsIssueResponse>("/sap/bc/zzapi/mes/gi", data);
  }

  private async request<T>(opts: { path: string; params?: Record<string, string> }): Promise<T> {
    const { path, params = {} } = opts;
    const query = new URLSearchParams({ ...params, "sap-client": String(this.client) });
    const url = `${this.host}${path}?${query}`;

    this.onRequest?.({ url, method: "GET" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const start = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${this.auth}` },
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ZzapiMesHttpError(408, `Request timeout after ${this.timeout}ms`);
      }
      if (e instanceof TypeError) {
        throw new ZzapiMesHttpError(502, `Network error: ${(e as TypeError).message}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    this.onResponse?.({ url, status: res.status, durationMs: performance.now() - start });

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

  private async postRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.host}${path}?sap-client=${this.client}`;

    this.onRequest?.({ url, method: "POST" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const start = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ZzapiMesHttpError(408, `Request timeout after ${this.timeout}ms`);
      }
      if (e instanceof TypeError) {
        throw new ZzapiMesHttpError(502, `Network error: ${(e as TypeError).message}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    this.onResponse?.({ url, status: res.status, durationMs: performance.now() - start });

    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
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
