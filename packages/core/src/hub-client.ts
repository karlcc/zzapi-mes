import { ensureProtocol, readResponseBody } from "./index.js";
import type { PingResponse, PoResponse, ProdOrderResponse, MaterialResponse, StockResponse, PoItemsResponse, RoutingResponse, WorkCenterResponse, ConfirmationRequest, ConfirmationResponse, GoodsReceiptRequest, GoodsReceiptResponse, GoodsIssueRequest, GoodsIssueResponse } from "./index.js";
import { ZzapiMesHttpError, parseRetryAfter } from "./index.js";

export interface HubClientConfig {
  /** Hub base URL, e.g. http://localhost:8080 */
  url: string;
  /** API key for obtaining JWT from the hub */
  apiKey: string;
  /** Request timeout in ms (default 30000) */
  timeout?: number;
}

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * Client that talks to the zzapi-mes hub (not SAP directly).
 * Handles JWT acquisition and automatic refresh.
 */
export class HubClient {
  private url: string;
  private apiKey: string;
  private timeout: number;
  private tokenCache: TokenCache | null = null;

  constructor(config: HubClientConfig) {
    if (!config.url || !config.url.trim()) {
      throw new Error("HubClient config.url must be a non-empty string");
    }
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new Error("HubClient config.apiKey must be a non-empty string");
    }
    if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0)) {
      throw new Error(`HubClient config.timeout must be a positive number (got ${config.timeout})`);
    }
    this.url = ensureProtocol(config.url).replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30_000;
  }

  /** Clear cached JWT, forcing re-authentication on the next request. */
  invalidateToken(): void {
    this.tokenCache = null;
  }

  /** Health check via hub. */
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>("/ping");
  }

  /** Look up a purchase order by ebeln via hub. */
  async getPo(ebeln: string): Promise<PoResponse> {
    return this.request<PoResponse>(`/po/${encodeURIComponent(ebeln)}`);
  }

  /** Look up a production order by aufnr via hub. */
  async getProdOrder(aufnr: string): Promise<ProdOrderResponse> {
    return this.request<ProdOrderResponse>(`/prod-order/${encodeURIComponent(aufnr)}`);
  }

  /** Look up material master via hub. */
  async getMaterial(matnr: string, werks?: string): Promise<MaterialResponse> {
    const query = werks ? `?werks=${encodeURIComponent(werks)}` : "";
    return this.request<MaterialResponse>(`/material/${encodeURIComponent(matnr)}${query}`);
  }

  /** Look up stock/availability via hub. */
  async getStock(matnr: string, werks: string, lgort?: string): Promise<StockResponse> {
    const params = new URLSearchParams({ werks });
    if (lgort) params.set("lgort", lgort);
    return this.request<StockResponse>(`/stock/${encodeURIComponent(matnr)}?${params}`);
  }

  /** Look up PO line items via hub. */
  async getPoItems(ebeln: string): Promise<PoItemsResponse> {
    return this.request<PoItemsResponse>(`/po/${encodeURIComponent(ebeln)}/items`);
  }

  /** Look up routing/recipe via hub. */
  async getRouting(matnr: string, werks: string): Promise<RoutingResponse> {
    const params = new URLSearchParams({ werks });
    return this.request<RoutingResponse>(`/routing/${encodeURIComponent(matnr)}?${params}`);
  }

  /** Look up work center via hub. */
  async getWorkCenter(arbpl: string, werks: string): Promise<WorkCenterResponse> {
    const params = new URLSearchParams({ werks });
    return this.request<WorkCenterResponse>(`/work-center/${encodeURIComponent(arbpl)}?${params}`);
  }

  /** Post a production order confirmation. */
  async confirmProduction(data: ConfirmationRequest, idempotencyKey: string): Promise<ConfirmationResponse> {
    return this.postRequest<ConfirmationRequest, ConfirmationResponse>("/confirmation", data, idempotencyKey);
  }

  /** Post a goods receipt against a purchase order. */
  async goodsReceipt(data: GoodsReceiptRequest, idempotencyKey: string): Promise<GoodsReceiptResponse> {
    return this.postRequest<GoodsReceiptRequest, GoodsReceiptResponse>("/goods-receipt", data, idempotencyKey);
  }

  /** Post a goods issue for a production order. */
  async goodsIssue(data: GoodsIssueRequest, idempotencyKey: string): Promise<GoodsIssueResponse> {
    return this.postRequest<GoodsIssueRequest, GoodsIssueResponse>("/goods-issue", data, idempotencyKey);
  }

  // -----------------------------------------------------------------------

  /** Get a valid JWT, refreshing if within 60s of expiry. */
  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const url = `${this.url}/auth/token`;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey }),
    }, "Hub auth request");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ZzapiMesHttpError(res.status, `Hub auth failed: ${body || res.statusText}`);
    }
    const data = (await res.json()) as { token: string; expires_in: number };
    if (!data.token || typeof data.token !== "string") {
      throw new ZzapiMesHttpError(502, "Hub auth response missing token");
    }
    if (!Number.isFinite(data.expires_in) || data.expires_in <= 60) {
      // Guard against pathological server responses that would otherwise
      // cause an immediate re-auth storm (60s refresh window in this client).
      throw new ZzapiMesHttpError(502, `Hub auth returned invalid expires_in: ${data.expires_in}`);
    }
    this.tokenCache = {
      token: data.token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.token;
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.getToken();
    const url = `${this.url}${path}`;
    const res = await this.fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${token}` },
    }, "Hub request");

    // If 401, token may have expired between cache and request — retry once
    if (res.status === 401) {
      this.tokenCache = null;
      const newToken = await this.getToken();
      const retryRes = await this.fetchWithTimeout(url, {
        headers: { authorization: `Bearer ${newToken}` },
      }, "Hub request");
      // If retry also returns 401, add hint so the caller knows a retry was
      // attempted (otherwise looks like a single unexplained auth failure).
      if (retryRes.status === 401) {
        const body = await retryRes.text().catch(() => "");
        const msg = body || retryRes.statusText;
        throw new ZzapiMesHttpError(401, `Hub auth retried, still 401: ${msg}`);
      }
      return this.parseResponse<T>(retryRes);
    }

    return this.parseResponse<T>(res);
  }

  private async postRequest<Req, Res>(path: string, body: Req, idempotencyKey: string): Promise<Res> {
    const token = await this.getToken();
    const url = `${this.url}${path}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    };
    const res = await this.fetchWithTimeout(url, init, "Hub request");

    // If 401, token may have expired — retry once
    if (res.status === 401) {
      this.tokenCache = null;
      const newToken = await this.getToken();
      const retryInit: RequestInit = {
        method: "POST",
        headers: {
          authorization: `Bearer ${newToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      };
      const retryRes = await this.fetchWithTimeout(url, retryInit, "Hub request");
      // If retry also returns 401, add hint so the caller knows a retry was
      // attempted (otherwise looks like a single unexplained auth failure).
      if (retryRes.status === 401) {
        const retryBody = await retryRes.text().catch(() => "");
        const msg = retryBody || retryRes.statusText;
        throw new ZzapiMesHttpError(401, `Hub auth retried, still 401: ${msg}`);
      }
      return this.parseResponse<Res>(retryRes);
    }

    return this.parseResponse<Res>(res);
  }

  /** Shared fetch with timeout and error wrapping. Eliminates duplication between request/postRequest. */
  private async fetchWithTimeout(url: string, init: RequestInit, label: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ZzapiMesHttpError(408, `${label} timeout after ${this.timeout}ms`);
      }
      if (e instanceof TypeError) {
        throw new ZzapiMesHttpError(502, `Hub network error: ${(e as TypeError).message}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const body = await readResponseBody(res);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ZzapiMesHttpError(res.status, `Non-JSON response (HTTP ${res.status})`);
    }
    if (res.status >= 400 && "error" in json) {
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      const originalStatus = res.status === 409 && typeof json.original_status === "number" && json.original_status > 0 ? json.original_status : undefined;
      throw new ZzapiMesHttpError(res.status, json.error as string, retryAfter, originalStatus);
    }
    if (res.status >= 400 && "errors" in json) {
      const arr = json.errors;
      const errorMsg = Array.isArray(arr)
        ? arr.map(e => typeof e === "object" && e !== null && "message" in (e as object) ? (e as { message: string }).message : String(e)).join("; ")
        : String(arr);
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      throw new ZzapiMesHttpError(res.status, errorMsg, retryAfter);
    }
    if (res.status >= 400) {
      throw new ZzapiMesHttpError(res.status, `Hub error (HTTP ${res.status})`);
    }
    return json as T;
  }
}
