import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInstrument } from "../src/domain/instrument.js";
import { assertAttemptState, createClOrdId, createDecisionId, payloadHash } from "../src/domain/order.js";
import { delistPlan, normalizeHoldHours, normalizeStrategyDay, panicPrices, panicSellTime, previousStrategyDay, rankCountHits, strategyDay, strategyDayCloseSellMs, strategyDayStartMs } from "../src/domain/rules.js";

test("domain instrument and order contracts normalize deterministically", async () => {
  assert.deepEqual(normalizeInstrument({ instId: "btc-usdt", tickSz: "0.1", lotSz: "0.001", state: "live" }), { instId: "BTC-USDT", base: "BTC", quote: "USDT", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", state: "live", expTime: null });
  const id = await createClOrdId("v1", "BUY", ["BTC-USDT", "2026-08-14", 0]);
  assert.match(id, /^[A-Za-z0-9]{1,32}$/);
  assert.equal(id, await createClOrdId("v1", "BUY", ["BTC-USDT", "2026-08-14", 0]));
  const decision = { accountId: "a", instId: "BTC-USDT", strategyDay: "2026-08-14", generation: 0, marketKey: "market" };
  const decisionId = await createDecisionId(decision);
  assert.match(decisionId, /^D[A-Z2-7]{26}$/);
  assert.equal(decisionId, await createDecisionId(decision));
  assert.notEqual(decisionId, await createDecisionId({ ...decision, marketKey: "new-market" }));
  assert.notEqual(await payloadHash({ b: 1, a: 2 }), await payloadHash({ b: 2, a: 1 }));
  assert.throws(() => assertAttemptState("FILLED"));
});

test("strategy day, duration and exit boundaries are pure", () => {
  assert.equal(strategyDay(Date.UTC(2026, 0, 1, 16, 1)), "2026-01-02");
  assert.equal(normalizeHoldHours("2D"), "48");
  assert.equal(normalizeHoldHours("2", "H"), "2");
  assert.throws(() => normalizeHoldHours("2"));
  assert.deepEqual(delistPlan({ fillSize: "2", disposedSize: "0.5", availableSize: "1.2", availSell: "1", lotSz: "0.1", minSz: "0.1", price: "10" }), { executable: true, size: "1" });
});

test("panic-rebound prices, ranks and UTC+8 day boundaries are pure", () => {
  const dayStart = strategyDayStartMs("2026-09-24");
  assert.equal(new Date(dayStart).toISOString(), "2026-09-23T16:00:00.000Z", "a strategy day starts at 00:00 UTC+8");
  assert.equal(strategyDay(dayStart), "2026-09-24");
  assert.equal(strategyDay(dayStart - 1), "2026-09-23");
  assert.equal(previousStrategyDay("2026-09-24"), "2026-09-23");
  assert.equal(normalizeStrategyDay(new Date(2026, 8, 24)), "2026-09-24", "pg DATE values are local-midnight Dates");
  assert.equal(normalizeStrategyDay("2026-09-24T00:00:00Z"), "2026-09-24");
  assert.throws(() => normalizeStrategyDay("not-a-day"));
  assert.equal(strategyDayCloseSellMs("2026-09-24"), dayStart + 86_400_000 - 60_000, "close sells at 23:59:00 UTC+8");

  assert.deepEqual(panicPrices({ open: "100", tickSz: "0.1" }), { countPrice: "82", buyPrice: "72" });
  assert.deepEqual(panicPrices({ open: "1.2345", tickSz: "0.0001" }), { countPrice: "1.01229", buyPrice: "0.8888" }, "the buy limit rounds down to the tick");
  assert.throws(() => panicPrices({ open: "0", tickSz: "0.1" }));
  assert.throws(() => panicPrices({ open: "0.001", tickSz: "1" }), /rounds to zero/);

  const hour = 3_600_000;
  assert.equal(panicSellTime({ strategyDay: "2026-09-24", fillTime: dayStart + 15 * hour }), strategyDayCloseSellMs("2026-09-24"), "a 15:00 buy sells at 23:59");
  assert.equal(panicSellTime({ strategyDay: "2026-09-24", fillTime: dayStart + 20 * hour }), strategyDayCloseSellMs("2026-09-24"), "a 20:00 buy still holds 3h before 23:59");
  assert.equal(panicSellTime({ strategyDay: "2026-09-24", fillTime: dayStart + 22 * hour }), dayStart + 25 * hour, "a 22:00 buy sells at 01:00 next day");
  assert.equal(panicSellTime({ strategyDay: "2026-09-24", fillTime: dayStart + 21 * hour }), dayStart + 24 * hour, "a 21:00 buy holds the full 3h");
  assert.throws(() => panicSellTime({ strategyDay: "2026-09-24", fillTime: "x" }));

  const ranks = rankCountHits([{ instId: "C-USDT", countHitAt: 30 }, { instId: "A-USDT", countHitAt: 10 }, { instId: "B-USDT", countHitAt: 10 }, { instId: "D-USDT", countHitAt: null }]);
  assert.deepEqual([...ranks], [["A-USDT", 1], ["B-USDT", 2], ["C-USDT", 3]], "ties break by instId and unhit symbols are unranked");
});
