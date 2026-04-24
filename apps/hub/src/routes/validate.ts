import type { Context } from "hono";

/** SAP identifiers are alphanumeric, hyphens, and underscores (work-center IDs like TURN-1, WC_01). Reject anything else early. */
const SAP_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a path or query parameter: non-empty, alphanumeric, within maxLength.
 * Returns a JSON 400 response on failure, or null on success.
 */
export function validateParam(
  c: Context,
  name: string,
  value: string,
  maxLength: number,
  source: "path" | "query" = "path",
): Response | null {
  const label = source === "query" ? "Query parameter" : "Parameter";
  if (!value || value.length === 0) {
    return c.json({ error: `${label} '${name}' must not be empty` }, 400);
  }
  if (value.length > maxLength) {
    return c.json({ error: `${label} '${name}' exceeds maximum length of ${maxLength}` }, 400);
  }
  if (!SAP_ID_RE.test(value)) {
    return c.json({ error: `${label} '${name}' contains invalid characters (alphanumeric, hyphen, underscore only)` }, 400);
  }
  return null;
}
