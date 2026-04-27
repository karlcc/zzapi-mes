# Guidance

## Project Overview

zzapi-mes is an SAP ICF REST handler SDK + CLI for MES integration on **SAP_BASIS 700**. The core architectural decision ("Strategy D") is to implement new API endpoints as ABAP classes implementing `IF_HTTP_EXTENSION` and registered via transaction SICF — **deliberately avoiding BSP pages, SE80, and page-attribute/flow-logic plumbing**. Full rationale: `docs/demo-walkthrough.md` and the Obsidian note `zzapi-mes-strategy-d-icf-handler-deep-study.md`.

The existing BSP page `ZMES001.htm` stays as-is; all **new** endpoints go through the ICF handler pattern.

## Repo Layout

- `abap/` — ABAP class source mirrored from SE24. These files are the source of truth in git, but the *running* code lives on the SAP system. They are not "compiled" locally.
- `scripts/smoke.sh` — curl round-trip tests against the deployed handlers on `sapdev.fastcell.hk:8000`. Supports direct and hub mode (`HUB_MODE=1`).
- `docs/demo-walkthrough.md` — step-by-step SE24 + SICF deployment procedure.
- `packages/core/` — `@zzapi-mes/core` — SAP client (`SapClient`), hub client (`HubClient`), Zod schemas, error types, `ALL_SCOPES` constant. Shared by SDK, CLI, and hub.
- `packages/sdk/` — `@zzapi-mes/sdk` — thin re-export of `@zzapi-mes/core`. Back-compat for existing consumers.
- `packages/cli/` — `@zzapi-mes/cli` — CLI with `--mode direct|hub` flag. Both modes support all commands including write-back (confirm, goods-receipt, goods-issue). Direct mode reads `SAP_*` env or `~/.zzapirc`. Hub mode reads `HUB_URL`/`HUB_API_KEY`.
- `spec/openapi.yaml` — OpenAPI 3.0 contract for SAP + hub endpoints.
- `apps/hub/` — `@zzapi-mes/hub` — Hono server. Holds SAP creds server-side, issues JWTs to clients presenting API keys (SQLite-backed, argon2id-hashed). Deploys as systemd unit or Docker container. Admin CLI: `zzapi-mes-hub-admin keys create/list/revoke`, `audit prune --days N`, `idempotency evict --max-age-seconds N`. `--rate-limit` validates positive integer. Backup scripts: `apps/hub/deploy/backup.sh` (Linux), `backup.ps1` (Windows) + systemd timer.
- `Dockerfile` — Multi-stage build for the hub. Uses `pnpm prune --prod` in builder, copies `node_modules` to slim runtime.

## Commands

- `pnpm build` — compile core, SDK, CLI, and hub TypeScript packages.
- `pnpm --filter @zzapi-mes/hub dev` — run the hub locally with tsx watch (reads `HUB_*` + `SAP_*` env).
- `pnpm --filter @zzapi-mes/hub migrate` — apply SQLite migrations before first start / after schema changes.
- `pnpm test` — run unit tests across core + hub + CLI (Node built-in test runner, mocked fetch + in-memory SQLite for hub).
- `pnpm spec:gen` — regenerate Zod schemas from `spec/openapi.yaml` via `scripts/spec-gen.sh` (runs openapi-zod-client then strips zodios code and adds `*Schema` re-exports). CI drift gate checks this.
- `pnpm smoke` — run the curl smoke suite against sapdev. Requires handlers to already be deployed. Override creds/host via env:
  ```
  SAP_USER="${SAP_USER:?required}" SAP_PASS="${SAP_PASS:?required}" SAP_HOST=sapdev.fastcell.hk:8000 pnpm smoke
  ```
  Defaults: `sapdev.fastcell.hk:8000`, client `200`. Exits with the number of failed checks.
  Set `VERBOSE=1` to print response bodies on failure.

## Deployment Model (important for edits to `abap/`)

Editing a file in `abap/` **does not deploy it**. The round-trip is manual:

1. Edit ABAP in SE24 on SAP (typically via `msi-1` Parsec/RDP → SAP GUI for Windows; SE24 also works in Java GUI and Web GUI, unlike SE80).
2. Register/activate the service node in SICF (one-time per endpoint, under `/default_host/sap/bc/`).
3. Mirror the activated source back into `abap/<CLASS>.abap` in the repo and diff to catch SAP-side edits.
4. Run `pnpm smoke` to verify.

