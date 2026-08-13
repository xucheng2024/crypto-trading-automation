export function createSystemClock() {
  return Object.freeze({ nowMs: () => Date.now() });
}

export function requireClock(clock) {
  if (!clock || typeof clock.nowMs !== "function") throw new TypeError("Clock must provide nowMs()");
  return clock;
}
