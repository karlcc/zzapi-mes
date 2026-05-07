# Phase 4 — Operability & Security Hardening

> Status: **shipped**, 2026-04-22. Commit `b96b542`.

## TL;DR

Phases 0/2/3 shipped. Phase 1 is pending user-side SAP GUI deployment.
Before the hub is let anywhere near non-dev clients, it needs persistent API keys,
request correlation, metrics, and rate limiting. This document scopes that work.

No new MES business endpoints (Phase 5) until Phase 4 lands.

## Gaps This Phase Closes

1. **API keys are env strings.** `HUB_API_KEYS=key1,key2` is not a credential
   system — no rotation without restart, no per-key identity or scoping, no
   revocation trail.
2. **No observability.** Plain-text access log, no request IDs, no metrics,
   no correlation with SAP backend call status.
3. **No rate limiting.** A leaked key can drain SAP ICF unnoticed.
4. **Spec ⇄ code drift.** `spec/openapi.yaml` and the zod schemas in
   `packages/core/src/index.ts` are both hand-maintained.
5. **No end-to-end test.** `hub.test.ts` mocks fetch; `scripts/smoke.sh` bypasses
   the hub. The hub ⇄ SAP round trip is untested in CI.
6. **Secret handling guidance absent** from `install.sh` and the env example.

## Scope — 8 Tasks

### 1. Persistent API key store (SQLite)

- Dep: `better-sqlite3`.
- Table: `api_keys(id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT, scopes TEXT, created_at INTEGER, revoked_at INTEGER)`.
- Hash: `argon2id` (preferred) or `scrypt` (no native build).
- Verification: constant-time compare against stored hash.
- Migration: `apps/hub/scripts/migrate.ts`, invoked from `install.sh`.

### 2. Admin CLI

`zzapi-mes-hub-admin` (new binary in `apps/hub`):

```
zzapi-mes-hub-admin keys create --label <str> [--scopes ping,po]
zzapi-mes-hub-admin keys list
zzapi-mes-hub-admin keys revoke <id>
```

`keys create` prints the plaintext key **once**, then never again.

### 3. JWT claims expansion

Add `key_id`, `scopes`, `iat` to the token. Route middleware checks `scopes`
includes the verb for the route (e.g. `po` for `GET /po/:ebeln`).

### 4. Request ID + structured JSON logs

- Middleware `requestId`: echoes `x-request-id` from client, else generates a uuid.
- Replace `middleware/log.ts` with JSON logger:
  `{ts, level, req_id, key_id, method, path, status, latency_ms, sap_status}`.
- `SapClient` grows an optional `onRequest`/`onResponse` hook so the hub can
  thread `req_id` into its SAP call log entries.

### 5. Prometheus `/metrics`

- `prom-client` dep.
- Counters: `zzapi_hub_requests_total{route,status,key_id}`.
- Histograms: `zzapi_hub_request_duration_seconds{route}`,
  `zzapi_hub_sap_duration_seconds{route}`.
- Gauge: `zzapi_hub_process_uptime_seconds`.
- Unauthenticated (scrape from localhost / internal network only).

### 6. Rate limiting

- In-memory token bucket per `key_id`.
- Default `60 req/min`, overridable per-key via DB column `rate_limit_per_min`.
- 429 response with `retry-after`.

### 7. Spec-driven codegen

- Script `pnpm spec:gen` regenerates zod schemas from `spec/openapi.yaml` into
  `packages/core/src/generated/`.
- CI job `spec-drift-check`: regenerate, `git diff --exit-code`.
- Candidate generator: `openapi-zod-client` or `@hey-api/openapi-ts`.

### 8. End-to-end integration test

- `apps/hub/src/test/integration.test.ts`.
- Spin a mock SAP `http.Server` returning canned `ping` + `po` bodies.
- Boot hub in-process against the mock.
- Exercise `POST /auth/token` → `GET /ping` → `GET /po/:ebeln`, assert JWT, req_id echo, metrics increment.

### 9 (bonus). Secret handling doc

- `install.sh` to `chmod 600 /etc/zzapi-mes-hub.env`.
- README section on systemd `LoadCredential` as an alternative to plaintext env.

## PR Slicing

| # | PR title | Tasks |
|---|---|---|
| 1 | `feat(hub): SQLite-backed API key store + admin CLI` | 1, 2, 3 |
| 2 | `feat(hub): request ID + structured JSON logs` | 4 |
| 3 | `feat(hub): /metrics + rate limiting` | 5, 6 |
| 4 | `chore(spec): generate zod from openapi, CI drift gate` | 7 |
| 5 | `test(hub): end-to-end integration suite against mock SAP` | 8 |
| 6 | `docs(hub): secret handling + rotation runbook` | 9 |

PRs 1–3 are load-bearing; 4–6 are hygiene.

## Non-Goals

- New MES business endpoints (PO lines, GR, material master) — Phase 5.
- TLS in the hub — keep terminating at the reverse proxy.
- Multi-tenant isolation — one SAP backend per hub instance.
- Replacing SQLite with Postgres/Redis — premature for a single-node systemd deployment.

## Open Decisions

- **Hashing**: argon2id (preferred) vs. scrypt (no native dep).
- **Scope granularity**: verb-level (`ping`, `po`) vs. finer-grained (`po:read`)
  — recommend starting verb-level, extend later.
- **Token lifetime**: keep 15 min default, add `HUB_JWT_TTL_SECONDS` env override.

## Blockers

- Phase 1 SAP GUI deployment is unrelated but still the bigger gate for
  real-world validation. Phase 4 can proceed in parallel using the mock SAP
  integration harness (task 8).

## Cross-Refs

- Vault review note: `5️⃣-Projects/GitHub/zzapi-mes/zzapi-mes-review-2026-04-22.md`
- `docs/demo-walkthrough.md`
- `docs/hub-framework-decision.md`
- `spec/openapi.yaml`
