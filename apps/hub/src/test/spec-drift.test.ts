import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * Drift test: every hub path in the OpenAPI spec must have a corresponding
 * route registration in server.ts.  This catches the case where someone adds
 * a path to spec/openapi.yaml but forgets to wire it into the Hono app
 * (or vice-versa, though the reverse is less dangerous).
 *
 * SAP-direct paths (/sap/bc/zzapi/mes/*) are excluded — they are handled
 * by ABAP ICF handlers, not by the hub.
 */

interface SpecPath {
  path: string;
  methods: string[];
}

const HUB_PATH_PREFIXES = [
  "/auth/token",
  "/docs",
  "/openapi.json",
  "/healthz",
  "/metrics",
  "/ping",
  "/po/",
  "/prod-order/",
  "/material/",
  "/stock/",
  "/routing/",
  "/work-center/",
  "/confirmation",
  "/goods-receipt",
  "/goods-issue",
];

function isHubPath(path: string): boolean {
  // Exclude SAP-direct paths (handled by ABAP, not the hub)
  if (path.startsWith("/sap/")) return false;
  return HUB_PATH_PREFIXES.some((p) => path === p || path.startsWith(p));
}

function normalizePathParam(path: string): string {
  // Strip OpenAPI {param} and Hono :param — compare structural prefix only
  return path.replace(/\{[^}]+\}/g, "").replace(/:[^/]+/g, "");
}

function findRepoRoot(): string {
  // Walk up from __dirname (dist/test/ or src/test/) until package.json
  // with "name": "@zzapi-mes/hub" is found, then go one more level up.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.name === "@zzapi-mes/hub") return join(dir, "..", "..");
    } catch { /* not found, keep walking */ }
    dir = join(dir, "..");
  }
  throw new Error("Could not find repo root from " + __dirname);
}

const REPO_ROOT = findRepoRoot();

function extractHubPathsFromSpec(): SpecPath[] {
  const specPath = join(REPO_ROOT, "spec", "openapi.yaml");
  const specContent = readFileSync(specPath, "utf-8");
  const spec = yaml.load(specContent) as { paths: Record<string, Record<string, unknown>> };

  const hubPaths: SpecPath[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!isHubPath(path)) continue;
    hubPaths.push({
      path,
      methods: Object.keys(methods).filter((m) =>
        ["get", "post", "put", "patch", "delete"].includes(m),
      ),
    });
  }
  return hubPaths;
}

function extractRouteRegistrationsFromServer(): string[] {
  const serverPath = join(REPO_ROOT, "apps", "hub", "src", "server.ts");
  const serverContent = readFileSync(serverPath, "utf-8");

  const registrations: string[] = [];

  // app.use("/path" — middleware+route registrations
  const useRe = /app\.use\s*\(\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = useRe.exec(serverContent)) !== null) {
    const p = match[1]!;
    // Skip wildcard middleware — only path-specific registrations
    if (p !== "*") registrations.push(p);
  }

  // app.get("/path" / app.post("/path" — direct route registrations
  const methodRe = /app\.(get|post)\s*\(\s*["']([^"']+)["']/g;
  while ((match = methodRe.exec(serverContent)) !== null) {
    registrations.push(match[2]!);
  }

  // app.route("/", createXxxRouter(...)) — routers mount at "/"
  // but actual paths are inside each router file.
  // Map router names to their hub paths based on server.ts comments.
  const routerRe = /app\.route\s*\(\s*["']\/["']\s*,\s*create(\w+Router)\s*\(/g;
  const routerPaths: Record<string, string> = {
    PingRouter: "/ping",
    PoRouter: "/po/:ebeln",
    PoItemsRouter: "/po/:ebeln/items",
    ProdOrderRouter: "/prod-order/:aufnr",
    MaterialRouter: "/material/:matnr",
    StockRouter: "/stock/:matnr",
    RoutingRouter: "/routing/:matnr",
    WorkCenterRouter: "/work-center/:arbpl",
    ConfirmationRouter: "/confirmation",
    GoodsReceiptRouter: "/goods-receipt",
    GoodsIssueRouter: "/goods-issue",
  };
  while ((match = routerRe.exec(serverContent)) !== null) {
    const routerName = match[1]!;
    const mapped = routerPaths[routerName];
    if (mapped) registrations.push(mapped);
  }

  return registrations;
}

function pathMatchesSpec(routePath: string, specPath: string): boolean {
  const normRoute = normalizePathParam(routePath);
  const normSpec = normalizePathParam(specPath);
  return (
    normRoute === normSpec ||
    normRoute.startsWith(normSpec) ||
    normSpec.startsWith(normRoute)
  );
}

describe("OpenAPI spec ↔ route registration drift", () => {
  const specPaths = extractHubPathsFromSpec();
  const routeRegistrations = extractRouteRegistrationsFromServer();

  it("every hub spec path has at least one route registration in server.ts", () => {
    const missing: string[] = [];

    for (const sp of specPaths) {
      const hasMatch = routeRegistrations.some((rp) =>
        pathMatchesSpec(rp, sp.path),
      );
      if (!hasMatch) {
        missing.push(sp.path);
      }
    }

    assert.equal(
      missing.length,
      0,
      `Spec paths without route registrations: ${missing.join(", ")}. ` +
        `Add a route handler in server.ts or remove the spec path.`,
    );
  });

  it("spec has the expected number of hub paths", () => {
    // 16 hub paths currently: auth/token, docs, openapi.json, healthz, metrics,
    // ping, po/{ebeln}, prod-order/{aufnr}, material/{matnr}, stock/{matnr},
    // po/{ebeln}/items, routing/{matnr}, work-center/{arbpl},
    // confirmation, goods-receipt, goods-issue
    assert.ok(
      specPaths.length >= 14,
      `Expected at least 14 hub paths in spec, found ${specPaths.length}. ` +
        `If a path was intentionally added/removed, update this threshold.`,
    );
  });
});