When adding a new handler class: follow the naming pattern `ZCL_ZZAPI_MES_*`, place the SICF node at `/sap/bc/zzapi/mes/*`, and add a `check` line to `scripts/smoke.sh`.

## ABAP Handler Conventions

Each handler is a single class implementing `IF_HTTP_EXTENSION` with one method `handle_request`:

- Read HTTP method from `server->request->get_header_field( '~request_method' )`.
- Read query params via `server->request->get_form_field( '<name>' )` (plain names, no BSP `pa_` prefix).
- `CASE lv_method` dispatches verbs; unmatched verbs must return `405` with a JSON error body.
- Set status + `content-type: application/json` + `set_cdata()` for every code path (including 404/405).
- Reuse existing SAP artifacts: structure `ZMES001`, serializer `ZZ_CL_JSON` (camelCase mode). Do not reinvent JSON handling.
- Keep the PO JSON for `/sap/bc/zzapi/mes/handler` byte-identical to what the legacy BSP page emits — the smoke test and downstream MES consumers depend on this.

For multi-endpoint routing under one SICF node, dispatch on `server->request->get_header_field( '~path_info' )` inside `handle_request` rather than registering many SICF nodes.

## Hub Architecture

### Middleware Chain (write-back routes)

Write-back routes (confirmation, goods-receipt, goods-issue) pass through:
1. **Method guard** (`middleware/jwt.ts` — `methodGuard()`) — rejects wrong HTTP methods with 405 before JWT/scope/idempotency checks run
2. **JWT verification** (`middleware/jwt.ts`) — validates Bearer token, extracts `JwtPayload` (typed in `types.ts`: `key_id`, `scopes`, `iat`, `exp`, `rate_limit_per_min`). Rejects tokens with non-number `rate_limit_per_min` (string/boolean) to prevent NaN in rate-limit arithmetic.
3. **Scope enforcement** (`middleware/jwt.ts`) — checks required scope (conf/gr/gi)
4. **Idempotency guard** (`middleware/idempotency.ts`) — requires `Idempotency-Key` header, stores SHA-256 body hash in SQLite. Returns:
   - `409` if same key + same body (true duplicate)
   - `422` if same key + different body (hash mismatch)
5. **Rate limiting** (`middleware/rate-limit.ts`) — per-key token bucket. Rate-limit changes (e.g. updating `rate_limit_per_min` via admin CLI) only take effect on the next `/auth/token` exchange; in-flight buckets are not retroactively updated.
6. **Route handler** — delegates to `withWriteBack()` (`routes/write-back.ts`) which handles Zod validation, SAP call, error mapping, atomic audit+idempotency write, and metrics. Route files are thin wrappers providing schema, SAP method, path, and error-field name.

### CORS

CORS is disabled by default. Set `HUB_CORS_ORIGIN` to a comma-separated list of explicit origins to enable it. `*` is rejected because wildcard origins with credentials is a CSRF vector and browsers reject it anyway. Service-to-service callers (CLI, other backends) don't need CORS. Allowed methods: GET and POST only; credentials enabled.

### Client IP Resolution

`getClientIp()` in `middleware/client-ip.ts` uses `@hono/node-server/conninfo` to get the unspoofable TCP peer address. Headers (`x-real-ip`, `x-forwarded-for`) are only honored when `HUB_TRUSTED_PROXY` is set to a comma-separated list of proxy IPs that match the peer. Without a trusted proxy config, header-based IP spoofing is impossible. The `isLoopbackPeer()` helper checks the real TCP peer for the `/metrics` localhost guard.

### API Documentation

`GET /docs` — public ReDoc HTML page (no JWT required). `GET /openapi.json` — raw spec as JSON. Disable with `HUB_NO_DOCS=1`. CSP headers adjusted for cdn.redoc.ly on `/docs`.

### Startup Validation

The hub validates critical env vars on boot and exits with code 1 on misconfiguration:
- `HUB_JWT_SECRET` must be ≥ 16 chars (short secrets are brute-forceable)
- `HUB_JWT_TTL_SECONDS` must be > 60 (shorter TTLs produce tokens HubClient rejects)
- `HUB_PORT` must be > 0
- `HUB_AUDIT_RETENTION_DAYS` must be > 0 (negative would prune ALL rows)
- `SAP_CLIENT` must be > 0
- `SAP_USER`, `SAP_PASS`, `SAP_HOST` must be set
- `HUB_NO_DOCS` (optional) — set to `1` to disable `/docs` and `/openapi.json`

