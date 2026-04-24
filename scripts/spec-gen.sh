#!/usr/bin/env bash
# spec-gen.sh — regenerate Zod schemas from OpenAPI spec and clean up zodios code
#
# Usage: pnpm spec:gen  (calls this script)
#
# openapi-zod-client produces zodios API code + Zod schemas. We strip
# the zodios parts and add Schema-suffix re-exports that the codebase depends on.

set -euo pipefail

cd "$(dirname "$0")/.."

# Step 1: Regenerate from spec
npx openapi-zod-client spec/openapi.yaml -o packages/core/src/generated/schemas.ts --export-schemas

FILE="packages/core/src/generated/schemas.ts"

# Step 2: Strip @zodios/core import line (portable sed -i)
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' '/^import { makeApi, Zodios, type ZodiosOptions } from "@zodios\/core";$/d' "$FILE"
else
  sed -i '/^import { makeApi, Zodios, type ZodiosOptions } from "@zodios\/core";$/d' "$FILE"
fi

# Step 3: Remove everything from "const endpoints" to EOF
# Find the line number where "const endpoints" starts and truncate
ENDPOINTS_LINE=$(grep -n '^const endpoints' "$FILE" | head -1 | cut -d: -f1)
if [ -n "$ENDPOINTS_LINE" ]; then
  # Keep everything before the endpoints line
  head -n $((ENDPOINTS_LINE - 1)) "$FILE" > "${FILE}.tmp" && mv "${FILE}.tmp" "$FILE"
fi

# Step 4: Trim trailing blank lines before the schemas closing brace
perl -i -00 -pe 's/\n{3,}$/\n\n/' "$FILE"

# Step 5: For schemas with additionalProperties: false in the spec, append .strict()
# openapi-zod-client does not emit .strict() for additionalProperties: false,
# so we add it post-generation for the three write-back request schemas.
# Strategy: find the line "});" that immediately follows a line ending with
# .optional(),) for the three target schemas — these are the closing }); lines.
# We use perl to do multi-line matching: find "const X = z.object({...});" and
# replace the closing "});" with "})\n  .strict();"
perl -i -0pe '
  s/(const (Confirmation|GoodsReceipt|GoodsIssue)Request = z\.object\(\{.*?)\}\);/$1})\n  .strict();/gs
' "$FILE"

# Step 6: Add Schema-suffix re-exports
cat >> "$FILE" <<'REEXPORTS'
// Re-export with Schema suffix for consumers that depend on the XxxSchema naming convention
export const PingResponseSchema = PingResponse;
export const PoResponseSchema = PoResponse;
export const ErrorResponseSchema = ErrorResponse;
export const ProdOrderResponseSchema = ProdOrderResponse;
export const MaterialResponseSchema = MaterialResponse;
export const StockResponseSchema = StockResponse;
export const PoItemsResponseSchema = PoItemsResponse;
export const RoutingResponseSchema = RoutingResponse;
export const WorkCenterResponseSchema = WorkCenterResponse;
export const ConfirmationRequestSchema = ConfirmationRequest;
export const ConfirmationResponseSchema = ConfirmationResponse;
export const GoodsReceiptRequestSchema = GoodsReceiptRequest;
export const GoodsReceiptResponseSchema = GoodsReceiptResponse;
export const GoodsIssueRequestSchema = GoodsIssueRequest;
export const GoodsIssueResponseSchema = GoodsIssueResponse;
export const TokenResponseSchema = TokenResponse;
export const HealthzResponseSchema = HealthzResponse;
REEXPORTS

echo "Done — schemas.ts regenerated and cleaned"
