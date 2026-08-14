import { compareDecimal } from "../decimal.js";

export function normalizeInstrument(raw) {
  const instId = String(raw.instId || raw.inst_id || "").toUpperCase();
  const [base, quote, ...extra] = instId.split("-");
  if (!base || !quote || extra.length || compareDecimal(raw.tickSz || "0", "0") <= 0 || compareDecimal(raw.lotSz || "0", "0") <= 0) {
    throw new Error(`Invalid instrument: ${instId || "missing instId"}`);
  }
  return Object.freeze({ instId, base, quote, tickSz: String(raw.tickSz), lotSz: String(raw.lotSz), minSz: String(raw.minSz || raw.lotSz), state: String(raw.state || "").toLowerCase(), expTime: raw.expTime == null ? null : String(raw.expTime) });
}