### Security Headers

All responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. HSTS (`Strict-Transport-Security`) is emitted only when `HUB_HSTS=1` (requires TLS — typically terminated at a reverse proxy). `/auth/token` adds `Cache-Control: no-store`.

### Audit Logging

All hub routes (both GET and POST) write to `audit_log` via `writeAudit()` (POST routes) or `withSapCall()` (GET routes). Entries record `req_id`, `key_id`, `method`, `path`, `sap_status`, `sap_duration_ms`, and (for POST routes) a truncated request body (max 4096 chars). Audit write failures on both GET and POST routes are silently caught so the SAP response is always returned to the client, preventing duplicate retries.

### Scope Definitions

`ALL_SCOPES` in `packages/core/src/index.ts` is the single source of truth: `["ping","po","prod_order","material","stock","routing","work_center","conf","gr","gi"]`. Hub admin CLI and test helpers all import from core.

### Spec Codegen

`spec/openapi.yaml` → `openapi-zod-client` → `packages/core/src/generated/schemas.ts`. The generated file contains zodios code that must be stripped (done by `scripts/spec-gen.sh`). Schema re-exports with `*Schema` suffix are added automatically. **Never hand-edit `schemas.ts`** — always run `pnpm spec:gen`.

### Error Semantics (write-back routes)

| Status | Meaning |
|---|---|
| 201 | Success |
| 400 | Invalid JSON body or missing `Idempotency-Key` |
| 401 | Missing/expired JWT |
| 403 | Insufficient scope |
| 409 | Duplicate idempotency key (same body), or SAP backflush conflict (goods-issue) |
| 422 | Idempotency key reused with different body, or SAP business rule rejection |
| 429 | Rate limit exceeded, or SAP upstream 429 rate-limited (includes `Retry-After` header) |
| 502 | SAP upstream error (non-409/422/429) |

### Path Parameter Validation

All GET route handlers use `validateParam()` from `routes/validate.ts` to enforce: non-empty, alphanumeric-only (`[A-Za-z0-9]+`), and maxLength per parameter. This prevents injection and invalid requests from reaching SAP. Write-back routes validate via Zod schemas instead.

### Response Transform (GET routes)

All 7 business GET routes return a **friendly response** by default via the transform pipeline in `apps/hub/src/transform/`:
- `mappings.ts` — SAP DDIC → human-readable field name tables per entity (7 entities: po, poItems, prodOrder, material, stock, routing, workCenter)
- `transform.ts` — `transformResponse()` wraps result in `{data, _links}` envelope, strips unmapped fields, formats dates (YYYYMMDD → ISO 8601)
- Query params: `?format=raw` bypasses transform (backward compat), `?include=_source` adds original SAP response
- HubClient auto-unwraps the envelope (`parseResponse` detects `data` + `_links` keys) so CLI/SDK consumers see friendly fields directly
- HATEOAS `_links` are included in HTTP API responses but stripped by HubClient — they serve curl/Postman users, not CLI

### SAP Call Helper (GET routes)

All 7 business GET routes delegate to `withSapCall()` in `routes/sap-call.ts`, which wraps:
- Timing (`sap_duration_ms` metric)
- Error mapping (any thrown `ZzapiMesHttpError` → appropriate HTTP status; non-ZzapiMesHttpError → 502). `ZzapiMesHttpError` carries `originalStatus` for 409 duplicates.
- Audit logging (records key_id, path, sap_status, sap_duration_ms)
- `Retry-After` header capture on 429 responses (both `SapClient` and `HubClient` extract it from response headers `parseRetryAfter()`)
- Response transform (`transformResponse()` applies friendly format by default)

## Phase Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Deploy `ZCL_ZZAPI_MES_PING` + `ZCL_ZZAPI_MES_HANDLER`, curl round-trip verified | Done (ping + handler live, 9 additional read/write classes mirrored in `abap/`) |
| 2 | OpenAPI spec, Node SDK, CLI | Done |
| 3 | Hub with JWT auth, SAP auth abstracted | Done |
| 4 | Persistent API keys, admin CLI, request IDs, logs, metrics, rate limiting, spec codegen, e2e tests | Done |
| 5 | MES business endpoints (5A read + 5B write-back with idempotency/audit) | Done |
| 6 | Friendly response transform, ReDoc API docs, field mapping engine | Done |
