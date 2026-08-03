import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelPendingLimits,
  cancelPendingTriggers,
  fetchDelistAnnouncements,
  sellDelistedBalance,
  symbolAppears,
} from "../src/tasks.js";

const noSleep = async () => {};

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

test("announcement fetch retries non-JSON and API failures", async () => {
  const responses = [
    new Response("rate limited", { status: 429 }),
    new Response(JSON.stringify({ code: "50000", msg: "temporary" }), { status: 200 }),
    new Response(JSON.stringify({ code: "0", data: [{ details: [{ title: "ok" }] }] }), { status: 200 }),
  ];
  const delays = [];
  const announcements = await fetchDelistAnnouncements(async () => responses.shift(), async (ms) => delays.push(ms));
  assert.deepEqual(announcements, [{ title: "ok" }]);
  assert.deepEqual(delays, [60_000, 120_000]);
});

test("delist sell reconciles a prior client order before reading frozen balance", async () => {
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

  assert.equal(await sellDelistedBalance(okx, "BTC", "announcement"), true);
  assert.equal(balancesCalled, false);
  assert.equal(placed, false);
});

test("delist sell reconciles an unknown placement outcome by client order id", async () => {
  let orderQueries = 0;
  let placements = 0;
  const okx = {
    get: async (path) => {
      if (path === "/api/v5/trade/order") {
        orderQueries += 1;
        return orderQueries === 1 ? { code: "51603", data: [] } : { code: "0", data: [{ state: "filled" }] };
      }
      assert.equal(path, "/api/v5/public/instruments");
      return { code: "0", data: [{ tickSz: "0.01", lotSz: "0.001", minSz: "0.001" }] };
    },
    requireSuccess: async (result) => result.data,
    balances: async () => [{ details: [{ ccy: "BTC", eqUsd: "100", availBal: "0.1", frozenBal: "0", ordFrozen: "0" }] }],
    placeOrder: async () => { placements += 1; throw new Error("connection reset"); },
  };

  assert.equal(await sellDelistedBalance(okx, "BTC", "announcement"), true);
  assert.equal(placements, 1);
  assert.equal(orderQueries, 2);
});
