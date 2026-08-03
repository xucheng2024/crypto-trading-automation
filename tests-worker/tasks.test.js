import assert from "node:assert/strict";
import test from "node:test";

import {
  activeAssetsFromDetails,
  cancelPendingLimits,
  cancelPendingTriggers,
  eligibleTriggerPairs,
  fetchDelistAnnouncements,
  loadSpotMarketSnapshot,
  sellDelistedBalance,
  symbolAppears,
} from "../src/tasks.js";

const noSleep = async () => {};

function makeDelistEnv(rows = []) {
  const attempts = rows.map((row) => ({ ...row }));
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("SELECT attempt,cl_ord_id")) {
            return {
              first: async () => attempts.filter((row) => row.announcementId === values[0] && row.symbol === values[1])
                .sort((a, b) => b.attempt - a.attempt).map((row) => ({ ...row }))[0] || null,
            };
          }
          if (sql.includes("INSERT INTO delist_sell_attempts")) {
            return {
              run: async () => { attempts.push({ announcementId: values[0], symbol: values[1], attempt: values[2], clOrdId: values[3], state: "PREPARED" }); return { meta: { changes: 1 } }; },
            };
          }
          if (sql.includes("UPDATE delist_sell_attempts")) {
            return {
              run: async () => {
                const row = attempts.find((item) => item.announcementId === values[2] && item.symbol === values[3] && item.attempt === values[4]);
                if (row) { row.state = values[0]; row.ordId ||= values[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              },
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
  };
  return { env: { DB: db }, attempts };
}

test("limit cancellation resubmits orders that remain pending", async () => {
  const order = { instId: "BTC-USDT", ordId: "1", side: "buy" };
  const pages = [[order], [order], []];
  let cancellations = 0;
  const okx = {
    pendingLimits: async () => pages.shift() || [],
    cancelLimits: async () => { cancellations += 1; },
  };

  const result = await cancelPendingLimits(okx, { sleepFn: noSleep });
  assert.equal(cancellations, 2);
  assert.deepEqual(result, { found: 1, remaining: 0 });
});

test("trigger cancellation resubmits orders that remain pending", async () => {
  const order = { instId: "BTC-USDT", algoId: "1", ordType: "trigger" };
  const pages = [[order], [order], []];
  let cancellations = 0;
  const okx = {
    pendingTriggers: async () => pages.shift() || [],
    cancelTriggers: async () => { cancellations += 1; },
  };

  const result = await cancelPendingTriggers(okx, { sleepFn: noSleep });
  assert.equal(cancellations, 2);
  assert.deepEqual(result, { found: 1, remaining: 0 });
});

test("delist symbol matching covers legacy quote aliases without partial matches", () => {
  for (const alias of ["TOKENBTC", "TOKEN/ETH", "TOKEN-USD", "TOKENEUR", "TOKEN/GBP"]) {
    assert.equal(symbolAppears(`OKX to delist ${alias} spot trading`, "TOKEN"), true, alias);
  }
  assert.equal(symbolAppears("OKX to delist MYTOKENBTC spot trading", "TOKEN"), false);
});

test("cash currencies never count towards the active-position gate", () => {
  const assets = activeAssetsFromDetails([
    { ccy: "USDT", eqUsd: "500" },
    { ccy: "USDC", eqUsd: "500" },
    { ccy: "BTC", eqUsd: "10" },
  ]);
  assert.deepEqual(assets.map((item) => item.ccy), ["BTC"]);
});

test("announcement fetch uses the shared paced OKX client", async () => {
  let path;
  const announcements = await fetchDelistAnnouncements({
    get: async (requestedPath) => {
      path = requestedPath;
      return { code: "0", data: [{ details: [{ title: "ok" }] }] };
    },
    requireSuccess: async (result) => result.data,
  });
  assert.deepEqual(announcements, [{ title: "ok" }]);
  assert.equal(path, "/api/v5/support/announcements");
});

test("trigger rebuild never includes held currencies", () => {
  const pairs = [{ inst_id: "BTC-USDT" }, { inst_id: "ETH-USDT" }, { inst_id: "SOL-USDT" }];
  const eligible = eligibleTriggerPairs(pairs, [{ ccy: "BTC" }], new Set(["ETH"]), new Set(["SOL-USDT"]));
  assert.deepEqual(eligible, []);
});

test("spot market snapshot collapses rules and tickers into two requests", async () => {
  const paths = [];
  const snapshot = await loadSpotMarketSnapshot({
    get: async (path) => {
      paths.push(path);
      return path.includes("instruments")
        ? { code: "0", data: [{ instId: "BTC-USDT", tickSz: "0.1", lotSz: "0.0001", minSz: "0.0001" }] }
        : { code: "0", data: [{ instId: "BTC-USDT", last: "100000" }] };
    },
    requireSuccess: async (result) => result.data,
  });
  assert.deepEqual(paths, ["/api/v5/public/instruments", "/api/v5/market/tickers"]);
  assert.equal(snapshot.lastByInstId.get("BTC-USDT"), "100000");
  assert.deepEqual(snapshot.rulesByInstId.get("BTC-USDT"), { tickSz: "0.1", lotSz: "0.0001", minSz: "0.0001" });
});

test("delist sell reconciles a prior client order before reading frozen balance", async () => {
  const { env } = makeDelistEnv([{ announcementId: "announcement", symbol: "BTC", attempt: 0, clOrdId: "prior", state: "SUBMITTED" }]);
  let balancesCalled = false;
  let placed = false;
  const okx = {
    get: async (path) => {
      assert.equal(path, "/api/v5/trade/order");
      return { code: "0", data: [{ state: "filled" }] };
    },
    requireSuccess: async (result) => result.data,
    balances: async () => { balancesCalled = true; return []; },
    placeOrder: async () => { placed = true; },
  };

  assert.equal(await sellDelistedBalance(env, okx, "BTC", "announcement", { sleepFn: noSleep }), true);
  assert.equal(balancesCalled, false);
  assert.equal(placed, false);
});

test("delist sell reconciles an unknown placement outcome by client order id", async () => {
  const { env, attempts } = makeDelistEnv();
  let orderQueries = 0;
  let placements = 0;
  const okx = {
    get: async (path) => {
      if (path === "/api/v5/trade/order") {
        orderQueries += 1;
        return { code: "0", data: [{ state: "filled" }] };
      }
      assert.equal(path, "/api/v5/public/instruments");
      return { code: "0", data: [{ tickSz: "0.01", lotSz: "0.001", minSz: "0.001" }] };
    },
    requireSuccess: async (result) => result.data,
    balances: async () => [{ details: [{ ccy: "BTC", eqUsd: "100", availBal: "0.1", frozenBal: "0", ordFrozen: "0" }] }],
    placeOrder: async () => { placements += 1; throw new Error("connection reset"); },
  };

  assert.equal(await sellDelistedBalance(env, okx, "BTC", "announcement", { sleepFn: noSleep }), true);
  assert.equal(placements, 1);
  assert.equal(orderQueries, 1);
  assert.equal(attempts[0].state, "FILLED");
});

test("delist sell creates a new durable attempt after a canceled prior order", async () => {
  const { env, attempts } = makeDelistEnv([{ announcementId: "announcement", symbol: "BTC", attempt: 0, clOrdId: "prior", state: "SUBMITTED" }]);
  let orderQueries = 0;
  let placements = 0;
  const okx = {
    get: async (path) => {
      if (path === "/api/v5/trade/order") {
        orderQueries += 1;
        if (orderQueries === 1) return { code: "0", data: [{ state: "canceled" }] };
        return { code: "0", data: [{ state: "filled" }] };
      }
      return { code: "0", data: [{ tickSz: "0.01", lotSz: "0.001", minSz: "0.001" }] };
    },
    requireSuccess: async (result) => result.data,
    balances: async () => [{ details: [{ ccy: "BTC", eqUsd: "100", availBal: "0.1", frozenBal: "0", ordFrozen: "0" }] }],
    placeOrder: async () => { placements += 1; return { ordId: "new" }; },
  };

  assert.equal(await sellDelistedBalance(env, okx, "BTC", "announcement", { sleepFn: noSleep }), true);
  assert.equal(placements, 1);
  assert.deepEqual(attempts.map((row) => row.state), ["FAILED", "FILLED"]);
});
