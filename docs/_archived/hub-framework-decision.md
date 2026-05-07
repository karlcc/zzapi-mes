# Hub Framework Decision: Hono vs Go

**Status**: Recommendation
**Date**: 2026-04-22
**Context**: Phase 3 (apps/hub) framework selection

## TL;DR

**Recommend Hono** (TypeScript), not Go. Rationale: the existing monorepo is TypeScript end-to-end, and CLI-first design depends on the CLI and hub sharing validators, types, and the SAP client. Keeping one language makes that sharing free; adding Go introduces a language boundary the project doesn't repay at this scale.

## Context — What We Already Have

| Piece | Language | Status |
|---|---|---|
| `abap/*` — ICF handlers | ABAP | Phase 1 |
| `spec/openapi.yaml` — contract | YAML | Phase 2 done |
| `packages/sdk` — `@zzapi-mes/sdk` | TypeScript | Phase 2 done |
| `packages/cli` — `@zzapi-mes/cli` | TypeScript | Phase 2 done |
| CI workflow | Node 20, pnpm | Phase 2 done |
| `apps/hub` — this decision | ? | Phase 3 |

The SDK exports `ZzapiMesClient`, `ZzapiMesHttpError`, `ensureProtocol`. The CLI imports them directly. The OpenAPI spec already encodes the request/response shapes.

## CLI-First Design Implications

CLI-first means: **the CLI command surface defines what operations exist; the hub is those same operations exposed as HTTP with bearer auth.**

Concrete implication — CLI and hub must share:
1. Input validators (ebeln format, pagination, etc.)
2. Response types (what `getPo` returns)
3. The SAP HTTP client (Basic Auth, retries, error mapping)
4. Error classification (4xx vs 5xx, retryable vs not)

If they don't share these, you get drift: CLI accepts an input the hub rejects, or the hub returns a shape the CLI doesn't type. Drift is what OpenAPI-as-contract is supposed to prevent — but only if one implementation doesn't bypass the contract.

## Option A — Hono (TypeScript) — Recommended

### Pros
- **Zero language boundary.** Extract `packages/core` (SAP client, Zod schemas, errors). SDK, CLI, and hub all `import { getPo } from "@zzapi-mes/core"`. One validator, one type, one error hierarchy.
- **Stack consistency.** Same runtime, same tooling, same CI pipeline, same test framework. One mental model for the whole repo.
- **`@hono/zod-openapi`** can generate route handlers from the existing `spec/openapi.yaml`, validating requests against the spec at runtime. Drift becomes compile-time / startup-time visible.
- **CLI mode switching is trivial.** `--mode direct` calls SAP; `--mode hub` calls the hub. Same command surface, same validation, different transport. One flag.
- **Small service, small framework.** Hono is ~20KB, no boilerplate. The hub is ~150 LOC: bearer middleware + 2-3 route handlers that call `core.getPo()`.

### Cons
- Node runtime on the hub host (minor — pm2 or systemd or Docker all solve this).
- No "single static binary" out of the box. Mitigation: `bun build --compile` or `pkg` when/if that becomes required.
- TypeScript build step adds a layer vs Go's `go build`.

### Shape
```
apps/hub/
├── src/
│   ├── server.ts          # Hono app, 30 LOC
│   ├── middleware/
│   │   └── bearer.ts      # token validation, 20 LOC
│   └── routes/
│       ├── ping.ts        # proxies to core.ping(), 15 LOC
│       └── po.ts          # proxies to core.getPo(), 20 LOC
├── package.json
└── tsconfig.json
```

## Option B — Go

### Pros
- **Single static binary.** `scp zzapi-hub linux-box:/usr/local/bin/` and done. Appealing if the deploy target is an untrusted LAN box where Node install is friction.
- **Lower baseline RAM** (~10MB vs ~50MB). Irrelevant at MES scale.
- **Better goroutine concurrency** for long-lived connections. Also irrelevant — this is a thin proxy, not a high-QPS service.
- **No `node_modules`.** Dependency story is simpler at deploy time.

### Cons
- **Language boundary through the repo.** Either:
  - Duplicate validators (ebeln regex, field types) in Go — drift risk.
  - Generate Go structs from OpenAPI — adds codegen step; generated types often don't match hand-rolled validators on the TS side.
  - Have the CLI shell out to `zzapi-hub --local` — complicates the "CLI in hub mode vs direct mode" story.
- **No shared SAP client.** Go hub reimplements Basic Auth, retries, error classification separately from `ZzapiMesClient`. Two implementations = two bug surfaces.
- **Team stack fragmentation.** CI has to build two toolchains. Contributors need both.
- **Upside is all deploy-side.** The deploy-side win (single binary) can be replicated in TypeScript later with `bun build --compile` if actually needed. The language-boundary cost is architectural and lasts forever.

## Decision Matrix

| Criterion | Hono | Go | Weight |
|---|---|---|---|
| Shares code with CLI/SDK | ✅ native | ❌ boundary | **High** (CLI-first) |
| Validator parity with OpenAPI | ✅ `@hono/zod-openapi` | ⚠️ codegen | **High** |
| Deploy simplicity | ⚠️ runtime + process mgr | ✅ single binary | Medium |
| Perf at expected load | ✅ plenty | ✅ plenty | Low (MES scale) |
| Stack consistency | ✅ | ❌ | High |
| Time to first bearer-guarded endpoint | ~1 day | ~3 days | Medium |

## Proposed Phase 3 Plan

1. **Extract `packages/core`** from current SDK — SAP client, Zod schemas, error types. SDK becomes a thin re-export; CLI imports from core directly. No behavior change, just restructure.
2. **`apps/hub` with Hono** — bearer middleware (start with opaque token in env var, upgradable to JWT later), 2 routes matching the OpenAPI spec.
3. **CLI `--mode` flag** — `direct` (current, calls SAP) or `hub` (calls hub over HTTP with bearer). Default stays `direct` for the demo phase.
4. **Deploy** — systemd unit on a LAN box near sapdev. Document in `docs/hub-deploy.md` when built.

## When to Revisit

- If a Go-native team ends up maintaining the hub → port (the core extraction makes this easier, not harder).
- If the hub needs to be distributed as a single binary to untrusted hosts → `bun build --compile` first; only port to Go if that's insufficient.
- If QPS exceeds ~1000 req/s sustained → profile first; Node handles this fine but Go would reduce headroom concerns.

## Footnote: Fastify / Express

Not recommended over Hono for this use case:
- **Fastify** is fine but heavier and its plugin ecosystem doesn't buy anything this small service needs.
- **Express** is familiar but dated — no first-class TypeScript, no Zod-OpenAPI integration as clean as Hono's.

Hono's reason-to-exist is exactly this kind of small, edge-deployable, TS-native service.
