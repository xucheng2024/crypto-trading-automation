const READ_ONLY_PATHS = new Set([
  "/api/v5/public/time", "/api/v5/account/config", "/api/v5/account/instruments",
  "/api/v5/account/leverage-info", "/api/v5/system/status", "/api/v5/trade/orders-pending",
  "/api/v5/trade/orders-history", "/api/v5/trade/fills", "/api/v5/trade/fills-history",
]);

export function assertReadOnlyRequest(method, path) {
  if (method !== "GET" || !READ_ONLY_PATHS.has(path)) throw new Error(`Preflight rejected non-read-only endpoint: ${method} ${path}`);
}

export async function runReadOnlyPreflight({ mode = "offline", fixture, client, realAuthorized = false } = {}) {
  if (mode === "offline") return { mode, ok: true, results: fixture ?? {} };
  if (mode !== "real" || !realAuthorized) throw new Error("Real preflight requires explicit read-only authorization");
  const calls = [["/api/v5/public/time", false], ["/api/v5/account/config", true], ["/api/v5/account/instruments", true], ["/api/v5/account/leverage-info", true], ["/api/v5/system/status", false]];
  const results = {};
  for (const [path, authenticated] of calls) { assertReadOnlyRequest("GET", path); results[path] = await client.read(path, {}, authenticated); }
  return { mode, ok: true, results: Object.fromEntries(Object.keys(results).map((key) => [key, "checked"])) };
}
