import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { composeProductionRuntime } from "../src/application/production-composition.js";
import { PostgresOwnerGuard } from "../src/infrastructure/postgres/owner-guard.js";
import { postgresMigrations } from "../scripts/postgres-migration-manifest.mjs";
import { strategyDay, strategyDayStartMs } from "../src/domain/rules.js";

// End-to-end market scenarios: the real composed runtime (planner, Coordinator,
// SellService, reconciliation, PostgreSQL) trades against a simulated OKX.
const run = promisify(execFile);
const DAY = "2026-09-24";
const HOUR = 3_600_000; const MINUTE = 60_000;
const at = (hour, minute = 0, second = 0, day = DAY) => strategyDayStartMs(day) + hour * HOUR + minute * MINUTE + second * 1_000;
const BUY_FEE_RATE = 0.001;
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));
const text = (value) => String(round(value));

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close((error) => error ? reject(error) : resolve(port)); }); }); }

class FakeSocket {
  constructor(url) { this.url = url; this.listeners = new Map(); queueMicrotask(() => this.emit("open")); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  emit(name, data) { this.listeners.get(name)?.(name === "message" ? { data: JSON.stringify(data) } : {}); }
  send(raw) {
    if (raw === "ping") return;
    const message = JSON.parse(raw);
    queueMicrotask(() => {
      if (message.op === "login") this.emit("message", { event: "login", code: "0" });
      if (message.op === "subscribe") for (const arg of message.args) this.emit("message", { event: "subscribe", code: "0", arg });
    });
  }
  close() { this.emit("close"); }
}

/** A deliberately small OKX: spot book at last/ask/bid, IOC and market fills, base-currency buy fees, autoLoan borrowing detector. */
class FakeOkx {
  constructor({ clock, instruments, usdt }) {
    this.clock = clock; this.usdt = usdt; this.borrowed = 0; this.holdings = new Map(); this.seq = 0; this.orders = new Map(); this.fillRows = [];
    this.instruments = new Map(); this.quotes = new Map(); this.opens = new Map(); this.history = new Map(); this.depth = new Map();
    this.sockets = { public: null, private: null }; this.submitFaults = []; this.submissions = [];
    for (const [instId, open] of Object.entries(instruments)) {
      this.instruments.set(instId, { instId, state: "live", tickSz: "0.01", lotSz: "0.001", minSz: "0.001", baseCcy: instId.split("-")[0], quoteCcy: "USDT", uTime: "1" });
      this.opens.set(instId, open); this.setQuote(instId, open);
    }
  }
  next() { this.seq += 1; return this.clock.value + this.seq; }
  socketFactory = (url) => { const socket = new FakeSocket(url); if (url.includes("/private")) this.sockets.private = socket; else this.sockets.public = socket; return socket; };
  setQuote(instId, last, { ask = last, bid = last } = {}) {
    this.quotes.set(instId, { last: text(last), askPx: text(ask), bidPx: text(bid), ts: this.clock.value });
    const rows = this.history.get(instId) ?? []; rows.push({ ts: this.clock.value, price: Math.min(last, bid) }); this.history.set(instId, rows);
  }
  // A market move: updates the book and pushes one ticker over public WS.
  tick(instId, last, options = {}) {
    this.setQuote(instId, last, options);
    const quote = this.quotes.get(instId);
    this.sockets.public?.emit("message", { arg: { channel: "tickers", instId }, data: [{ instId, ts: String(this.clock.value), last: quote.last, askPx: quote.askPx, bidPx: quote.bidPx }] });
  }
  heartbeat() { for (const [instId, quote] of this.quotes) this.tick(instId, Number(quote.last), { ask: Number(quote.askPx), bid: Number(quote.bidPx) }); this.pushAccount(); }
  equity() { let total = this.usdt; for (const [base, size] of this.holdings) total += size * Number(this.quotes.get(`${base}-USDT`)?.last ?? 0); return Math.max(total, 1); }
  pushAccount() { const equity = text(this.equity()); this.sockets.private?.emit("message", { arg: { channel: "account" }, data: [{ totalEq: equity, adjEq: equity, uTime: String(this.next()) }] }); }
  pushOrder(order) { this.sockets.private?.emit("message", { arg: { channel: "orders", instType: "ANY" }, data: [{ ...order, uTime: String(this.next()) }] }); }
  // REST read port (same method names as OkxRestClient).
  clockSkewMs = 0;
  clockFresh() { return true; }
  async syncServerTime() { return this.clock.value; }
  async systemStatus() { return []; }
  async publicInstruments() { return [...this.instruments.values()]; }
  async tickers() {
    return [...this.quotes].map(([instId, quote]) => {
      const lows = (this.history.get(instId) ?? []).filter((row) => row.ts > this.clock.value - 24 * HOUR && row.ts <= this.clock.value).map((row) => row.price);
      return { instId, ts: String(this.clock.value), last: quote.last, askPx: quote.askPx, bidPx: quote.bidPx, sodUtc8: text(this.opens.get(instId)), low24h: text(Math.min(...lows)) };
    });
  }
  async candles(instId, { bar }) {
    assert.equal(bar, "5m");
    const buckets = new Map();
    for (const row of this.history.get(instId) ?? []) { const ts = Math.floor(row.ts / (5 * MINUTE)) * 5 * MINUTE; buckets.set(ts, Math.min(buckets.get(ts) ?? Infinity, row.price)); }
    return [...buckets].sort((a, b) => b[0] - a[0]).map(([ts, low]) => [String(ts), text(low), text(low), text(low), text(low), "1", "1", "1", "1"]);
  }
  async accountConfig() { return [{ acctLv: "3", autoLoan: "true" }]; }
  async accountInstruments(type) { return [...this.instruments.values()].map((row) => ({ instId: row.instId, state: "live", tradeQuoteCcyList: type === "MARGIN" ? "USDT" : "" })); }
  async leverageInfo() { return []; }
  async balance(ccy) { const details = [{ ccy: "USDT", availBal: text(this.usdt), cashBal: text(this.usdt) }]; return ccy ? [{ details: details.filter((row) => row.ccy === ccy) }] : [{ totalEq: text(this.equity()), adjEq: text(this.equity()), uTime: String(this.next()), details }]; }
  async maxAvailSize(joined) { return joined.split(",").map((instId) => ({ instId, availBuy: text(this.usdt * 3), availSell: text(this.holdings.get(instId.split("-")[0]) ?? 0) })); }
  async announcements() { return []; }
  async order({ clOrdId }) { if (this.lookupDown) throw new Error("simulated order lookup timeout"); const order = this.orders.get(clOrdId); if (!order) throw Object.assign(new Error("OKX code 51603"), { okxCode: "51603" }); return { ...order }; }
  async fills(_instType, params = {}) { return this.fillRows.filter((fill) => (!params.ordId || fill.ordId === params.ordId) && (params.begin == null || Number(fill.fillTime) >= Number(params.begin))); }
  async fillsHistory() { return []; }
  async ordersPending() { return []; }
  async ordersHistory() { return []; }
  async ordersHistoryArchive() { return []; }
  async submitBatchOrders(payloads) {
    return payloads.map((payload) => {
      this.submissions.push({ ...payload, at: this.clock.value });
      const fault = this.submitFaults.find((row) => row.side === payload.side && row.remaining > 0);
      if (fault?.kind === "reject") { fault.remaining -= 1; return { clOrdId: payload.clOrdId, status: "NOT_CREATED", sCode: "51001", reason: "rejected by simulated exchange" }; }
      const order = this.execute(payload);
      if (fault?.kind === "timeout") { fault.remaining -= 1; return { clOrdId: payload.clOrdId, status: "UNKNOWN", reason: "simulated timeout after execution" }; }
      this.pushOrder(order);
      return { clOrdId: payload.clOrdId, status: "SUBMITTED", ordId: order.ordId };
    });
  }
  execute(payload) {
    const quote = this.quotes.get(payload.instId); const base = payload.instId.split("-")[0]; const size = Number(payload.sz);
    const ordId = `o${this.next()}`; let filled = 0; let price = 0; let fee = 0;
    if (payload.side === "buy") {
      assert.equal(payload.ordType, "ioc"); price = Number(quote.askPx);
      if (price <= Number(payload.px)) filled = Math.min(size, this.depth.get(payload.instId) ?? Infinity);
      const cost = filled * price;
      if (cost > this.usdt + 1e-9) this.borrowed += cost - this.usdt;
      this.usdt = round(this.usdt - cost); fee = round(filled * BUY_FEE_RATE);
      this.holdings.set(base, round((this.holdings.get(base) ?? 0) + filled - fee));
    } else {
      assert.equal(payload.ordType, "market"); price = Number(quote.bidPx);
      filled = Math.min(size, this.holdings.get(base) ?? 0);
      this.holdings.set(base, round((this.holdings.get(base) ?? 0) - filled)); this.usdt = round(this.usdt + filled * price);
    }
    const order = { instId: payload.instId, ordId, clOrdId: payload.clOrdId, side: payload.side, tdMode: payload.tdMode, tag: payload.tag, ordType: payload.ordType, px: payload.px, sz: payload.sz, accFillSz: text(filled), avgPx: text(price), state: filled === size ? "filled" : "canceled" };
    this.orders.set(payload.clOrdId, order);
    if (filled > 0) this.fillRows.push({ instId: payload.instId, instType: "SPOT", side: payload.side, tradeId: `t${this.next()}`, billId: String(this.next()), ordId, clOrdId: payload.clOrdId, fillSz: text(filled), fillPx: text(price), fillTime: String(this.clock.value), fee: payload.side === "buy" ? text(-fee) : "0", feeCcy: payload.side === "buy" ? base : "USDT" });
    this.pushAccount();
    return order;
  }
}

function fakeTimers(clock) {
  const pending = new Map(); let id = 0;
  return {
    setTimeout(fn, ms) { id += 1; pending.set(id, { fn, due: clock.value + ms }); return id; },
    clearTimeout(handle) { pending.delete(handle); },
    setInterval() { id += 1; return id; }, clearInterval() {},
    flush({ all = false } = {}) { let ran = 0; for (const [handle, row] of [...pending]) if (all || row.due <= clock.value) { pending.delete(handle); row.fn(); ran += 1; } return ran; },
  };
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

const settle = async (count = 5) => { for (let index = 0; index < count; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

async function scenario(cluster, name, { instruments, usdt = 1000, startAt = at(8), blacklist = [], beforeStart = () => {} }) {
  await cluster.admin.query(`CREATE DATABASE ${name}`);
  const connection = { host: "127.0.0.1", port: cluster.port, user: process.env.USER, database: name };
  const setup = new pg.Client(connection); await setup.connect();
  for (const migration of postgresMigrations) await setup.query(await readFile(new URL(`../migrations/postgres/${migration}`, import.meta.url), "utf8"));
  for (const instId of blacklist) await setup.query("INSERT INTO instrument_protection(inst_id,base_ccy,state,reason) VALUES($1,$2,'BLACKLISTED','scenario blacklist')", [instId, instId.split("-")[0]]);
  await setup.end();
  const clock = { value: startAt, nowMs() { return this.value; } };
  const ex = new FakeOkx({ clock, instruments, usdt });
  beforeStart(ex, clock);
  const pool = new pg.Pool({ ...connection, max: 4 }); const ownerClient = new pg.Client(connection); await ownerClient.connect();
  const timers = fakeTimers(clock); const events = [];
  const composed = await composeProductionRuntime({ TRADING_MODE: "FULL", KEY_VAULT_URI: "https://vault.example", POSTGRES_URL: "postgresql://local/scenario" }, {
    runtime: { clock }, timers, socketFactory: ex.socketFactory, rest: ex, ownerClient, ownerGuard: new PostgresOwnerGuard(ownerClient, `scenario-${name}`),
    keyVault: { readOkxCredentials: async () => ({ apiKey: "a", secretKey: "b", passphrase: "c" }) },
    pool: { query: (...args) => pool.query(...args), transaction: (fn) => transaction(pool, fn), end: () => pool.end() },
    telemetry: (event) => events.push(event), workLoop: { start() {}, stop() {} },
  });
  const starting = composed.start(); let started = false; starting.finally(() => { started = true; }).catch(() => {});
  while (!started) { timers.flush({ all: true }); await settle(1); }
  await starting; await settle(); ex.pushAccount(); await settle();
  assert.equal(composed.readyGate.ready, true, JSON.stringify(composed.readyGate.snapshot()));
  const db = (sql, params = []) => pool.query(sql, params).then((result) => result.rows);
  // One pass of the engine: WS events, planner decisions, the serial order
  // queue, sell reviews and short confirmation timers, until quiescent.
  const pump = async () => {
    for (let round = 0; round < 50; round += 1) {
      let progressed = timers.flush() > 0;
      await Promise.allSettled([...composed.exitConfirmation.running]);
      await composed.buyPlanner.primePromise?.catch(() => {}); await composed.buyPlanner.refillPromise;
      while (composed.engine.queue.size) { await composed.engine.consumeOne(); progressed = true; }
      await composed.recurring.reviewSells();
      while (composed.engine.queue.size) { await composed.engine.consumeOne(); progressed = true; }
      for (let drains = 0; drains < 20; drains += 1) {
        const result = await composed.coordinator.drainOnce();
        // Mirrors EngineWorkLoop, which re-drains every 10 ms: only an idle
        // or deliberately waiting queue ends this pass.
        if (!result.submitted && ["EMPTY", "NO_ELIGIBLE", "CAPITAL_EXHAUSTED", "CAPACITY_RETRY_WAIT", "SLOT_BUSY", "RESERVATION_DENIED"].includes(result.reason)) break;
        progressed = true;
      }
      await settle(2);
      if (!progressed && !composed.engine.queue.size) return;
    }
    throw new Error("scenario did not quiesce");
  };
  // Time passes with ordinary market heartbeats and account pushes.
  const advanceTo = async (ms) => { assert.ok(ms >= clock.value, "scenario time only moves forward"); clock.value = ms; ex.heartbeat(); await settle(); await pump(); };
  // OKX also pushes the account channel on a regular interval.
  const move = async (instId, last, options) => { clock.value += 1_000; ex.tick(instId, last, options); ex.pushAccount(); await settle(); await pump(); };
  const buys = () => ex.submissions.filter((row) => row.side === "buy");
  const sells = () => ex.submissions.filter((row) => row.side === "sell");
  const ledger = () => db("SELECT inst_id, fill_size::text, disposed_size::text, fill_price::text, sell_state, sell_time, sell_trigger_reason FROM filled_orders WHERE side='BUY' ORDER BY fill_time, trade_id");
  const decisions = (instId) => events.filter((event) => event.type === "trading_decision" && event.instId === instId).map((event) => event.reason);
  const close = async () => { await composed.stopTimers(); await composed.closeWebSockets(); await composed.releaseOwner(); await composed.closeDatabase(); };
  return { ex, clock, composed, events, db, pump, advanceTo, move, buys, sells, ledger, decisions, close };
}

async function startCluster() {
  const dir = await mkdtemp(join(tmpdir(), "crypto-panic-scenarios-")); const port = await freePort(); const log = join(dir, "postgres.log");
  await run("initdb", ["-D", dir, "--no-locale", "-E", "UTF8", "-A", "trust"]);
  await run("pg_ctl", ["-D", dir, "-l", log, "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"]);
  const admin = new pg.Client({ host: "127.0.0.1", port, user: process.env.USER, database: "postgres" }); await admin.connect();
  return { port, admin, async stop() { await admin.end(); await run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]); await rm(dir, { recursive: true, force: true }); } };
}

const EIGHT = { "A-USDT": 100, "B-USDT": 100, "C-USDT": 100, "D-USDT": 100, "E-USDT": 100, "F-USDT": 100, "G-USDT": 50, "H-USDT": 2 };

test("panic-rebound scenarios against a simulated OKX and real PostgreSQL", { timeout: 180_000 }, async (t) => {
  const cluster = await startCluster();
  try {
    await t.test("classic panic: first two skipped, first 72% buys with all owned USDT, leftover buys the next, both sold at 23:59", async () => {
      const s = await scenario(cluster, "classic", { instruments: EIGHT });
      try {
        await s.advanceTo(at(10));
        await s.move("A-USDT", 81); await s.move("B-USDT", 80); await s.move("A-USDT", 60);
        await s.move("C-USDT", 81.5);
        assert.equal(s.buys().length, 0, "the first two never buy, even at -40%");
        await s.move("D-USDT", 71, { ask: 71.2 });
        assert.equal(s.buys().length, 1);
        assert.deepEqual([s.buys()[0].instId, s.buys()[0].px, s.buys()[0].ordType, s.buys()[0].sz], ["D-USDT", "72", "ioc", "13.881"], "IOC at the 72% limit, sized from 1000 owned USDT");
        await s.move("C-USDT", 71.9);
        assert.deepEqual(s.buys().map((row) => row.instId), ["D-USDT", "C-USDT"], "the leftover ~12 USDT buys the next candidate");
        await s.move("E-USDT", 70); await s.move("F-USDT", 50);
        assert.equal(s.buys().length, 2, "no money left: later candidates are not bought and nothing is borrowed");
        assert.equal(s.ex.borrowed, 0); assert.ok(s.ex.usdt >= 0 && s.ex.usdt < 10, `owned USDT spent: ${s.ex.usdt}`);
        let ledger = await s.ledger();
        assert.deepEqual(ledger.map((row) => [row.inst_id, row.sell_state, Number(row.sell_time)]), [["D-USDT", "WAITING", at(23, 59)], ["C-USDT", "WAITING", at(23, 59)]]);
        const ranks = await s.db("SELECT inst_id FROM panic_daily_instruments WHERE count_hit_at IS NOT NULL ORDER BY count_hit_at, inst_id");
        assert.deepEqual(ranks.map((row) => row.inst_id), ["A-USDT", "B-USDT", "C-USDT", "D-USDT", "E-USDT", "F-USDT"]);
        // Price keeps crashing: no stop loss.
        await s.move("D-USDT", 40); await s.advanceTo(at(23, 58));
        assert.equal(s.sells().length, 0, "no stop loss and no early take-profit");
        await s.move("D-USDT", 90); await s.move("C-USDT", 95);
        assert.equal(s.sells().length, 0, "a big rebound does not sell before the close either");
        await s.advanceTo(at(23, 59));
        assert.deepEqual(s.sells().map((row) => [row.instId, row.ordType, row.at]).sort(), [["C-USDT", "market", at(23, 59)], ["D-USDT", "market", at(23, 59)]]);
        ledger = await s.ledger();
        assert.ok(ledger.every((row) => ["SOLD", "DUST_PENDING"].includes(row.sell_state)), JSON.stringify(ledger));
        assert.ok(ledger.every((row) => Number(row.fill_size) - Number(row.disposed_size) <= Number(row.fill_size) * BUY_FEE_RATE + 0.001 + 1e-9), "only the base-currency buy fee and lot rounding remain");
        assert.ok(s.ex.usdt > 1_200, `rebound profit realised: ${s.ex.usdt}`);
        await s.move("E-USDT", 69); await s.advanceTo(at(23, 59, 40));
        assert.deepEqual(s.buys().map((row) => row.instId), ["D-USDT", "C-USDT"], "USDT returned by the close sells is not recycled into new buys the same day");
        assert.equal(s.decisions("E-USDT").at(-1), "DAY_CLOSED");
      } finally { await s.close(); }
    });

    await t.test("only two symbols panic: nothing is bought all day", async () => {
      const s = await scenario(cluster, "twoonly", { instruments: EIGHT });
      try {
        await s.advanceTo(at(9));
        await s.move("A-USDT", 81); await s.move("B-USDT", 70); await s.move("A-USDT", 50);
        await s.move("C-USDT", 83); await s.move("D-USDT", 82.01);
        await s.advanceTo(at(23, 59, 30));
        assert.equal(s.buys().length, 0); assert.equal(s.sells().length, 0);
        assert.deepEqual(s.decisions("B-USDT").at(-1), "SKIPPED_FIRST_TWO");
        assert.equal(s.decisions("C-USDT").at(-1), "ABOVE_COUNT_PRICE", "83 is not an 82% touch");
      } finally { await s.close(); }
    });

    await t.test("blacklisted symbols count toward the tally but are never bought", async () => {
      const s = await scenario(cluster, "blacklist", { instruments: EIGHT, blacklist: ["C-USDT"] });
      try {
        await s.advanceTo(at(11));
        await s.move("A-USDT", 81); await s.move("B-USDT", 81);
        await s.move("C-USDT", 65);
        assert.equal(s.buys().length, 0, "C is the 3rd touch but blacklisted");
        assert.equal(s.decisions("C-USDT").at(-1), "INSTRUMENT_PROTECTED");
        await s.move("D-USDT", 71.5);
        assert.deepEqual(s.buys().map((row) => row.instId), ["D-USDT"], "D is the 4th touch because the blacklisted C counted");
      } finally { await s.close(); }
    });

    await t.test("ask above the limit waits; a thin book partially fills and the same symbol tops up on the next tick", async () => {
      const s = await scenario(cluster, "askbook", { instruments: EIGHT });
      try {
        await s.advanceTo(at(12));
        await s.move("A-USDT", 81); await s.move("B-USDT", 81);
        await s.move("C-USDT", 71.8, { ask: 72.3 });
        assert.equal(s.buys().length, 0, "an IOC at 72 cannot fill against a 72.3 ask");
        assert.equal(s.decisions("C-USDT").at(-1), "ASK_ABOVE_LIMIT");
        s.ex.depth.set("C-USDT", 5);
        await s.move("C-USDT", 71.8, { ask: 71.9 });
        assert.equal(s.buys().length, 1); assert.equal((await s.ledger())[0].fill_size, "5", "only 5 units were on the book");
        s.ex.depth.delete("C-USDT");
        await s.move("C-USDT", 71.7, { ask: 71.8 });
        assert.equal(s.buys().length, 2, "the same symbol is retried with the leftover USDT");
        assert.ok(Number(s.buys()[1].sz) > 8 && Number(s.buys()[1].sz) < 9, `top-up size ${s.buys()[1].sz}`);
        await s.move("C-USDT", 90); await s.move("C-USDT", 71, { ask: 71.1 });
        assert.equal(s.buys().length, 2, "no money left: dips again do not add more");
        assert.equal(s.ex.borrowed, 0);
      } finally { await s.close(); }
    });

    await t.test("a 22:00 buy holds 3 hours, blocks the next day's buys until sold, then the next day's candidate buys", async () => {
      const s = await scenario(cluster, "overnight", { instruments: EIGHT, startAt: at(21, 30) });
      try {
        await s.advanceTo(at(22));
        await s.move("A-USDT", 81); await s.move("B-USDT", 81); await s.move("C-USDT", 71);
        assert.equal(s.buys().length, 1);
        assert.equal(Number((await s.ledger())[0].sell_time), at(22) + 3 * 1_000 + 3 * HOUR, "sell time is fill + 3h (01:00 next day)");
        await s.advanceTo(at(23, 59, 30));
        assert.equal(s.sells().length, 0, "not sold at 23:59: less than 3 hours held");
        // Next day: new opens, a new panic while yesterday's position is still open.
        const next = "2026-09-25";
        for (const instId of Object.keys(EIGHT)) s.ex.opens.set(instId, Number(s.ex.quotes.get(instId).last));
        await s.advanceTo(at(0, 10, 0, next));
        assert.equal(s.composed.buyPlanner.currentDay, next);
        await s.move("D-USDT", 81); await s.move("E-USDT", 81); await s.move("F-USDT", 71);
        assert.equal(s.buys().length, 1, "yesterday's position is still open");
        assert.equal(s.decisions("F-USDT").at(-1), "PRIOR_POSITION_OPEN");
        await s.advanceTo(at(22, 0, 3) + 3 * HOUR);
        assert.deepEqual(s.sells().map((row) => row.instId), ["C-USDT"]);
        await s.move("F-USDT", 70.5);
        assert.deepEqual(s.buys().map((row) => row.instId), ["C-USDT", "F-USDT"], "after the sale the still-qualifying candidate buys");
        assert.equal(strategyDay(s.buys()[1].at), next);
      } finally { await s.close(); }
    });

    await t.test("a timed-out buy that actually filled blocks only its symbol, the next symbol sizes from the real balance, and the fill is recovered and sold", async () => {
      const s = await scenario(cluster, "timeout", { instruments: EIGHT });
      try {
        await s.advanceTo(at(13));
        await s.move("A-USDT", 81); await s.move("B-USDT", 81);
        s.ex.submitFaults.push({ side: "buy", kind: "timeout", remaining: 1 }); s.ex.lookupDown = true;
        await s.move("C-USDT", 71);
        assert.equal(s.buys().length, 1); assert.equal((await s.ledger()).length, 0, "the UNKNOWN fill is not yet known locally");
        await s.move("C-USDT", 70.5);
        assert.equal(s.buys().length, 1, "the UNKNOWN symbol is not re-bought while its outcome is unknown");
        assert.equal(s.decisions("C-USDT").at(-1), "ACTIVE_BUY_ATTEMPT");
        await s.move("D-USDT", 71);
        assert.deepEqual(s.buys().map((row) => row.instId), ["C-USDT", "D-USDT"], "the queue moves on to the next symbol");
        assert.ok(Number(s.buys()[1].sz) < 0.25, `the fresh balance already reflects the hidden fill: ${s.buys()[1].sz}`);
        assert.equal(s.ex.borrowed, 0);
        s.ex.lookupDown = false;
        await s.advanceTo(at(13, 0, 15));
        const ledger = await s.ledger();
        assert.deepEqual(ledger.map((row) => [row.inst_id, row.sell_state]), [["C-USDT", "WAITING"], ["D-USDT", "WAITING"]], "the confirmation loop recovers the executed order");
        const attempts = await s.db("SELECT inst_id, state, reservation_state FROM order_attempts WHERE intent='BUY' ORDER BY inst_id");
        assert.deepEqual(attempts, [{ inst_id: "C-USDT", state: "SETTLED", reservation_state: "CONVERTED" }, { inst_id: "D-USDT", state: "SETTLED", reservation_state: "CONVERTED" }]);
        await s.advanceTo(at(23, 59));
        assert.deepEqual(s.sells().map((row) => row.instId).sort(), ["C-USDT", "D-USDT"]);
      } finally { await s.close(); }
    });

    await t.test("rejected close sells are retried until the position is sold", async () => {
      const s = await scenario(cluster, "sellretry", { instruments: EIGHT });
      try {
        await s.advanceTo(at(14));
        await s.move("A-USDT", 81); await s.move("B-USDT", 81); await s.move("C-USDT", 71);
        s.ex.submitFaults.push({ side: "sell", kind: "reject", remaining: 3 });
        await s.advanceTo(at(23, 59));
        assert.equal(s.sells().length, 1);
        await s.advanceTo(at(23, 59, 2));
        assert.equal(s.sells().length, 2, "one immediate retry with a new generation");
        await s.advanceTo(at(23, 59, 20));
        assert.equal((await s.ledger())[0].sell_state, "SELL_TRIGGERED", "retries exhausted, still waiting");
        await s.advanceTo(at(23, 59, 40));
        assert.equal(s.sells().length, 3, "the stalled exit is re-driven by the sell review");
        await s.advanceTo(at(23, 59, 45));
        const ledger = await s.ledger();
        assert.ok(["SOLD", "DUST_PENDING"].includes(ledger[0].sell_state), JSON.stringify(ledger));
        assert.ok(s.sells().length >= 4);
      } finally { await s.close(); }
    });

    await t.test("a restart after the first two touches backfills them, so the 3rd touch after restart is bought", async () => {
      const s = await scenario(cluster, "restart", { instruments: EIGHT, startAt: at(10, 30), beforeStart: (ex, clock) => {
        // While the engine was down: A and B wicked through 82% and recovered.
        clock.value = at(9, 5); ex.setQuote("A-USDT", 80); clock.value = at(9, 6); ex.setQuote("A-USDT", 95);
        clock.value = at(9, 20); ex.setQuote("B-USDT", 81); clock.value = at(9, 21); ex.setQuote("B-USDT", 96);
        clock.value = at(10, 30);
      } });
      try {
        const hits = await s.db("SELECT inst_id, count_hit_source FROM panic_daily_instruments WHERE count_hit_at IS NOT NULL ORDER BY count_hit_at");
        assert.deepEqual(hits, [{ inst_id: "A-USDT", count_hit_source: "BACKFILL" }, { inst_id: "B-USDT", count_hit_source: "BACKFILL" }]);
        await s.advanceTo(at(10, 31));
        await s.move("C-USDT", 71);
        assert.deepEqual(s.buys().map((row) => row.instId), ["C-USDT"], "without the backfill C would have been ranked 1st and skipped");
      } finally { await s.close(); }
    });

    await t.test("yesterday's fee dust never blocks today's buys", async () => {
      const s = await scenario(cluster, "dust", { instruments: EIGHT });
      try {
        await s.advanceTo(at(10));
        await s.move("A-USDT", 81); await s.move("B-USDT", 81); await s.move("C-USDT", 71);
        await s.advanceTo(at(23, 59));
        const dust = await s.ledger();
        assert.equal(dust[0].sell_state, "DUST_PENDING", "the base-currency buy fee leaves an unsellable remainder");
        assert.ok(Number(dust[0].fill_size) > Number(dust[0].disposed_size));
        const next = "2026-09-25";
        for (const instId of Object.keys(EIGHT)) s.ex.opens.set(instId, Number(s.ex.quotes.get(instId).last));
        await s.advanceTo(at(0, 30, 0, next));
        const open = (instId) => s.ex.opens.get(instId);
        await s.move("D-USDT", open("D-USDT") * 0.8); await s.move("E-USDT", open("E-USDT") * 0.8); await s.move("F-USDT", open("F-USDT") * 0.7);
        assert.deepEqual(s.buys().map((row) => row.instId), ["C-USDT", "F-USDT"], "yesterday's dust is not an open position, and yesterday's 72% limit is never reused");
        assert.equal(Number(s.buys()[1].px), Math.floor(s.ex.opens.get("F-USDT") * 72) / 100, "F buys at its own new-day 72% limit");
      } finally { await s.close(); }
    });

    await t.test("different opens: thresholds follow each symbol's own UTC+8 open", async () => {
      const s = await scenario(cluster, "opens", { instruments: EIGHT });
      try {
        await s.advanceTo(at(15));
        await s.move("G-USDT", 41); await s.move("H-USDT", 1.64);
        await s.move("A-USDT", 82);
        await s.move("B-USDT", 72.01);
        assert.equal(s.buys().length, 0, "72.01 is above B's 72 limit");
        await s.move("H-USDT", 1.44);
        assert.equal(s.buys().length, 0, "H is one of the first two (G 41/50, H 1.64/2)");
        await s.move("B-USDT", 72, { ask: 72 });
        assert.deepEqual(s.buys().map((row) => [row.instId, row.px]), [["B-USDT", "72"]], "an exact 72% touch buys");
      } finally { await s.close(); }
    });
  } finally { await cluster.stop(); }
});
