/** Shared Hono context variables for the hub app. */
export type HubVariables = {
  reqId: string;
  jwtPayload: Record<string, unknown>;
  sapStatus?: number;
  sapDurationMs?: number;
};
