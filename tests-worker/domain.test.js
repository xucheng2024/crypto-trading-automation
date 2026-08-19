import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInstrument } from "../src/domain/instrument.js";
import { assertAttemptState, createClOrdId, createDecisionId, payloadHash } from "../src/domain/order.js";
import { buySignal, CANDLE_STALE_HARD_MS, candleFreshness, dailyLimit, delistPlan, expectedClosedCandleTs, normalizeHoldHours, sellBreakdownPrice, strategyDay } from "../src/domain/rules.js";

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

test("daily, duration, clock, buy, leverage and exit boundaries are pure", () => {
  assert.equal(strategyDay(Date.UTC(2026, 0, 1, 16, 1)), "2026-01-02");
  assert.equal(normalizeHoldHours("2D"), "48");
  assert.equal(normalizeHoldHours("2", "H"), "2");
  assert.throws(() => normalizeHoldHours("2"));
  assert.equal(dailyLimit({ todayOpen: "100", yesterdayOpen: "100", yesterdayClose: "110", bestLimit: "90", tickSz: "0.1" }).skipped, false);
  assert.equal(dailyLimit({ todayOpen: "100", yesterdayOpen: "100", yesterdayClose: "110.01", bestLimit: "90", tickSz: "0.1" }).skipped, true);
  assert.equal(buySignal({ last: "90", askPx: "90", limitPrice: "90", previousClosedHigh: "89" }).eligible, true);
  assert.equal(buySignal({ last: "89.267", askPx: "89.267", limitPrice: "90", previousClosedHigh: "89" }).reason, "BREAKOUT_NOT_CONFIRMED");
  assert.equal(buySignal({ last: "90", askPx: "90.1", limitPrice: "90", previousClosedHigh: "89" }).reason, "ASK_ABOVE_LIMIT");
  assert.equal(sellBreakdownPrice("100"), "99.7");
  assert.deepEqual(delistPlan({ fillSize: "2", disposedSize: "0.5", availableSize: "1.2", availSell: "1", lotSz: "0.1", minSz: "0.1", price: "10" }), { executable: true, size: "1" });
});

test("confirmed 3m candle freshness follows the expected exchange-time bucket", () => {
  const now = 720_000;
  assert.equal(expectedClosedCandleTs(now), 540_000);
  assert.deepEqual(candleFreshness({ candle: null, exchangeNowMs: now }), { state: "MISSING" });
  assert.equal(candleFreshness({ candle: { confirm: true, ts: 540_000 }, exchangeNowMs: now }).state, "FRESH");
  assert.equal(candleFreshness({ candle: { confirm: true, ts: 360_000 }, exchangeNowMs: now }).state, "PENDING");
  assert.equal(candleFreshness({ candle: { confirm: true, ts: 180_000 }, exchangeNowMs: now }).state, "STALE");
  assert.equal(candleFreshness({ candle: { confirm: true, ts: now - CANDLE_STALE_HARD_MS }, exchangeNowMs: now }).state, "STALE", "the hard stale boundary is inclusive");
  assert.equal(candleFreshness({ candle: { confirm: true, ts: "not-a-timestamp" }, exchangeNowMs: now }).state, "STALE", "non-finite timestamps fail closed");
  assert.equal(candleFreshness({ candle: { confirm: true, ts: now + 1 }, exchangeNowMs: now }).state, "STALE", "negative candle age fails closed");
  assert.equal(candleFreshness({ candle: { confirm: true, ts: 720_000 }, exchangeNowMs: now }).state, "STALE", "future/current buckets cannot masquerade as closed candles");
});
