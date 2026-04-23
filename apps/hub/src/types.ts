/** Shared Hono context variables for the hub app. */
export type HubVariables = {
  reqId: string;
  jwtPayload: Record<string, unknown>;
  sapStatus?: number;
  sapDurationMs?: number;
  idempotencyKey?: string;
  idempotencyBodyHash?: string;
  db?: unknown; // Database.Database — typed loosely to avoid coupling
  sap?: unknown; // SapClient — typed loosely to avoid coupling
};
