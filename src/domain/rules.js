import { compareDecimal, multiplyDecimal, roundToStep } from "../decimal.js";

export const TRADE_FEE_RATE = "0.0005";

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

// Panic-rebound strategy.  Every UTC+8 day, each live USDT spot pair whose
// last trade reaches open*0.82 is counted in exchange-time order.  The first
// PANIC_SKIP_COUNT counted pairs are never bought; any later counted pair whose
// last trade reaches open*0.72 is bought with owned USDT at exactly that limit.
// Each fill is market-sold at the day close, or after the minimum hold.
export const PANIC_COUNT_RATIO = "0.82";
export const PANIC_BUY_RATIO = "0.72";
export const PANIC_SKIP_COUNT = 2;
export const PANIC_MIN_HOLD_HOURS = "3";
export const PANIC_MIN_HOLD_MS = 3 * 3_600_000;
export const PANIC_CLOSE_SELL_LEAD_MS = 60_000;
export const PANIC_MIN_ORDER_USDT = "10";
export const PANIC_BACKFILL_BAR_MS = 5 * 60_000;
export const PANIC_STRATEGY_HASH = "panic-rebound-v1:count=0.82:buy=0.72:skip=2:hold=3h:close=23:59";

const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 3_600_000;

// pg returns DATE columns as local-midnight Date objects; tests and JSON rows
// carry YYYY-MM-DD strings.  Both normalize to the same strategy-day text.
export function normalizeStrategyDay(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("strategy day is required");
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("strategy day is required");
  return text;
}

export function strategyDayStartMs(day) {
  const start = Date.parse(`${normalizeStrategyDay(day)}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("strategy day is required");
  return start - UTC8_OFFSET_MS;
}

export function previousStrategyDay(day) { return strategyDay(strategyDayStartMs(day) - 1); }

export function strategyDayCloseSellMs(day) { return strategyDayStartMs(day) + DAY_MS - PANIC_CLOSE_SELL_LEAD_MS; }

export function panicSellTime({ strategyDay: day, fillTime }) {
  const fill = Number(fillTime);
  if (!Number.isSafeInteger(fill) || fill < 0) throw new Error("fill time is required");
  return Math.max(strategyDayCloseSellMs(day), fill + PANIC_MIN_HOLD_MS);
}

export function panicPrices({ open, tickSz }) {
  if (compareDecimal(open, "0") <= 0 || compareDecimal(tickSz, "0") <= 0) throw new Error("panic prices require a positive open and tick size");
  const buyPrice = roundToStep(multiplyDecimal(open, PANIC_BUY_RATIO), tickSz, "down");
  if (compareDecimal(buyPrice, "0") <= 0) throw new Error("panic buy price rounds to zero");
  return { countPrice: multiplyDecimal(open, PANIC_COUNT_RATIO), buyPrice };
}

// A backfilled 5m candle locates a first touch only within that candle. Rank
// each instrument by the number of touches guaranteed to have happened before
// it. Ambiguous ties and overlapping windows stay below the buyable rank.
export function rankCountHits(rows) {
  const hits = rows.filter((row) => row.countHitAt !== null && row.countHitAt !== undefined && row.countHitAt !== "" && Number.isFinite(Number(row.countHitAt)))
    .map((row) => ({ instId: row.instId, first: Number(row.countHitAt), last: Number(row.countHitAt) + (row.countHitSource === "BACKFILL" ? PANIC_BACKFILL_BAR_MS - 1 : 0) }))
    .sort((a, b) => a.first - b.first || String(a.instId).localeCompare(String(b.instId)));
  const ends = hits.map((hit) => hit.last).sort((a, b) => a - b);
  return new Map(hits.map((hit) => {
    let low = 0; let high = ends.length;
    while (low < high) { const middle = (low + high) >>> 1; if (ends[middle] < hit.first) low = middle + 1; else high = middle; }
    return [hit.instId, low + 1];
  }));
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
