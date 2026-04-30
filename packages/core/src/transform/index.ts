/**
 * Transform engine — converts raw SAP DDIC responses to human-readable format.
 *
 * When the SDK serves friendly output (the default), this module:
 * 1. Renames SAP field names to self-describing English names
 * 2. Reformats dates from YYYYMMDD to ISO 8601 (YYYY-MM-DD)
 * 3. Handles nested array transformations
 *
 * When format: 'raw' is requested, the raw SAP response passes through unchanged.
 */

export {
  transformResponse,
  transformEntity,
  parseTransformOpts,
  formatIsoDate,
  type TransformOptions,
} from "./transform.js";

export {
  ENTITY_MAPPINGS,
  ROUTE_ENTITY_MAP,
  ROUTE_LINKS,
  type FieldMapping,
  type EntityMapping,
} from "./mappings.js";
