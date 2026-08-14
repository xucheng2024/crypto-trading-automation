const READ_ONLY_PATHS = new Set([
  "/api/v5/public/time", "/api/v5/account/config", "/api/v5/account/instruments",
  "/api/v5/account/leverage-info", "/api/v5/system/status", "/api/v5/trade/orders-pending",
  "/api/v5/trade/orders-history", "/api/v5/trade/fills", "/api/v5/trade/fills-history",
]);

export function assertReadOnlyRequest(method, path) {
  if (method !== "GET" || !READ_ONLY_PATHS.has(path)) throw new Error(`Preflight rejected non-read-only endpoint: ${method} ${path}`);
}

export async function runReadOnlyPreflight({ mode = "offline", fixture, client, instId, realAuthorized = false } = {}) {
  if (mode === "offline") return { mode, ok: true, results: fixture ?? {} };
  if (mode !== "real" || !realAuthorized) throw new Error("Real preflight requires explicit read-only authorization");
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(instId ?? "")) throw new Error("Real preflight requires a configured instrument");
  const calls = [
    ["public-time", "/api/v5/public/time", {}, false],
    ["account-config", "/api/v5/account/config", {}, true],
    ["account-instruments-spot", "/api/v5/account/instruments", { instType: "SPOT" }, true],
    ["account-instruments-margin", "/api/v5/account/instruments", { instType: "MARGIN" }, true],
    ["account-leverage-cross", "/api/v5/account/leverage-info", { instId, mgnMode: "cross" }, true],
    ["system-status", "/api/v5/system/status", {}, false],
  ];
  const results = {};
  for (const [key, path, params, authenticated] of calls) {
    assertReadOnlyRequest("GET", path);
    results[key] = await client.read(path, params, authenticated);
  }
  return { mode, ok: true, results: Object.fromEntries(Object.keys(results).map((key) => [key, "checked"])) };
}
