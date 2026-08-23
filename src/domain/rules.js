import { compareDecimal, divideDecimal, multiplyDecimal, roundToStep } from "../decimal.js";

export const TRADE_FEE_RATE = "0.0005";
export const CANDLE_INTERVAL_MS = 180_000;
export const CANDLE_STALE_HARD_MS = 390_000;

export function sellProtectionAnchorClose(sellTime) {
  const value = Number(sellTime);
  if (!Number.isFinite(value) || value < 0) throw new Error("sell time is required");
  return Math.ceil(value / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
}

export function sellProtectionAnchorTs(sellTime) {
  return sellProtectionAnchorClose(sellTime) - CANDLE_INTERVAL_MS;
}

export function expectedClosedCandleTs(exchangeTimeMs) {
  if (!Number.isFinite(exchangeTimeMs)) throw new Error("exchange time is required");
  return Math.floor(exchangeTimeMs / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS - CANDLE_INTERVAL_MS;
}

export function candleFreshness({ candle, exchangeNowMs }) {
  if (!candle?.confirm) return { state: "MISSING" };
  const candleTs = Number(candle.ts);
  if (!Number.isFinite(candleTs)) return { state: "STALE", age: NaN, expectedTs: expectedClosedCandleTs(exchangeNowMs) };
  const expectedTs = expectedClosedCandleTs(exchangeNowMs);
  const age = exchangeNowMs - candleTs;
  if (age < 0 || candleTs > expectedTs || age >= CANDLE_STALE_HARD_MS) return { state: "STALE", age, expectedTs };
  if (candleTs < expectedTs) return { state: "PENDING", age, expectedTs };
  return { state: "FRESH", age, expectedTs };
}

export function strategyDay(exchangeTimeMs) {
  if (!Number.isFinite(exchangeTimeMs)) throw new Error("exchange time is required");
  return new Date(exchangeTimeMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function normalizeHoldHours(value, legacyUnit) {
  const text = String(value ?? "").trim();
  const match = /^(\d+(?:\.\d+)?)([HhDd])$/.exec(text);
  const number = match?.[1] ?? (legacyUnit ? text : null);
  const unit = (match?.[2] ?? legacyUnit ?? "").toUpperCase();
  if (!number || !["H", "D"].includes(unit) || compareDecimal(number, "0") <= 0) throw new Error("best_duration must have an explicit H or D unit");
  return unit === "D" ? multiplyDecimal(number, "24") : number;
}

export function dailyLimit({ todayOpen, yesterdayOpen, yesterdayClose, bestLimit, tickSz }) {
  if ([todayOpen, yesterdayOpen, yesterdayClose, bestLimit, tickSz].some((value) => compareDecimal(value, "0") <= 0)) throw new Error("daily limit inputs must be positive");
  if (compareDecimal(multiplyDecimal(yesterdayClose, "10"), multiplyDecimal(yesterdayOpen, "11")) > 0) return { skipped: true, reason: "SKIPPED_YESTERDAY_GAIN" };
  return { skipped: false, price: roundToStep(divideDecimal(multiplyDecimal(todayOpen, bestLimit), "100"), tickSz, "down") };
}

export const BUY_BREAKOUT_MULTIPLIER = "1.003";
export const BUY_DIP_MULTIPLIER = "0.94";
export const SELL_BREAKDOWN_MULTIPLIER = "0.997";

export function buySignal({ last, askPx, limitPrice, previousClosedHigh }) {
  const breakoutPrice = multiplyDecimal(previousClosedHigh, BUY_BREAKOUT_MULTIPLIER);
  const dipPrice = multiplyDecimal(limitPrice, BUY_DIP_MULTIPLIER);
  if (compareDecimal(last, limitPrice) > 0) return { eligible: false, reason: "PRICE_OUTSIDE", breakoutPrice, dipPrice };
  const breakoutConfirmed = compareDecimal(last, breakoutPrice) > 0;
  const dipConfirmed = compareDecimal(last, dipPrice) <= 0;
  if (!breakoutConfirmed && !dipConfirmed) return { eligible: false, reason: "BREAKOUT_NOT_CONFIRMED", breakoutPrice, dipPrice };
  if (compareDecimal(askPx, limitPrice) > 0) return { eligible: false, reason: "ASK_ABOVE_LIMIT", breakoutPrice, dipPrice };
  return { eligible: true, reason: "ELIGIBLE", breakoutPrice, dipPrice, trigger: breakoutConfirmed ? "BREAKOUT" : "DIP" };
}

export function sellBreakdownPrice(previousClosedLow) {
  if (compareDecimal(previousClosedLow, "0") <= 0) throw new Error("previous closed low must be positive");
  return multiplyDecimal(previousClosedLow, SELL_BREAKDOWN_MULTIPLIER);
}

export const SELL_TAKE_PROFIT_MULTIPLIER = "1.20";

export function takeProfitPrice(fillPrice) {
  if (compareDecimal(fillPrice, "0") <= 0) throw new Error("fill price must be positive");
  return multiplyDecimal(fillPrice, SELL_TAKE_PROFIT_MULTIPLIER);
}

function addDecimal(left, right) {
  const scale = Math.max((String(left).split(".")[1] || "").length, (String(right).split(".")[1] || "").length);
  const factor = 10n ** BigInt(scale);
  const convert = (value) => { const [whole, fraction = ""] = String(value).split("."); return BigInt(whole) * factor + BigInt((fraction + "0".repeat(scale)).slice(0, scale)); };
  const result = convert(left) + convert(right);
  const sign = result < 0n ? "-" : "";
  const digits = (result < 0n ? -result : result).toString().padStart(scale + 1, "0");
  if (!scale) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.0+$/, "");
}

export function sellPlan({ fillSize, disposedSize, availableSize, availSell, lotSz, minSz, price }) {
  const remaining = addDecimal(fillSize, `-${disposedSize}`);
  const cap = [remaining, availableSize, availSell].reduce((lowest, value) => compareDecimal(value, lowest) < 0 ? value : lowest);
  const size = roundToStep(cap, lotSz, "down");
  if (compareDecimal(size, minSz) < 0 || compareDecimal(multiplyDecimal(size, price), "0.1") < 0) return { executable: false, reason: "DUST", size };
  return { executable: true, size };
}

export function delistPlan(input) { return sellPlan(input); }
