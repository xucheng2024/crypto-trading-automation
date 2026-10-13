import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { OBSERVATION_SYMBOLS, normalizeObservations, createObserverServers, statusPage, startMarketObserver } from "../src/entrypoints/azure/market-observer.js";
import { observationRunCommand } from "../scripts/observation-run-command.mjs";

test("public quotes retain decimal precision and reject malformed or future values", () => {
  const now = 1_800_000_000_000;
  const quote = { instId: "BTC-USDT", ts: String(now), last: "0.00000125", open24h: "0.000001" };
  const result = normalizeObservations([quote, quote, { ...quote, instId: "ETH-USDT", last: "0" }, { ...quote, instId: "SOL-USDT", ts: String(now + 60_001) }, { ...quote, instId: "BNB-USDT", open24h: "invalid" }, { ...quote, instId: "OTHER-USDT" }], OBSERVATION_SYMBOLS, now);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].price, "0.00000125");
  assert.equal(Number(result.rows[0].changePct), 25);
  assert.equal(result.missing, 9);
  assert.equal(result.invalid, 3);
});

test("observer HTTP exposes only public data, denies writes, and reports stale/database failure", async () => {
  let unavailable = false;
  const rows = OBSERVATION_SYMBOLS.map((inst_id) => ({ inst_id, price: "1.25", open_24h: "1", change_pct: "25" }));
  const pool = { query: async () => { if (unavailable) throw new Error("password=must-not-leak"); return { rows }; } };
  const state = { databaseOk: true, lastSuccessAt: Date.now(), httpErrors: 0 };
  const servers = createObserverServers({ pool, state, apiUrl: "http://public-api.example", webPort: 0, apiPort: 0 });
  try {
    await Promise.all([servers.web, servers.api].map((s) => s.listening ? undefined : once(s, "listening")));
    const web = `http://127.0.0.1:${servers.web.address().port}`;
    const api = `http://127.0.0.1:${servers.api.address().port}`;
    assert.match(await (await fetch(web)).text(), /http:\/\/public-api.example\/api\/status/);
    const ready = await (await fetch(`${api}/api/status`)).json();
    assert.equal(ready.ready, true);
    assert.equal(ready.orderExecutionEnabled, false);
    assert.equal(ready.observations.length, 10);
    for (const origin of [web, api]) {
      assert.equal((await fetch(`${origin}/api/order`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${origin}/private/account`)).status, 404);
      assert.equal((await (await fetch(`${origin}/health/live`)).json()).mode, "OBSERVE");
    }
    state.lastSuccessAt = Date.now() - 120_001;
    assert.equal((await (await fetch(`${api}/api/status`)).json()).ready, false);
    unavailable = true;
    const failed = await fetch(`${api}/api/status`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ready: false, error: "DATABASE_UNAVAILABLE" });
    assert.equal(state.httpErrors, 1);
  } finally { await servers.close(); }
});

test("observer refuses enabled execution before opening any server or database", async () => {
  await assert.rejects(startMarketObserver({ ORDER_EXECUTION_ENABLED: "true" }), /requires ORDER_EXECUTION_ENABLED=false/);
  await assert.rejects(startMarketObserver({ ORDER_EXECUTION_ENABLED: "false" }), /configuration is incomplete/);
});

test("dashboard escapes its API endpoint and produces valid JavaScript", () => {
  const html = statusPage("http://example.test/</script><script>bad()</script>");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /<\/script>/);
  assert.match(script, /textContent=value/);
});

test("bootstrap pins its image, rejects execution and keeps config out of shell parsing", () => {
  const config = { image: `registry.test/engine@sha256:${"a".repeat(64)}`, env: { ORDER_EXECUTION_ENABLED: "false", MARKET_API_URL: "http://test/$(touch /bad)" } };
  const command = observationRunCommand(config, "print('bootstrap')");
  assert.equal(spawnSync("bash", ["-n"], { input: command.script.join("\n") }).status, 0);
  assert.doesNotMatch(command.script.join("\n"), /\$\(touch/);
  assert.throws(() => observationRunCommand({ ...config, env: { ORDER_EXECUTION_ENABLED: "true" } }, ""), /disabled execution/);
  assert.throws(() => observationRunCommand({ ...config, image: "registry.test/engine:latest" }, ""), /pinned image/);
});

test("deployment retains VNet migrations and retires old resources only after health verification", async () => {
  const [bicep, bootstrap, workflow, source, runCommand] = await Promise.all(["infrastructure/bicep/observation.bicep", "infrastructure/observation/bootstrap.py", ".github/workflows/production-deploy.yml", "src/entrypoints/azure/market-observer.js", "scripts/observation-run-command.mjs"].map((path) => readFile(path, "utf8")));
  assert.match(bicep, /ORDER_EXECUTION_ENABLED: 'false'/);
  assert.match(bicep, /natGateway: \{ id: nat.id \}/);
  assert.match(bicep, /disablePasswordAuthentication: true/);
  assert.match(bicep, /name: 'deny-ssh'/);
  assert.doesNotMatch(bicep, /roleAssignments|listSecrets|listCredentials/);
  assert.match(bootstrap, /--password-stdin/);
  assert.match(runCommand, /protectedParameters:/);
  assert.match(workflow, /initialize_observation:[\s\S]*runs-on: \[self-hosted, linux, x64, crypto-remote-migration\]/);
  assert.match(workflow, /Retire the superseded trading deployment after observer health passes\n\s+if: \$\{\{ success\(\) \}\}/);
  assert.ok(workflow.indexOf("Observer healthy:") < workflow.indexOf("Retire the superseded"));
  assert.doesNotMatch(source, /infrastructure\/okx|OKX_API|private\/(account|trade)|placeOrder|trading-engine\.js/);
});
