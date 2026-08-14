import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInstrument } from "../src/domain/instrument.js";
import { assertAttemptState, createClOrdId, payloadHash } from "../src/domain/order.js";
import { assessLeverage, buySignal, dailyLimit, delistPlan, normalizeHoldHours, strategyDay } from "../src/domain/rules.js";

test("domain instrument and order contracts normalize deterministically", async () => {
  assert.deepEqual(normalizeInstrument({ instId: "btc-usdt", tickSz: "0.1", lotSz: "0.001", state: "live" }), { instId: "BTC-USDT", base: "BTC", quote: "USDT", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", state: "live", expTime: null });
  const id = await createClOrdId("v1", "BUY", ["BTC-USDT", "2026-08-14", 0]);
  assert.match(id, /^[A-Za-z0-9]{1,32}$/);
  assert.equal(id, await createClOrdId("v1", "BUY", ["BTC-USDT", "2026-08-14", 0]));
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
  assert.equal(buySignal({ last: "90", askPx: "90", limitPrice: "90", previousClosedOpen: "89" }).eligible, true);
  assert.equal(buySignal({ last: "90", askPx: "90.1", limitPrice: "90", previousClosedOpen: "89" }).reason, "ASK_ABOVE_LIMIT");
  assert.equal(assessLeverage({ committedExposure: "295", candidateCost: "0", totalEq: "100", adjEq: "100" }).admitted, true);
  assert.equal(assessLeverage({ committedExposure: "295", candidateCost: "0.01", totalEq: "100", adjEq: "100" }).admitted, false);
  assert.equal(assessLeverage({ committedExposure: "300", totalEq: "100", adjEq: "100" }).hardStopped, true);
  assert.deepEqual(delistPlan({ fillSize: "2", disposedSize: "0.5", availableSize: "1.2", availSell: "1", lotSz: "0.1", minSz: "0.1", price: "10" }), { executable: true, size: "1" });
});
