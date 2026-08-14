import assert from "node:assert/strict";
import test from "node:test";

import { OkxRestClient, classifyBatchResponse, classifyCrossFill, validateAccountProfile } from "../src/infrastructure/okx/rest-client.js";
import { OkxBusinessWsClient, OkxPrivateWsClient, OkxPublicWsClient } from "../src/infrastructure/okx/ws-client.js";

const credentials = { apiKey: "key", secretKey: "secret", passphrase: "pass" };
const ok = (data = []) => new Response(JSON.stringify({ code: "0", data }));

test("P1 REST transport signs, syncs server time, uses expTime, retries only GET, and respects Retry-After", async () => {
  let now = 1_000;
  const delays = []; const calls = [];
  const client = new OkxRestClient({ credentials, clock: { nowMs: () => now }, sleep: async (ms) => delays.push(ms), fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/time")) { now = 1_100; return ok([{ ts: "6000" }]); }
    if (calls.filter((call) => call.url.includes("system/status")).length === 1) return new Response("slow", { status: 429, headers: { "retry-after": "2" } });
    return ok([{ sCode: "0", clOrdId: "A", ordId: "1" }]);
  } });
  await client.syncServerTime();
  assert.equal(client.clockSkewMs, 4_950); assert.equal(client.clockSyncedAt, 1_100); assert.equal(client.clockFresh(10), true);
  await client.systemStatus();
  const result = await client.submitBatchOrders([{ clOrdId: "A", instId: "BTC-USDT" }], 99_999);
  assert.deepEqual(result, [{ clOrdId: "A", status: "SUBMITTED", ordId: "1" }]);
  assert.deepEqual(delays, [2_000]);
  const batch = calls.at(-1).init;
  assert.equal(batch.headers.expTime, "99999");
  assert.ok(batch.headers["OK-ACCESS-SIGN"]);
  assert.match(batch.headers["OK-ACCESS-TIMESTAMP"], /^1970-01-01T00:00:06/);
  assert.match(calls[0].url, /^https:\/\/openapi\.okx\.com\//);
  now = 1_111; assert.equal(client.clockFresh(10), false);
});

