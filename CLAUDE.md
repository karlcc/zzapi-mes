# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

zzapi-mes is an SAP ICF REST handler SDK + CLI for MES integration on **SAP_BASIS 700**. The core architectural decision ("Strategy D") is to implement new API endpoints as ABAP classes implementing `IF_HTTP_EXTENSION` and registered via transaction SICF — **deliberately avoiding BSP pages, SE80, and page-attribute/flow-logic plumbing**. Full rationale: `docs/demo-walkthrough.md` and the Obsidian note `zzapi-mes-strategy-d-icf-handler-deep-study.md`.

The existing BSP page `ZMES001.htm` stays as-is; all **new** endpoints go through the ICF handler pattern.

## Repo Layout (what's actually here vs. planned)

- `abap/` — ABAP class source mirrored from SE24. These files are the source of truth in git, but the *running* code lives on the SAP system. They are not "compiled" locally.
- `scripts/smoke.sh` — curl round-trip tests against the deployed handlers on `sapdev.fastcell.hk:8000`.
- `docs/demo-walkthrough.md` — step-by-step SE24 + SICF deployment procedure.
- `packages/core/` — `@zzapi-mes/core` — SAP client (`SapClient`), Zod schemas, error types, `HubClient`. Shared by SDK, CLI, and hub.
- `packages/sdk/` — `@zzapi-mes/sdk` — thin re-export of `@zzapi-mes/core`. Back-compat for existing consumers.
- `packages/cli/` — `@zzapi-mes/cli` — CLI (`zzapi-mes ping`, `zzapi-mes po <ebeln>`). Supports `--mode direct|hub` flag. Direct mode reads `SAP_*` env or `~/.zzapirc`. Hub mode reads `HUB_URL`/`HUB_API_KEY`.
- `spec/openapi.yaml` — OpenAPI 3.0 contract for SAP + hub endpoints.
- `apps/hub/` — `@zzapi-mes/hub` — Hono server. Holds SAP creds server-side, issues JWTs to clients presenting API keys (SQLite-backed, argon2id-hashed). Deploys as systemd unit. Admin CLI: `zzapi-mes-hub-admin keys create/list/revoke`.

## Commands

- `pnpm build` — compile core, SDK, CLI, and hub TypeScript packages.
- `pnpm test` — run unit tests across core + hub (Node built-in test runner, mocked fetch + in-memory SQLite for hub).
- `pnpm spec:gen` — regenerate Zod schemas from `spec/openapi.yaml` into `packages/core/src/generated/`. CI drift gate checks this.
- `pnpm smoke` — run the curl smoke suite against sapdev. Requires handlers to already be deployed. Override creds/host via env:
  ```
  SAP_USER=api_user2 SAP_PASS='Pt@2026' SAP_HOST=sapdev.fastcell.hk:8000 pnpm smoke
  ```
  Defaults: `sapdev.fastcell.hk:8000`, client `200`. Exits with the number of failed checks.
  Set `VERBOSE=1` to print response bodies on failure.

## Deployment Model (important for edits to `abap/`)

Editing a file in `abap/` **does not deploy it**. The round-trip is manual:

1. Edit ABAP in SE24 on SAP (typically via `msi-1` Parsec/RDP → SAP GUI for Windows; SE24 also works in Java GUI and Web GUI, unlike SE80).
2. Register/activate the service node in SICF (one-time per endpoint, under `/default_host/sap/bc/`).
3. Mirror the activated source back into `abap/<CLASS>.abap` in the repo and diff to catch SAP-side edits.
4. Run `pnpm smoke` to verify.

When adding a new handler class: follow the naming pattern `ZCL_ZZAPI_MES_*`, place the SICF node at `/sap/bc/zzapi_mes_*`, and add a `check` line to `scripts/smoke.sh`.

## ABAP Handler Conventions

Each handler is a single class implementing `IF_HTTP_EXTENSION` with one method `handle_request`:

- Read HTTP method from `server->request->get_header_field( '~request_method' )`.
- Read query params via `server->request->get_form_field( '<name>' )` (plain names, no BSP `pa_` prefix).
- `CASE lv_method` dispatches verbs; unmatched verbs must return `405` with a JSON error body.
- Set status + `content-type: application/json` + `set_cdata()` for every code path (including 404/405).
- Reuse existing SAP artifacts: structure `ZMES001`, serializer `ZZ_CL_JSON` (camelCase mode). Do not reinvent JSON handling.
- Keep the PO JSON for `/sap/bc/zzapi_mes` byte-identical to what the legacy BSP page emits — the smoke test and downstream MES consumers depend on this.

For multi-endpoint routing under one SICF node, dispatch on `server->request->get_header_field( '~path_info' )` inside `handle_request` rather than registering many SICF nodes.

## Phase Roadmap (context for where work is heading)

| Phase | Scope |
|---|---|
| 1 (current) | Deploy `ZCL_ZZAPI_MES_PING` + `ZCL_ZZAPI_MES_HANDLER`, curl round-trip verified |
| 2 (done) | OpenAPI spec in `spec/`, Node SDK `@zzapi-mes/sdk`, CLI `@zzapi-mes/cli` |
| 3 (done) | `apps/hub` Hono service with JWT auth, `packages/core` extraction, CLI `--mode hub` |
| 4 (done) | SQLite-backed API keys (argon2id) + admin CLI, request IDs, structured JSON logs, `/metrics`, per-key rate limiting, spec-driven zod codegen, e2e integration tests |
| 5 (done) | MES business endpoints — Phase 5A read-only (production orders, material, stock, PO items, routing, work centers) + Phase 5B write-back (production confirmations, goods receipt, goods issue) with idempotency guard and audit logging. See `docs/phase-5-plan.md`. |
