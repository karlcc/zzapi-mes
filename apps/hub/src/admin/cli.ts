#!/usr/bin/env node
/**
 * zzapi-mes-hub-admin — manage API keys for the zzapi-mes hub.
 *
 * Commands:
 *   keys create --label <str> [--scopes ping,po] [--rate-limit N]
 *   keys list
 *   keys revoke <id>
 *   keys rotate <id>
 *   keys delete <id>
 */
import { openDb, runMigrations, insertKey, listKeys, listKeysPage, countKeys, revokeKey, findById, updateKeyHash, deleteKey, pruneAuditLog, evictIdempotencyKeys } from "../db/index.js";
import { ALL_SCOPES } from "@zzapi-mes/core";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";

function usage(): never {
  console.error(`Usage:
  zzapi-mes-hub-admin keys create --label <str> [--scopes ping,po] [--rate-limit N]
  zzapi-mes-hub-admin keys list [--format tsv|json] [--limit N] [--offset N]
  zzapi-mes-hub-admin keys revoke <id>
  zzapi-mes-hub-admin keys rotate <id>
  zzapi-mes-hub-admin keys delete <id>
  zzapi-mes-hub-admin audit prune --days <N>
  zzapi-mes-hub-admin idempotency evict --max-age-seconds <N>`);
  process.exit(1);
}

function parseArgs(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break; // POSIX end-of-options marker
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      if (!raw) {
        console.error(`Empty flag name: "${arg}"`);
        process.exit(1);
      }
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        opts[raw.slice(0, eq)] = raw.slice(eq + 1);
      } else {
        opts[raw] = args[++i] ?? usage();
      }
    }
  }
  return opts;
}

