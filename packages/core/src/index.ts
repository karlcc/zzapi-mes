import { z } from "zod";
import {
  transformEntity,
  ENTITY_MAPPINGS,
} from "./transform/index.js";

export { transformResponse, parseTransformOpts, type TransformOptions } from "./transform/index.js";

/** Response format option */
export type Format = "friendly" | "raw";

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
  /** Enable SAP ICF CSRF token handling for POST requests.
   *  When true, SapClient fetches a CSRF token via GET before the first POST,
   *  caches it, and includes it in subsequent POST requests. If SAP returns 403
   *  (token expired), the token is re-fetched and the POST is retried once. */
  csrf?: boolean;
  /** Response format - defaults to 'friendly' for human-readable field names */
  format?: Format;
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
    const capped = message.length > ERROR_MESSAGE_MAX_LENGTH
      ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH) + "…"
      : message;
    super(capped);
    this.name = "ZzapiMesHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.originalStatus = originalStatus;
  }

  /** JSON serialization — Error properties are non-enumerable by default,
   *  so JSON.stringify(err) produces {}. Include status/retryAfter so
   *  log shippers and CLI error output get useful structured data. */
  toJSON(): { name: string; status: number; message: string; retryAfter?: number; originalStatus?: number } {
    return {
      name: this.name,
      status: this.status,
      message: this.message,
      ...(this.retryAfter !== undefined && { retryAfter: this.retryAfter }),
      ...(this.originalStatus !== undefined && { originalStatus: this.originalStatus }),
    };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Prepends http:// if the host string has no scheme. Rejects query strings and fragments
 *  since this function is for host-only input used in URL interpolation. */
export function ensureProtocol(host: string): string {
  if (!host || !host.trim()) throw new Error("Host must be a non-empty string");
  const trimmed = host.trim();
  // Reject query strings and fragments — they would break path interpolation
  // (e.g. "hub?x=1" + "/ping" → "hub?x=1/ping" is malformed).
  if (trimmed.includes("?")) throw new Error(`Host must not contain a query string — got "${host}"`);
  if (trimmed.includes("#")) throw new Error(`Host must not contain a fragment — got "${host}"`);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) throw new Error(`Protocol-relative URL "${host}" is not supported — use http:// or https://`);
  if (/^[a-z][a-z0-9+]*:\/\//i.test(trimmed) || /^[a-z][a-z0-9+]*:(?!\/\/)/i.test(trimmed)) {
    throw new Error(`Unsupported URL scheme in "${host}" — only http and https are allowed`);
  }
  return `http://${trimmed}`;
}

/** Maximum error message length in characters. Prevents unbounded log/response
 *  size from malicious or misconfigured SAP returning extremely long error strings. */
export const ERROR_MESSAGE_MAX_LENGTH = 1024;

/** Prepends http:// if the host string has no scheme. Rejects query strings and fragments
 *  unbounded res.text() if SAP returns an unexpectedly large payload. */
export const SAP_RESPONSE_MAX_BYTES = 1_048_576;

/** Read a Response body with a size limit. Throws if the body exceeds maxBytes.
 *  Uses Content-Length as a fast path when available, otherwise streams and
 *  counts bytes. This avoids loading an entire oversized response into memory. */
