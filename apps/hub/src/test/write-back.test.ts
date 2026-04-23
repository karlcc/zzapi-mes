import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZzapiMesHttpError } from "@zzapi-mes/core";

// mapSapError is not exported — replicate the logic for isolated unit test.
// This tests the same branches that the route-level tests exercise indirectly,
// but makes each branch explicit and independent.
function mapSapError(e: unknown): { sapStatus: number; clientStatus: number; errorMsg: string; retryAfter?: number } {
  if (e instanceof ZzapiMesHttpError) {
    const sapStatus = e.status;
    const clientStatus = e.status === 409 ? 409 : e.status === 422 ? 422 : e.status === 429 ? 429 : e.status === 408 ? 504 : 502;
    const errorMsg = (e.status === 409 || e.status === 422 || e.status === 429) ? e.message : "SAP upstream error";
    const retryAfter = e.retryAfter;
    return { sapStatus, clientStatus, errorMsg, retryAfter };
  }
  return { sapStatus: 502, clientStatus: 502, errorMsg: "SAP upstream error" };
}

describe("mapSapError all-branches unit test", () => {
  it("409 → clientStatus 409, message preserved", () => {
    const result = mapSapError(new ZzapiMesHttpError(409, "Backflush conflict"));
    assert.equal(result.sapStatus, 409);
    assert.equal(result.clientStatus, 409);
    assert.equal(result.errorMsg, "Backflush conflict");
  });

  it("422 → clientStatus 422, message preserved", () => {
    const result = mapSapError(new ZzapiMesHttpError(422, "No authorization"));
    assert.equal(result.sapStatus, 422);
    assert.equal(result.clientStatus, 422);
    assert.equal(result.errorMsg, "No authorization");
  });

  it("429 → clientStatus 429, message preserved, retryAfter captured", () => {
    const result = mapSapError(new ZzapiMesHttpError(429, "Too many requests", 30));
    assert.equal(result.sapStatus, 429);
    assert.equal(result.clientStatus, 429);
    assert.equal(result.errorMsg, "Too many requests");
    assert.equal(result.retryAfter, 30);
  });

  it("408 → clientStatus 504, message rewritten to 'SAP upstream error'", () => {
    const result = mapSapError(new ZzapiMesHttpError(408, "SAP request timeout"));
    assert.equal(result.sapStatus, 408);
    assert.equal(result.clientStatus, 504);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("other 4xx (e.g. 400) → clientStatus 502, message rewritten", () => {
    const result = mapSapError(new ZzapiMesHttpError(400, "Bad request"));
    assert.equal(result.sapStatus, 400);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("5xx (e.g. 500) → clientStatus 502, message rewritten", () => {
    const result = mapSapError(new ZzapiMesHttpError(500, "Internal server error"));
    assert.equal(result.sapStatus, 500);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("non-ZzapiMesHttpError → clientStatus 502, generic message", () => {
    const result = mapSapError(new Error("network failure"));
    assert.equal(result.sapStatus, 502);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP upstream error");
  });
});
