#!/usr/bin/env node
/**
 * zzapi-mes-hub-admin — manage API keys for the zzapi-mes hub.
 *
 * Commands:
 *   keys create --label <str> [--scopes ping,po] [--rate-limit N]
 *   keys list
 *   keys revoke <id>
 */
import { openDb, runMigrations, insertKey, listKeys, revokeKey, pruneAuditLog, evictIdempotencyKeys } from "../db/index.js";
import { ALL_SCOPES } from "@zzapi-mes/core";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";

function usage(): never {
  console.error(`Usage:
  zzapi-mes-hub-admin keys create --label <str> [--scopes ping,po] [--rate-limit N]
  zzapi-mes-hub-admin keys list
  zzapi-mes-hub-admin keys revoke <id>
  zzapi-mes-hub-admin audit prune --days <N>
  zzapi-mes-hub-admin idempotency evict --max-age-seconds <N>`);
  process.exit(1);
}

function parseArgs(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      const key = args[i]!.slice(2);
      opts[key] = args[++i] ?? usage();
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
      const scopes = opts["scopes"] ?? "ping,po";
      // Validate scopes against known values
      const invalidScopes = scopes.split(",").map(s => s.trim()).filter(s => s && !ALL_SCOPES.includes(s as typeof ALL_SCOPES[number]));
      if (invalidScopes.length > 0) {
        console.error(`Unknown scope(s): ${invalidScopes.join(", ")}. Valid scopes: ${ALL_SCOPES.join(", ")}`);
        process.exit(1);
      }
      const rateLimit = opts["rate-limit"] ? parseInt(opts["rate-limit"], 10) : null;
      if (rateLimit !== null && (Number.isNaN(rateLimit) || rateLimit <= 0)) {
        console.error("--rate-limit must be a positive integer");
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
        scopes,
        rate_limit_per_min: rateLimit,
        created_at: now,
      });

      console.log(plaintext);
    } else if (subcommand === "list") {
      const keys = listKeys(db);
      for (const k of keys) {
        const status = k.revoked_at !== null ? "REVOKED" : "ACTIVE";
        console.log(
          `${k.id}\t${status}\t${k.label ?? "-"}\t[${k.scopes}]\tlimit=${k.rate_limit_per_min ?? "default"}\tcreated=${new Date(k.created_at * 1000).toISOString()}`,
        );
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
    } else if (command === "audit" && subcommand === "prune") {
      const opts = parseArgs(args.slice(2));
      const days = parseInt(opts["days"] ?? "", 10);
      if (!days || days <= 0) {
        console.error("--days must be a positive integer");
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