async function main(args: string[]): Promise<void> {
  const command = args[0];
  const subcommand = args[1];

  if (command !== "keys" && command !== "audit" && command !== "idempotency") usage();

  const db = openDb(process.env.HUB_DB_PATH || undefined);
  runMigrations(db);

  try {
    if (subcommand === "create") {
      const opts = parseArgs(args.slice(2));
      const label = opts["label"] ?? usage();
      // Validate label length and characters at CLI level for user-friendly errors
      const MAX_LABEL_LENGTH = 255;
      if (label.length > MAX_LABEL_LENGTH) {
        console.error(`--label must be at most ${MAX_LABEL_LENGTH} characters, got ${label.length}`);
        process.exit(1);
      }
      if (/[\x00-\x1f\x7f]/.test(label)) {
        console.error("--label must not contain control characters");
        process.exit(1);
      }
      // Warn if label is already in use (non-blocking — labels are not unique)
      const existing = listKeys(db).find(k => k.label === label);
      if (existing) {
        console.error(`Warning: label "${label}" is already used by key ${existing.id}`);
      }
      const scopes = opts["scopes"] ?? "ping,po";
      // Deduplicate scopes — "ping,ping,po" → "ping,po"
      const uniqueScopes = [...new Set(scopes.split(",").map(s => s.trim()).filter(Boolean))].join(",");
      if (!uniqueScopes) {
        console.error("--scopes must contain at least one valid scope");
        process.exit(1);
      }
      // Validate scopes against known values
      const invalidScopes = uniqueScopes.split(",").map(s => s.trim()).filter(s => s && !ALL_SCOPES.includes(s as typeof ALL_SCOPES[number]));
      if (invalidScopes.length > 0) {
        console.error(`Unknown scope(s): ${invalidScopes.join(", ")}. Valid scopes: ${ALL_SCOPES.join(", ")}`);
        process.exit(1);
      }
      const rateLimitRaw = opts["rate-limit"];
      const rateLimit = rateLimitRaw != null ? parseInt(rateLimitRaw, 10) : null;
      // parseInt("10.5", 10) → 10 — reject decimal input explicitly
      if (rateLimit !== null && rateLimitRaw != null && rateLimitRaw.includes(".")) {
        console.error("--rate-limit must be an integer (got decimal)");
        process.exit(1);
      }
      if (rateLimit !== null && (Number.isNaN(rateLimit) || rateLimit <= 0)) {
        console.error("--rate-limit must be a positive integer");
        process.exit(1);
      }
      if (rateLimit !== null && rateLimit > 10_000) {
        console.error("--rate-limit must be ≤ 10000 (requests per minute)");
        process.exit(1);
      }

      // Generate key_id (12 hex chars from 6 random bytes)
      const keyId = randomBytes(6).toString("hex");
      // Generate secret (32 random bytes, base64url)
      const secret = randomBytes(32).toString("base64url");
      const plaintext = `${keyId}.${secret}`;

      const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
      const now = Math.floor(Date.now() / 1000);

      insertKey(db, {
        id: keyId,
        hash,
        label,
        scopes: uniqueScopes,
        rate_limit_per_min: rateLimit,
        created_at: now,
      });

      console.log(plaintext);
    } else if (subcommand === "list") {
      const opts = parseArgs(args.slice(2));
      const format = opts["format"] ?? "tsv";
      const limit = parseInt(opts["limit"] ?? "0", 10);
      const offset = parseInt(opts["offset"] ?? "0", 10);
      const keys = limit > 0 ? listKeysPage(db, limit, offset) : listKeys(db);
      const total = limit > 0 ? countKeys(db) : keys.length;
      if (format === "json") {
        console.log(JSON.stringify({
          total,
          offset,
          limit: limit > 0 ? limit : total,
          keys: keys.map(k => ({
            id: k.id,
            status: k.revoked_at !== null ? "REVOKED" : "ACTIVE",
            label: k.label ?? null,
            scopes: k.scopes.split(","),
            rate_limit_per_min: k.rate_limit_per_min,
            created_at: new Date(k.created_at * 1000).toISOString(),
            revoked_at: k.revoked_at !== null ? new Date(k.revoked_at * 1000).toISOString() : null,
          })),
        }));
      } else {
        // Print header row for pipe-friendly parsing
        if (limit > 0) console.log(`Showing ${keys.length} of ${total} (offset ${offset})`);
        console.log("KEY_ID\tSTATUS\tLABEL\tSCOPES\tRATE_LIMIT\tCREATED");
        for (const k of keys) {
          const status = k.revoked_at !== null ? "REVOKED" : "ACTIVE";
          // Escape tabs/newlines in label to keep output pipe-friendly
          const safeLabel = (k.label ?? "-").replace(/[\t\n\r]/g, (c) => c === "\t" ? "\\t" : c === "\n" ? "\\n" : "\\r");
          console.log(
            `${k.id}\t${status}\t${safeLabel}\t${k.scopes}\t${k.rate_limit_per_min ?? "default"}\t${new Date(k.created_at * 1000).toISOString()}`,
          );
        }
      }
    } else if (subcommand === "revoke") {
      const id = args[2];
      if (!id) usage();
      const ok = revokeKey(db, id);
      if (ok) {
        console.log(`Key ${id} revoked.`);
      } else {
        console.error(`Key ${id} not found or already revoked.`);
        process.exitCode = 1;
      }
    } else if (subcommand === "rotate") {
      const id = args[2];
      if (!id) usage();
      const existing = findById(db, id);
      if (!existing) {
        console.error(`Key ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      if (existing.revoked_at !== null) {
        console.error(`Key ${id} is revoked. Cannot rotate a revoked key.`);
        process.exitCode = 1;
        return;
      }
      const secret = randomBytes(32).toString("base64url");
      const plaintext = `${id}.${secret}`;
      const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
      updateKeyHash(db, id, hash);
      console.log(plaintext);
    } else if (subcommand === "delete") {
      const id = args[2];
      if (!id) usage();
      const ok = deleteKey(db, id);
      if (ok) {
        console.log(`Key ${id} deleted.`);
      } else {
        console.error(`Key ${id} not found.`);
        process.exitCode = 1;
      }
    } else if (command === "audit" && subcommand === "prune") {
      const opts = parseArgs(args.slice(2));
      const days = parseInt(opts["days"] ?? "", 10);
      if (!days || days <= 0) {
        console.error("--days must be a positive integer");
        process.exit(1);
      }
      if (days > 3650) {
        console.error("--days must be ≤ 3650 (10 years)");
        process.exit(1);
      }
      const deleted = pruneAuditLog(db, days);
      console.log(`Pruned ${deleted} audit log rows older than ${days} days.`);
    } else if (command === "idempotency" && subcommand === "evict") {
      const opts = parseArgs(args.slice(2));
      const maxAge = parseInt(opts["max-age-seconds"] ?? "", 10);
      if (!maxAge || maxAge <= 0) {
        console.error("--max-age-seconds must be a positive integer");
        process.exit(1);
      }
      const deleted = evictIdempotencyKeys(db, maxAge);
      console.log(`Evicted ${deleted} idempotency keys older than ${maxAge}s.`);
    } else {
      usage();
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
