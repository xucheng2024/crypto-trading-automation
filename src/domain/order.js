const STATES = new Set(["PREPARED", "SUBMITTED", "UNKNOWN", "NOT_CREATED", "SETTLED"]);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits -= 5)) & 31]; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))));
}

export function assertAttemptState(state) {
  if (!STATES.has(state)) throw new Error(`Invalid attempt state: ${state}`);
  return state;
}

export async function payloadHash(payload) {
  return base32(await digest(payload));
}

export async function createDecisionId({ accountId, instId, strategyDay, generation, marketKey }) {
  if (!accountId || !instId || !strategyDay || !Number.isInteger(generation) || generation < 0 || !marketKey) throw new Error("Invalid decision ID tuple");
  return `D${base32((await digest([accountId, instId, strategyDay, generation, marketKey])).slice(0, 16))}`;
}

export async function createClOrdId(version, intent, tuple) {
  const prefix = `${version}${intent}`.replace(/[^a-zA-Z0-9]/g, "");
  if (!prefix || prefix.length > 10) throw new Error("Invalid order ID prefix");
  return `${prefix}${base32((await digest([version, intent, tuple])).slice(0, 16))}`.slice(0, 32);
}
