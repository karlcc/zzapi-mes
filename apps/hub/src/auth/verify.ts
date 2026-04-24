import type Database from "better-sqlite3";
import argon2 from "argon2";
import { findById, type ApiKeyRecord } from "../db/index.js";

export interface VerifiedKey {
  key_id: string;
  scopes: string[];
  rate_limit_per_min: number | null;
}

/**
 * Perform a dummy argon2 verify to prevent timing-based key_id enumeration.
 * When a key_id is not found in the DB, we hash a throwaway string so the
 * function takes roughly the same wall-clock time as a real verify, closing
 * the side-channel that would otherwise reveal whether a key_id exists.
 */
async function dummyVerify(): Promise<void> {
  try {
    // Use a fixed dummy hash and a fixed dummy secret — the result is always
    // false but argon2 still runs, costing the same ~100ms as a real verify.
    await argon2.verify(
      "$argon2id$v=19$m=65536,t=3,p=4$dW1teS1zYWx0$placeholderplaceholderplaceholder",
      "dummy-secret-for-timing",
    );
  } catch {
    // Dummy hash is deliberately invalid — ignore errors, the purpose is
    // just to burn CPU cycles. An invalid hash still runs partial argon2
    // computation but may be faster. Use a valid hash below instead.
  }
  // Fallback: hash a known string to ensure consistent argon2 runtime.
  // This is always ~100ms regardless of the hash format.
  await argon2.hash("timing-constant", { type: argon2.argon2id });
}

/**
 * Verify a presented API key against the hashed store.
 * Key format: "<key_id>.<secret>" — split on first dot.
 * Returns the verified key info or null on failure.
 */
export async function verifyApiKey(
  db: Database.Database,
  presented: string,
): Promise<VerifiedKey | null> {
  if (!presented) return null;
  const dotIdx = presented.indexOf(".");
  if (dotIdx < 1) {
    await dummyVerify();
    return null;
  }

  const keyId = presented.slice(0, dotIdx);
  let record: ApiKeyRecord | undefined;
  try {
    record = findById(db, keyId);
  } catch {
    await dummyVerify();
    return null;
  }
  if (!record) {
    await dummyVerify();
    return null;
  }
  if (record.revoked_at !== null) {
    // Key exists but is revoked — still run argon2 to match timing of
    // non-revoked key with wrong secret.
    try { await argon2.verify(record.hash, presented); } catch { /* timing only */ }
    return null;
  }

  let match: boolean;
  try {
    match = await argon2.verify(record.hash, presented);
  } catch {
    return null;
  }
  if (!match) return null;

  return {
    key_id: record.id,
    scopes: record.scopes.split(",").map(s => s.trim()).filter(Boolean),
    rate_limit_per_min: record.rate_limit_per_min,
  };
}
