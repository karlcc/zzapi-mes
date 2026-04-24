import type Database from "better-sqlite3";
import type { SapClient } from "@zzapi-mes/core";

/** Decoded JWT payload set by requireJwt middleware. */
export interface JwtPayload {
  key_id: string;
  scopes: string[];
  iat: number;
  exp: number;
  rate_limit_per_min: number | null;
  jti?: string;
  iss?: string;
  aud?: string;
}

/** Shared Hono context variables for the hub app. */
export type HubVariables = {
  reqId: string;
  jwtPayload: JwtPayload;
  sapStatus?: number;
  sapDurationMs?: number;
  idempotencyKey?: string;
  db?: Database.Database;
  sap?: SapClient;
};
