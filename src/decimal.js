function expandScientific(value) {
  const text = String(value).trim();
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent)) throw new Error(`Invalid decimal: ${value}`);
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  let result;
  if (point <= 0) result = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) result = `${digits}${"0".repeat(point - digits.length)}`;
  else result = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${result}` : result;
}

export function parseDecimal(value) {
  let text = expandScientific(value);
  const negative = text.startsWith("-");
  if (negative || text.startsWith("+")) text = text.slice(1);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid decimal: ${value}`);
  const [whole, fraction = ""] = text.split(".");
  const scale = fraction.length;
  const n = BigInt(`${whole}${fraction}` || "0") * (negative ? -1n : 1n);
  return { n, scale };
}

function pow10(power) {
  return 10n ** BigInt(power);
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return [a.n * pow10(scale - a.scale), b.n * pow10(scale - b.scale), scale];
}

export function compareDecimal(left, right) {
  const [a, b] = align(parseDecimal(left), parseDecimal(right));
  return a === b ? 0 : a > b ? 1 : -1;
}

export function multiplyDecimal(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return formatDecimal(a.n * b.n, a.scale + b.scale);
}

export function divideDecimal(left, right, outputScale = 18) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (b.n === 0n) throw new Error("Division by zero");
  const numerator = a.n * pow10(outputScale + b.scale);
  const denominator = b.n * pow10(a.scale);
  return formatDecimal(numerator / denominator, outputScale);
}

export function roundToStep(value, step, mode = "down") {
  const parsedValue = parseDecimal(value);
  const parsedStep = parseDecimal(step);
  if (parsedStep.n <= 0n) return formatDecimal(parsedValue.n, parsedValue.scale);
  const [valueN, stepN, scale] = align(parsedValue, parsedStep);
  let units = valueN / stepN;
  const remainder = valueN % stepN;
  if (mode === "half-up" && remainder * 2n >= stepN) units += 1n;
  return formatDecimal(units * stepN, scale);
}

export function formatDecimal(n, scale) {
  const negative = n < 0n;
  let digits = (negative ? -n : n).toString().padStart(scale + 1, "0");
  if (scale) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  digits = digits.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return `${negative ? "-" : ""}${digits}`;
}

export function decimalToNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
