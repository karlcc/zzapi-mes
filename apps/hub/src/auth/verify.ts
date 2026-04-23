import type Database from "better-sqlite3";
import argon2 from "argon2";
import { findById, type ApiKeyRecord } from "../db/index.js";

export interface VerifiedKey {
  key_id: string;
  scopes: string[];
  rate_limit_per_min: number | null;
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
  if (dotIdx < 1) return null;

  const keyId = presented.slice(0, dotIdx);
  let record: ApiKeyRecord | undefined;
  try {
    record = findById(db, keyId);
  } catch {
    return null;
  }
  if (!record) return null;
  if (record.revoked_at !== null) return null;

  const match = await argon2.verify(record.hash, presented);
  if (!match) return null;

  return {
    key_id: record.id,
    scopes: record.scopes.split(",").map(s => s.trim()).filter(Boolean),
    rate_limit_per_min: record.rate_limit_per_min,
  };
}
