import assert from "node:assert/strict";
import test from "node:test";

import { compareDecimal, divideDecimal, multiplyDecimal, roundToStep } from "../src/decimal.js";

test("decimal arithmetic avoids floating-point order errors", () => {
  assert.equal(multiplyDecimal("0.00000012", "71"), "0.00000852");
  assert.equal(divideDecimal("0.00000852", "100"), "0.0000000852");
  assert.equal(compareDecimal("0.10", "0.1"), 0);
});

test("exchange step rounding supports half-up prices and down-only sizes", () => {
  assert.equal(roundToStep("1.235", "0.01", "half-up"), "1.24");
  assert.equal(roundToStep("1.239", "0.01", "down"), "1.23");
  assert.equal(roundToStep("0.019", "0.01", "down"), "0.01");
});
