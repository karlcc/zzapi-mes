import { ensureProtocol } from "./index.js";
import type { PingResponse, PoResponse } from "./index.js";
import { ZzapiMesHttpError } from "./index.js";

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
    this.url = ensureProtocol(config.url).replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30_000;
  }

  /** Health check via hub. */
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>("/ping");
  }

  /** Look up a purchase order by ebeln via hub. */
  async getPo(ebeln: string): Promise<PoResponse> {
    return this.request<PoResponse>(`/po/${encodeURIComponent(ebeln)}`);
  }

  // -----------------------------------------------------------------------

  /** Get a valid JWT, refreshing if within 60s of expiry. */
  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const url = `${this.url}/auth/token`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ZzapiMesHttpError(res.status, `Hub auth failed: ${body || res.statusText}`);
    }
    const data = (await res.json()) as { token: string; expires_in: number };
    this.tokenCache = {
      token: data.token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.token;
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.getToken();
    const url = `${this.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // If 401, token may have expired between cache and request — retry once
    if (res.status === 401) {
      this.tokenCache = null;
      const newToken = await this.getToken();
      const retryController = new AbortController();
      const retryTimer = setTimeout(() => retryController.abort(), this.timeout);
      let retryRes: Response;
      try {
        retryRes = await fetch(url, {
          headers: { authorization: `Bearer ${newToken}` },
          signal: retryController.signal,
        });
      } finally {
        clearTimeout(retryTimer);
      }
      return this.parseResponse<T>(retryRes);
    }

    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
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