export async function readResponseBody(res: Response, maxBytes: number = SAP_RESPONSE_MAX_BYTES): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ZzapiMesHttpError(502, `SAP response too large (${declared} bytes, limit ${maxBytes})`);
    }
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    const byteLen = new TextEncoder().encode(text).byteLength;
    if (byteLen > maxBytes) {
      throw new ZzapiMesHttpError(502, `SAP response too large (${byteLen} bytes, limit ${maxBytes})`);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => {});
        throw new ZzapiMesHttpError(502, `SAP response too large (>${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZzapiMesHttpError) throw e;
    const text = await res.text();
    const byteLen = new TextEncoder().encode(text).byteLength;
    if (byteLen > maxBytes) {
      throw new ZzapiMesHttpError(502, `SAP response too large (${byteLen} bytes, limit ${maxBytes})`);
    }
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) { text += decoder.decode(chunk, { stream: true }); }
  text += decoder.decode();
  return text;
}

/** Upper bound cap for Retry-After values (1 hour). Prevents absurdly large
 *  values like 999999999s from locking clients out for decades. */
const RETRY_AFTER_CAP = 3600;

/** Parse a Retry-After header value into delta-seconds, or undefined.
 *  Supports both delta-seconds (RFC 7231 §5.2) and HTTP-date formats.
 *  HTTP-date is converted to delta-seconds relative to Date.now().
 *  Values are capped at RETRY_AFTER_CAP to prevent client lock-out. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const n = Number(trimmed);
  // Numeric (delta-seconds) format
  if (Number.isFinite(n) && n > 0) {
    return Math.min(n, RETRY_AFTER_CAP);
  }
  // HTTP-date format (e.g. "Fri, 25 Apr 2026 02:00:00 GMT")
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = Math.ceil((dateMs - Date.now()) / 1000);
    if (delta > 0) {
      return Math.min(delta, RETRY_AFTER_CAP);
    }
    // Past date → already expired, no retry needed
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SAP client (direct ICF access with Basic Auth)
// ---------------------------------------------------------------------------

export class SapClient {
  private host: string;
  private client: number;
  private auth: string;
  private timeout: number;
  private csrfEnabled: boolean;
  private format: Format;
  private csrfToken: string | null = null;
  private onRequest?: SapClientConfig["onRequest"];
  private onResponse?: SapClientConfig["onResponse"];

  constructor(config: SapClientConfig) {
    const resolved = ensureProtocol(config.host).replace(/\/+$/, "");
    // Reject scheme-only URLs like "http://" or "https://" that have no authority.
    // After trim, "http://" becomes "http:" which is not a valid host.
    if (/^https?:$/.test(resolved) || /^https?:\/\/$/.test(ensureProtocol(config.host))) {
      throw new Error(`Host must include a hostname — got "${config.host}"`);
    }
    this.host = resolved;
    this.client = config.client;
    this.auth = btoa(`${config.user}:${config.password}`);
    this.timeout = config.timeout ?? 30_000;
    this.csrfEnabled = config.csrf === true;
    this.format = config.format ?? "friendly";
    this.onRequest = config.onRequest;
    this.onResponse = config.onResponse;
  }

  /** Apply friendly transform to raw SAP response */
  private applyTransform<T>(raw: unknown, entityKey: keyof typeof ENTITY_MAPPINGS): T {
    if (this.format === "raw") {
      return raw as T;
    }
    const mapping = ENTITY_MAPPINGS[entityKey];
    if (!mapping) {
      return raw as T;
    }
    return transformEntity(raw as Record<string, unknown>, mapping) as T;
  }

  /** Health check — no DB hit, safe for monitoring probes. */
  async ping(signal?: AbortSignal): Promise<PingResponse> {
    return this.request<PingResponse>({ path: "/sap/bc/zzapi/mes/ping", signal });
  }

  /** Look up a purchase order by ebeln. */
  async getPo(ebeln: string, opts?: { signal?: AbortSignal }): Promise<PoResponse> {
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/handler", params: { ebeln }, signal: opts?.signal });
    return this.applyTransform<PoResponse>(raw, "po");
  }

  /** Look up a production order by aufnr. */
  async getProdOrder(aufnr: string, opts?: { signal?: AbortSignal }): Promise<ProdOrderResponse> {
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/prod_order", params: { aufnr }, signal: opts?.signal });
    return this.applyTransform<ProdOrderResponse>(raw, "prodOrder");
  }

  /** Look up material master by matnr, optionally filtered by plant. */
  async getMaterial(matnr: string, werks?: string, opts?: { signal?: AbortSignal }): Promise<MaterialResponse> {
    const params: Record<string, string> = { matnr };
    if (werks) params.werks = werks;
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/material", params, signal: opts?.signal });
    return this.applyTransform<MaterialResponse>(raw, "material");
  }

  /** Look up stock/availability for a material at a plant. */
  async getStock(matnr: string, werks: string, lgort?: string, opts?: { signal?: AbortSignal }): Promise<StockResponse> {
    const params: Record<string, string> = { matnr, werks };
    if (lgort) params.lgort = lgort;
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/stock", params, signal: opts?.signal });
    return this.applyTransform<StockResponse>(raw, "stock");
  }

  /** Look up PO line items by ebeln. */
  async getPoItems(ebeln: string, opts?: { signal?: AbortSignal }): Promise<PoItemsResponse> {
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/po_items", params: { ebeln }, signal: opts?.signal });
    return this.applyTransform<PoItemsResponse>(raw, "poItems");
  }

  /** Look up routing/recipe for a material at a plant. */
  async getRouting(matnr: string, werks: string, opts?: { signal?: AbortSignal }): Promise<RoutingResponse> {
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/routing", params: { matnr, werks }, signal: opts?.signal });
    return this.applyTransform<RoutingResponse>(raw, "routing");
  }

  /** Look up work center details. */
  async getWorkCenter(arbpl: string, werks: string, opts?: { signal?: AbortSignal }): Promise<WorkCenterResponse> {
    const raw = await this.request<Record<string, unknown>>({ path: "/sap/bc/zzapi/mes/wc", params: { arbpl, werks }, signal: opts?.signal });
    return this.applyTransform<WorkCenterResponse>(raw, "workCenter");
  }

  /** Post a production order confirmation. */
  async postConfirmation(data: ConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationResponse> {
    return this.postRequest<ConfirmationResponse>("/sap/bc/zzapi/mes/conf", ConfirmationRequestSchema.parse(data), signal);
  }

  /** Post a goods receipt against a purchase order. */
  async postGoodsReceipt(data: GoodsReceiptRequest, signal?: AbortSignal): Promise<GoodsReceiptResponse> {
    return this.postRequest<GoodsReceiptResponse>("/sap/bc/zzapi/mes/gr", GoodsReceiptRequestSchema.parse(data), signal);
  }

  /** Post a goods issue for a production order. */
  async postGoodsIssue(data: GoodsIssueRequest, signal?: AbortSignal): Promise<GoodsIssueResponse> {
    return this.postRequest<GoodsIssueResponse>("/sap/bc/zzapi/mes/gi", GoodsIssueRequestSchema.parse(data), signal);
  }

  private async request<T>(opts: { path: string; params?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
    const { path, params = {}, signal: externalSignal } = opts;
    const query = new URLSearchParams({ ...params, "sap-client": String(this.client) });
    const url = `${this.host}${path}?${query}`;

    this.onRequest?.({ url, method: "GET" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    // Forward external abort to the internal controller
    if (externalSignal?.aborted) {
      controller.abort();
    } else if (externalSignal) {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const start = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${this.auth}` },
        signal: controller.signal,
        redirect: "manual",
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

    return this.interpretSapResponse<T>(res);
  }

  /** Fetch a CSRF token from SAP by issuing a GET request with the
   *  X-CSRF-Token: Fetch header. SAP ICF responds with the token in the
   *  x-csrf-token response header. The token is cached for reuse across
   *  POST requests. */
  private async fetchCsrfToken(signal?: AbortSignal): Promise<void> {
    // Reuse the ping endpoint for CSRF token fetch — any GET endpoint works.
    const path = "/sap/bc/zzapi/mes/ping";
    const query = new URLSearchParams({ "sap-client": String(this.client) });
    const url = `${this.host}${path}?${query}`;

    this.onRequest?.({ url, method: "GET" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    if (signal?.aborted) {
      controller.abort();
    } else if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const start = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Basic ${this.auth}`,
          "X-CSRF-Token": "Fetch",
        },
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ZzapiMesHttpError(408, `CSRF token fetch timeout after ${this.timeout}ms`);
      }
      if (e instanceof TypeError) {
        throw new ZzapiMesHttpError(502, `Network error during CSRF fetch: ${(e as TypeError).message}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    this.onResponse?.({ url, status: res.status, durationMs: performance.now() - start });

    // If the CSRF fetch itself failed (auth error, etc.), propagate the error
    if (res.status >= 400) {
      // Use interpretSapResponse to get the proper error message
      try {
        await this.interpretSapResponse<void>(res);
      } catch (e) {
        throw e;
      }
    }

    const token = res.headers.get("x-csrf-token");
    if (!token) {
      // Token missing — likely CSRF protection not enabled on this ICF node,
      // or SAP didn't return the header. Throw so the caller knows something
      // is wrong rather than sending a POST that will definitely fail.
      throw new ZzapiMesHttpError(502, "SAP did not return x-csrf-token header on Fetch request");
    }
    this.csrfToken = token;
  }

  private async postRequest<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // Fetch CSRF token if enabled and not yet cached
    if (this.csrfEnabled && !this.csrfToken) {
      await this.fetchCsrfToken(signal);
    }

    const result = await this.doPost<T>(path, body, signal);

    // If SAP returns 403 (CSRF token expired), re-fetch token and retry once
    if (this.csrfEnabled && result.status === 403) {
      this.csrfToken = null;
      await this.fetchCsrfToken(signal);
      return this.doPost<T>(path, body, signal).then(res => {
        return this.interpretSapResponse<T>(res);
      });
    }

    return this.interpretSapResponse<T>(result);
  }

  /** Raw POST execution — returns the Response object without interpretation,
   *  so the caller can inspect the status before deciding whether to retry. */
  private async doPost<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const query = new URLSearchParams({ "sap-client": String(this.client) });
    const url = `${this.host}${path}?${query}`;

    this.onRequest?.({ url, method: "POST" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    if (signal?.aborted) {
      controller.abort();
    } else if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const start = performance.now();

    const headers: Record<string, string> = {
      Authorization: `Basic ${this.auth}`,
      "Content-Type": "application/json",
    };
    if (this.csrfToken) {
      headers["X-CSRF-Token"] = this.csrfToken;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        redirect: "manual",
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

    return res;
  }

  /** Shared response interpretation: redirect detection, Content-Type check,
   *  JSON parse, error extraction. Eliminates ~60 lines of duplication between
   *  request() and postRequest(). */
  private async interpretSapResponse<T>(res: Response): Promise<T> {
    // Detect 3xx redirects — SAP ICF may redirect to a login page when the
    // service is not activated. Without this, the redirect body (HTML) causes
    // a confusing "Non-JSON response" error.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "(no Location header)";
      throw new ZzapiMesHttpError(res.status, `SAP redirect (HTTP ${res.status}) → ${location}`);
    }

    // 204 No Content — no body to parse, return empty object.
    // Some servers omit Content-Type on 204; treat as success without JSON parse.
    if (res.status === 204) {
      return {} as T;
    }

    // Validate Content-Type — SAP ICF may return HTML login pages with 200
    // status when the service is not activated or auth fails silently.
    // Without this check, HTML is passed to JSON.parse which produces a
    // confusing "Non-JSON response" error with no hint about the real cause.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new ZzapiMesHttpError(502, `Unexpected Content-Type: ${contentType || "(missing)"}`);
    }

    const bodyText = await readResponseBody(res);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(bodyText);
    } catch {
      // ABAP's zz_cl_json serializer with compress=true omits values for empty
      // fields, producing invalid JSON like {"sakl":} or {"sakl":,} instead of
      // {"sakl":null}. In valid JSON, after a key's closing quote + colon, the
      // next char is always a value start: ", digit, t, f, n, {, or [. If we
      // see }],, right after the colon, it's the ABAP empty-value bug.
      // Only attempt repair on initial parse failure; if repair also fails,
      // report the original error.
      const repaired = bodyText.replace(/":(}|,|\])/g, '":null$1');
      try {
        json = JSON.parse(repaired);
      } catch {
        throw new ZzapiMesHttpError(res.status, `Non-JSON response (HTTP ${res.status})`);
      }
    }

    if ("error" in json) {
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      throw new ZzapiMesHttpError(res.status, json.error as string, retryAfter);
    }
    // ABAP 422 uses "errors" (plural array) instead of "error" (singular string).
    if ("errors" in json) {
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      const arr = json.errors;
      const errorMsg = Array.isArray(arr)
        ? arr.map(e => typeof e === "object" && e !== null && "message" in (e as object) ? (e as { message: string }).message : String(e)).join("; ")
        : String(arr);
      throw new ZzapiMesHttpError(res.status, errorMsg, retryAfter);
    }
    // Safety net: any 4xx/5xx without recognized error field is still an error.
    if (res.status >= 400) {
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      throw new ZzapiMesHttpError(res.status, `SAP error (HTTP ${res.status})`, retryAfter);
    }

    return json as T;
  }
}

/** Back-compat alias so existing @zzapi-mes/sdk consumers keep working. */
export const ZzapiMesClient = SapClient;

export { HubClient } from "./hub-client.js";
export type { HubClientConfig } from "./hub-client.js";
