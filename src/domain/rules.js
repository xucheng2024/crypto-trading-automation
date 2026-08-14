import { compareDecimal, divideDecimal, multiplyDecimal, roundToStep } from "../decimal.js";

export const BUY_ADMISSION_LEVERAGE = "2.95";
export const MAX_STRATEGY_EFFECTIVE_LEVERAGE = "3";
export const TRADE_FEE_RATE = "0.0005";
export const CANDLE_INTERVAL_MS = 180_000;
export const CANDLE_STALE_HARD_MS = 390_000;

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
export const SELL_BREAKDOWN_MULTIPLIER = "0.997";

export function buySignal({ last, askPx, limitPrice, previousClosedHigh }) {
  if (compareDecimal(last, limitPrice) > 0) return { eligible: false, reason: "PRICE_OUTSIDE" };
  const breakoutPrice = multiplyDecimal(previousClosedHigh, BUY_BREAKOUT_MULTIPLIER);
  if (compareDecimal(last, breakoutPrice) <= 0) return { eligible: false, reason: "BREAKOUT_NOT_CONFIRMED", breakoutPrice };
  if (compareDecimal(askPx, limitPrice) > 0) return { eligible: false, reason: "ASK_ABOVE_LIMIT" };
  return { eligible: true, reason: "ELIGIBLE", breakoutPrice };
}

export function sellBreakdownPrice(previousClosedLow) {
  if (compareDecimal(previousClosedLow, "0") <= 0) throw new Error("previous closed low must be positive");
  return multiplyDecimal(previousClosedLow, SELL_BREAKDOWN_MULTIPLIER);
}

export function adjustedEquity({ totalEq, adjEq }) {
  if (compareDecimal(totalEq, "0") <= 0 || compareDecimal(adjEq, "0") <= 0) throw new Error("equity must be positive");
  return compareDecimal(totalEq, adjEq) < 0 ? totalEq : adjEq;
}

export function assessLeverage({ committedExposure, totalEq, adjEq, candidateCost = "0" }) {
  const equity = adjustedEquity({ totalEq, adjEq });
  const projected = multiplyDecimal("1", committedExposure); // canonical decimal validation
  const candidate = multiplyDecimal("1", candidateCost);
  const exposure = addDecimal(projected, candidate);
  const effective = divideDecimal(exposure, equity);
  return { equity, effective, hardStopped: compareDecimal(divideDecimal(projected, equity), MAX_STRATEGY_EFFECTIVE_LEVERAGE) >= 0, admitted: compareDecimal(effective, BUY_ADMISSION_LEVERAGE) <= 0 };
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