test("P1 mutation transport makes one send attempt then returns UNKNOWN, while batch items stay independent", async () => {
  let calls = 0;
  const client = new OkxRestClient({ credentials, fetcher: async () => { calls += 1; throw new Error("connection reset"); } });
  assert.deepEqual(await client.submitBatchOrders([{ clOrdId: "A" }, { clOrdId: "B" }], 1), [
    { clOrdId: "A", status: "UNKNOWN", reason: "connection reset" }, { clOrdId: "B", status: "UNKNOWN", reason: "connection reset" },
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(classifyBatchResponse({ code: "0", data: [{ clOrdId: "A", sCode: "0", ordId: "1" }, { clOrdId: "B", sCode: "51000", sMsg: "bad" }, { clOrdId: "C", ordId: "3" }] }, ["A", "B", "C"]), [
    { clOrdId: "A", status: "SUBMITTED", ordId: "1" }, { clOrdId: "B", status: "NOT_CREATED", sCode: "51000", reason: "bad" }, { clOrdId: "C", status: "UNKNOWN", reason: "INVALID_BATCH_ITEM" },
  ]);
});

test("P5 account profile classifies borrow-capable and owned-funds routes while all new orders remain cross", () => {
  const commonInstrument = { instId: "BTC-USDT", state: "live", tradeQuoteCcyList: "USDT,USDC" };
  const spotOnly = validateAccountProfile({ config: [{ acctLv: "3", autoLoan: "true" }], enabledInstIds: ["BTC-USDT"], spotInstruments: [commonInstrument] });
  assert.equal(spotOnly.ready, true); assert.equal(spotOnly.executionRoutes.get("BTC-USDT"), "spot"); assert.equal(spotOnly.quoteCurrency.get("BTC-USDT"), null);
  const ready = validateAccountProfile({ config: [{ acctLv: "3", autoLoan: "true" }], enabledInstIds: ["BTC-USDT"], spotInstruments: [commonInstrument], marginInstruments: [commonInstrument] });
  assert.equal(ready.ready, true); assert.equal(ready.executionRoutes.get("BTC-USDT"), "margin"); assert.equal(ready.quoteCurrency.get("BTC-USDT"), "USDT");
  const unsupportedMarginQuote = validateAccountProfile({ config: [{ acctLv: "3", autoLoan: "true" }], enabledInstIds: ["BTC-USDT"], spotInstruments: [commonInstrument], marginInstruments: [{ ...commonInstrument, tradeQuoteCcyList: "USDC" }] });
  assert.equal(unsupportedMarginQuote.executionRoutes.get("BTC-USDT"), "spot");
  const unavailable = validateAccountProfile({ config: [{ acctLv: "3", autoLoan: "true" }], enabledInstIds: ["BTC-USDT"], allowUnavailable: true });
  assert.equal(unavailable.ready, true); assert.deepEqual(unavailable.unavailable, ["BTC-USDT"]); assert.equal(unavailable.executionRoutes.size, 0);
  assert.equal(validateAccountProfile({ config: [{ acctLv: "3", autoLoan: "false" }] }).ready, false);
  const fill = { instType: "SPOT", instId: "BTC-USDT", side: "buy", tradeId: "t", fillTime: "20", fillSz: "1" };
  assert.equal(classifyCrossFill(fill, { tdMode: "cash" }, { managedAfter: 10, enabledInstIds: ["BTC-USDT"] }).executionRoute, "spot");
  assert.equal(classifyCrossFill(fill, undefined, { managedAfter: 10, enabledInstIds: ["BTC-USDT"] }), null);
  const ownership = { managedAfter: 10, enabledInstIds: ["BTC-USDT"], systemClOrdIdPrefix: "P1", strategyTag: "STRAT", attemptClOrdIds: ["LEDGER1"] };
  assert.equal(classifyCrossFill(fill, { tdMode: "cross", clOrdId: "P1EXTERNAL", tag: "OTHER" }, ownership).source, "ACCOUNT");
  assert.equal(classifyCrossFill(fill, { tdMode: "cross", clOrdId: "P1OWNED", tag: "STRAT" }, ownership).source, "SYSTEM");
  assert.equal(classifyCrossFill(fill, { tdMode: "cross", clOrdId: "LEDGER1", tag: "OTHER" }, ownership).source, "SYSTEM");
});

test("P1 safe GET retries ordinary transport errors without making mutations retryable", async () => {
  let calls = 0; const delays = [];
  const client = new OkxRestClient({ credentials, sleep: async (ms) => delays.push(ms), fetcher: async () => {
    calls += 1; if (calls < 3) throw new TypeError("connection reset"); return ok([]);
  } });
  await client.systemStatus();
  assert.equal(calls, 3); assert.deepEqual(delays, [1_000, 2_000]);
});

test("P1 recovery endpoints preserve pagination cursors and GET timeout errors retry", async () => {
  let attempts = 0; const urls = []; const delays = [];
  const client = new OkxRestClient({ credentials, sleep: async (ms) => delays.push(ms), fetcher: async (url) => {
    urls.push(url); attempts += 1;
    if (attempts === 1) throw new DOMException("request timed out", "TimeoutError");
    return ok([]);
  } });
  await client.ordersPending("SPOT", { after: "100", before: "200", limit: 50 });
  await client.ordersHistory("MARGIN", { after: "300", limit: 75 });
  await client.ordersHistoryArchive("SPOT", { before: "400", limit: 100 });
  assert.deepEqual(delays, [1_000]);
  assert.match(urls[1], /orders-pending.*after=100.*before=200.*limit=50.*instType=SPOT/);
  assert.match(urls[2], /orders-history.*after=300.*limit=75.*instType=MARGIN/);
  assert.match(urls[3], /orders-history-archive.*before=400.*limit=100.*instType=SPOT/);
});

class FakeSocket {
  constructor() { this.listeners = new Map(); this.sent = []; this.closeCalls = 0; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  send(value) { this.sent.push(value); }
  emit(name, data) { this.listeners.get(name)?.(name === "message" ? { data } : {}); }
  close() { this.closeCalls += 1; this.emit("close"); }
}
function fakeTimers() {
  let sequence = 0; const timeouts = new Map(); const intervals = new Map(); const delays = [];
  return {
    delays,
    setInterval: (fn) => { const id = ++sequence; intervals.set(id, fn); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, delay) => { const id = ++sequence; delays.push(delay); timeouts.set(id, fn); return id; }, clearTimeout: (id) => timeouts.delete(id),
    runIntervals: () => { for (const fn of [...intervals.values()]) fn(); }, runTimeouts: () => { for (const fn of timeouts.values()) fn(); timeouts.clear(); },
  };
}

test("P1 Public WS requires every ACK, normalizes status, permits same-time corrections, isolates watermarks, and reconnects on 64008", () => {
  let now = 0; const sockets = []; const observations = []; const states = []; const timers = fakeTimers();
  const client = new OkxPublicWsClient({ instIds: ["BTC-USDT", "ETH-USDT"], socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, clock: { nowMs: () => now }, timers, random: () => 0.5, onObservation: (event) => observations.push(event), onState: (state) => states.push(state) });
  const ack = (socket, arg) => socket.emit("message", JSON.stringify({ event: "subscribe", arg }));
  client.connect(); sockets[0].emit("open"); ack(sockets[0], { channel: "tickers", instId: "BTC-USDT" }); assert.equal(client.snapshot().baseline, false);
  ack(sockets[0], { channel: "tickers", instId: "ETH-USDT" }); ack(sockets[0], { channel: "instruments", instType: "SPOT" }); ack(sockets[0], { channel: "status" }); assert.equal(client.snapshot().baseline, true);
  sockets[0].emit("message", JSON.stringify({ arg: { channel: "instruments", instType: "SPOT" }, data: [{ instId: "BTC-USDT", uTime: "20" }, { instId: "ETH-USDT", uTime: "10" }] }));
  sockets[0].emit("message", JSON.stringify({ arg: { channel: "instruments", instType: "SPOT" }, data: [{ instId: "BTC-USDT", uTime: "19" }] }));
  sockets[0].emit("message", JSON.stringify({ arg: { channel: "tickers", instId: "BTC-USDT" }, data: [{ instId: "BTC-USDT", ts: "30", last: "1" }] }));
  sockets[0].emit("message", JSON.stringify({ arg: { channel: "tickers", instId: "BTC-USDT" }, data: [{ instId: "BTC-USDT", ts: "30", last: "2" }] }));
  sockets[0].emit("message", JSON.stringify({ arg: { channel: "status" }, data: [{ ts: "40", state: "normal" }] }));
  sockets[0].emit("message", JSON.stringify({ code: "64008" })); timers.runTimeouts(); sockets[1].emit("open");
  ack(sockets[1], { channel: "tickers", instId: "BTC-USDT" }); ack(sockets[1], { channel: "tickers", instId: "ETH-USDT" }); ack(sockets[1], { channel: "instruments", instType: "SPOT" }); ack(sockets[1], { channel: "status" });
  sockets[1].emit("message", JSON.stringify({ arg: { channel: "instruments", instType: "SPOT" }, data: [{ instId: "BTC-USDT", uTime: "1" }] }));
  assert.deepEqual(observations.map(({ instId, ts, generation }) => [instId, ts, generation]), [["BTC-USDT", 20, 1], ["ETH-USDT", 10, 1], ["BTC-USDT", 30, 1], ["BTC-USDT", 30, 1], [undefined, 40, 1], ["BTC-USDT", 1, 2]]); assert.equal(typeof observations[4].ts, "number"); assert.equal(client.generation, 2); assert.ok(states.some((state) => state.baseline));
});

test("P1 WS freshness expires at idleMs and the idle timer actively reconnects", () => {
  let now = 0; const sockets = []; const timers = fakeTimers();
  const client = new OkxPublicWsClient({ instIds: ["BTC-USDT"], idleMs: 10, socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, clock: { nowMs: () => now }, timers, random: () => 0.5 });
  const ack = (arg) => sockets[0].emit("message", JSON.stringify({ event: "subscribe", code: "0", arg }));
  client.connect(); sockets[0].emit("open");
  ack({ channel: "tickers", instId: "BTC-USDT" }); ack({ channel: "instruments", instType: "SPOT" }); ack({ channel: "status" });
  assert.equal(client.fresh, true);
  now = 11;
  assert.equal(client.fresh, false);
  timers.runIntervals();
  assert.equal(sockets[0].closeCalls, 1, "idle interval closes the stale socket");
  assert.equal(client.connected, false); assert.deepEqual(timers.delays, [500]);
  timers.runTimeouts();
  assert.equal(sockets.length, 2, "idle close enters the reconnect flow");
});

test("P1 Private WS retains backoff until login and every subscription succeeds; Business emits only confirmed candles", async () => {
  const sockets = []; const candles = []; const privateEvents = []; const timers = fakeTimers();
  const privateClient = new OkxPrivateWsClient({ credentials, socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, clock: { nowMs: () => 10_000 }, clockSkewMs: () => 5_000, timers, random: () => 0.5, onObservation: (event) => privateEvents.push(event) });
  let signed; const signingClient = new OkxPrivateWsClient({ credentials: { sign: async (text) => { signed = text; return "signature"; } }, socketFactory: () => new FakeSocket() });
  assert.equal(await signingClient.loginSignature("123"), "signature"); assert.equal(signed, "123GET/users/self/verify");
  privateClient.connect(); await privateClient.open(sockets[0]); assert.equal(JSON.parse(sockets[0].sent[0]).args[0].timestamp, "15"); sockets[0].emit("message", JSON.stringify({ event: "login", code: "60009" })); timers.runTimeouts(); assert.equal(sockets.length, 2); assert.deepEqual(timers.delays, [500]);
  await privateClient.open(sockets[1]); sockets[1].emit("message", JSON.stringify({ event: "login", code: "60009" })); assert.deepEqual(timers.delays, [500, 1_000]);
  timers.runTimeouts(); await privateClient.open(sockets[2]); sockets[2].emit("message", JSON.stringify({ event: "login", code: "0" }));
  for (const arg of [{ channel: "account" }, { channel: "balance_and_position" }, { channel: "orders", instType: "ANY" }]) sockets[2].emit("message", JSON.stringify({ event: "subscribe", arg }));
  sockets[2].emit("message", JSON.stringify({ arg: { channel: "balance_and_position" }, data: [{ pTime: "41", uTime: "99", ccy: "USDT" }] }));
  assert.equal(privateClient.retry, 0); assert.equal(privateEvents[0].ts, 41); assert.equal(typeof privateEvents[0].ts, "number");
  const businessSockets = [];
  const business = new OkxBusinessWsClient({ instIds: ["BTC-USDT"], socketFactory: () => { const socket = new FakeSocket(); businessSockets.push(socket); return socket; }, timers, onObservation: (event) => candles.push(event) });
  business.connect(); businessSockets[0].emit("open"); businessSockets[0].emit("message", JSON.stringify({ event: "subscribe", code: "0", arg: { channel: "candle3m", instId: "BTC-USDT" } }));
  businessSockets[0].emit("message", JSON.stringify({ arg: { channel: "candle3m", instId: "BTC-USDT" }, data: [["10", "1", "2", "0.5", "1.5", "0", "0", "0", "0"], ["11", "1", "2", "0.5", "1.5", "0", "0", "0", "1"]] }));
  business.reconnect(); timers.runTimeouts(); businessSockets[0].emit("message", JSON.stringify({ arg: { channel: "candle3m", instId: "BTC-USDT" }, data: [["12", "1", "2", "0.5", "1.5", "0", "0", "0", "1"]] }));
  assert.equal(candles.length, 1); assert.equal(candles[0].confirm, true);
});

test("P1 Private WS signature failure closes the half-open socket and schedules reconnect", async () => {
  const sockets = []; const timers = fakeTimers();
  const client = new OkxPrivateWsClient({ credentials: { ...credentials, sign: async () => { throw new Error("sign failure"); } }, socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, timers, random: () => 0.5 });
  client.connect(); sockets[0].emit("open");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.connected, false); assert.equal(client.baseline, false); assert.deepEqual(timers.delays, [500]);
  timers.runTimeouts(); assert.equal(sockets.length, 2);
});
