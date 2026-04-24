import promClient, { Registry, collectDefaultMetrics } from "prom-client";

const register = new Registry();

collectDefaultMetrics({ register });

export const requestsTotal = new promClient.Counter({
  name: "zzapi_hub_requests_total",
  help: "Total hub requests",
  labelNames: ["route", "status", "key_id"],
  registers: [register],
});

export const requestDuration = new promClient.Histogram({
  name: "zzapi_hub_request_duration_seconds",
  help: "Hub request duration in seconds",
  labelNames: ["route"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const sapDuration = new promClient.Histogram({
  name: "zzapi_hub_sap_duration_seconds",
  help: "SAP backend call duration in seconds",
  labelNames: ["route"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export { register };
