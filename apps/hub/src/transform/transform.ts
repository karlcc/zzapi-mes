/**
 * Transform engine — converts raw SAP DDIC responses to human-readable format.
 *
 * When the hub serves friendly output (the default), this module:
 * 1. Renames SAP field names to self-describing English names
 * 2. Reformats dates from YYYYMMDD to ISO 8601 (YYYY-MM-DD)
 * 3. Wraps the response in an envelope: { data, _links, _source? }
 * 4. Resolves HATEOAS link templates from the response data
 *
 * When ?format=raw is requested, the raw SAP response passes through unchanged
 * with zero overhead (same object reference returned).
 */

import {
  EntityMapping,
  ENTITY_MAPPINGS,
  ROUTE_ENTITY_MAP,
  ROUTE_LINKS,
} from "./mappings.js";

export interface TransformOptions {
  /** If false (default for ?format=raw), return raw SAP response unchanged */
  friendly: boolean;
  /** If true, include _source with original SAP field names */
  includeSource: boolean;
}

/** Convert YYYYMMDD to YYYY-MM-DD. Handles both string and numeric date values.
 *  Returns input unchanged if not an 8-digit date. */
function formatIsoDate(value: unknown): unknown {
  const str = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (str && /^[0-9]{8}$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }
  return value;
}

/** Apply field mappings to a flat object.
 *  - Mapped fields are renamed; date fields are reformatted.
 *  - Unmapped fields are dropped (available via ?include=_source or ?format=raw). */
function mapObject(
  obj: Record<string, unknown>,
  fieldMappings: ReadonlyArray<{
    sapName: string;
    friendlyName: string;
    isDate?: boolean;
  }>,
): Record<string, unknown> {
  const lookup = new Map(fieldMappings.map((m) => [m.sapName, m]));
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const mapping = lookup.get(key);
    if (mapping) {
      result[mapping.friendlyName] =
        mapping.isDate ? formatIsoDate(value) : value;
    }
    // Unmapped fields dropped — use ?include=_source or ?format=raw for raw data
  }
  return result;
}

/** Recursively transform a SAP response according to its entity mapping. */
export function transformEntity(
  raw: Record<string, unknown>,
  mapping: EntityMapping,
): Record<string, unknown> {
  // Map top-level fields
  const result = mapObject(raw, mapping.fields);

  // Map nested arrays (items, operations, components, etc.)
  if (mapping.nested) {
    for (const [arrayKey, nestedFields] of Object.entries(mapping.nested)) {
      const arr = raw[arrayKey];
      if (Array.isArray(arr)) {
        result[arrayKey] = arr.map((item: Record<string, unknown>) =>
          mapObject(item, nestedFields),
        );
      }
    }
  }

  return result;
}

/** Resolve HATEOAS link templates like "/po/{ebeln}/items" using raw data values. */
function resolveLinks(
  templates: Record<string, string>,
  rawData: Record<string, unknown>,
): Record<string, string> {
  const links: Record<string, string> = {};
  for (const [rel, template] of Object.entries(templates)) {
    let resolved = template;
    for (const [key, val] of Object.entries(rawData)) {
      if (typeof val === "string") {
        resolved = resolved.split(`{${key}}`).join(encodeURIComponent(val));
      }
    }
    // Only include link if all placeholders were resolved
    if (!resolved.includes("{")) {
      links[rel] = resolved;
    }
  }
  return links;
}

/** Top-level entry point. Returns raw result unchanged or friendly envelope. */
export function transformResponse(
  raw: unknown,
  route: string,
  opts: TransformOptions,
): unknown {
  if (!opts.friendly) {
    return raw; // Zero overhead — same reference
  }

  const entityKey = ROUTE_ENTITY_MAP[route];
  if (!entityKey) {
    // Routes like /ping, /healthz, /metrics — no mapping, pass through
    return raw;
  }

  const mapping = ENTITY_MAPPINGS[entityKey];
  if (!mapping) {
    return raw; // Unknown entity — safe fallback
  }

  const rawObj = raw as Record<string, unknown>;
  const data = transformEntity(rawObj, mapping);

  const envelope: Record<string, unknown> = { data };

  // Optional _source: raw SAP names for traceability
  if (opts.includeSource) {
    envelope._source = rawObj;
  }

  // HATEOAS links
  const linkTemplates = ROUTE_LINKS[route];
  if (linkTemplates) {
    envelope._links = resolveLinks(linkTemplates, rawObj);
  }

  return envelope;
}

/** Parse transform query parameters from the Hono context.
 *  - ?format=raw → friendly=false (backward compat)
 *  - ?include=_source → includeSource=true */
export function parseTransformOpts(query: (name: string) => string | undefined): TransformOptions {
  const format = query("format") ?? "";
  const include = query("include") ?? "";
  return {
    friendly: format !== "raw",
    includeSource: include.split(",").includes("_source"),
  };
}
