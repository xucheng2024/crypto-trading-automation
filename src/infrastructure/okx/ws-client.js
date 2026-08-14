import { OKX_PROFILES } from "./rest-client.js";

const encoder = new TextEncoder();
function base64(bytes) { let text = ""; for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte); return btoa(text); }

const subscriptions = {
  public: (instIds) => [...instIds.map((instId) => ({ channel: "tickers", instId })), { channel: "instruments", instType: "SPOT" }, { channel: "status" }],
  private: () => [{ channel: "account" }, { channel: "balance_and_position" }, { channel: "orders", instType: "ANY" }],
  business: (instIds) => instIds.map((instId) => ({ channel: "candle5m", instId })),
};

function key(arg, row = {}) { return `${arg.channel}:${row.instId || row.ccy || arg.instId || arg.instType || ""}`; }
function normalize(kind, arg, row) {
  if (kind === "public" && arg.channel === "tickers") return { type: "ticker", instId: row.instId, ts: Number(row.ts), last: row.last, askPx: row.askPx, bidPx: row.bidPx };
  if (kind === "public" && arg.channel === "instruments") return { type: "instrument", instId: row.instId, ts: Number(row.uTime || row.ts || 0), state: row.state, tickSz: row.tickSz, lotSz: row.lotSz, minSz: row.minSz, expTime: row.expTime, base: row.baseCcy ?? row.instId?.split("-")[0], quote: row.quoteCcy ?? row.instId?.split("-")[1], version: row.uTime ?? row.ts ?? "1" };
  if (kind === "public" && arg.channel === "status") return { ...row, type: "status", ts: Number(row.ts || 0) };
  if (kind === "private") return { ...row, type: arg.channel, ts: Number(row.pTime || row.uTime || row.ts || 0) };
  if (kind === "business" && arg.channel === "candle5m") {
    const [ts, open, high, low, close, volume, volumeCcy, volumeCcyQuote, confirm] = row;
    if (String(confirm) !== "1") return null;
    return { type: "candle5m", instId: arg.instId, ts: Number(ts), open, high, low, close, volume, volumeCcy, volumeCcyQuote, confirm: true };
  }
  return null;
}

export class OkxWsClient {
  constructor({ kind, instIds = [], credentials = {}, profile = OKX_PROFILES.GLOBAL, socketFactory, clock = { nowMs: () => Date.now() }, random = Math.random, timers = globalThis, idleMs = 20_000, onObservation = () => {}, onState = () => {} }) {
    if (!subscriptions[kind] || typeof socketFactory !== "function") throw new TypeError("kind and socketFactory are required");
    this.kind = kind; this.instIds = instIds; this.credentials = credentials; this.profile = profile; this.socketFactory = socketFactory; this.clock = clock; this.random = random; this.timers = timers; this.idleMs = idleMs; this.onObservation = onObservation; this.onState = onState;
    this.generation = 0; this.connected = false; this.baseline = false; this.lastMessageAt = 0; this.lastTs = new Map(); this.pendingAcks = new Set(); this.retry = 0; this.socket = null; this.pingTimer = null; this.reconnectTimer = null;
  }
  get url() { return this.profile[`${this.kind}WsUrl`]; }
  get fresh() { return this.connected && this.baseline && this.clock.nowMs() - this.lastMessageAt <= this.idleMs; }
  snapshot() { return { kind: this.kind, generation: this.generation, connected: this.connected, baseline: this.baseline, fresh: this.fresh }; }
  emitState() { this.onState(this.snapshot()); }
  connect() {
    if (this.socket) return;
    const socket = this.socketFactory(this.url); this.socket = socket;
    socket.addEventListener("open", () => { void this.open(socket).catch(() => this.failOpen(socket)); }); socket.addEventListener("message", (event) => this.message(socket, event)); socket.addEventListener("close", () => this.close(socket)); socket.addEventListener("error", () => {});
  }
  async open(socket) {
    if (socket !== this.socket) return;
    this.generation += 1; this.connected = true; this.baseline = false; this.lastTs.clear(); this.pendingAcks.clear(); this.lastMessageAt = this.clock.nowMs();
    if (this.kind === "private") {
      const timestamp = String(Math.floor(this.clock.nowMs() / 1000));
      const sign = await this.loginSignature(timestamp);
      if (socket !== this.socket) return;
      socket.send(JSON.stringify({ op: "login", args: [{ apiKey: this.credentials.apiKey, passphrase: this.credentials.passphrase, timestamp, sign }] }));
    }
    else this.subscribe();
    this.pingTimer = this.timers.setInterval(() => { if (!this.fresh) this.reconnect(); else socket.send("ping"); }, Math.max(1, Math.floor(this.idleMs / 2)));
    this.emitState();
  }
  failOpen(socket) {
    if (socket !== this.socket) return;
    try { socket.close?.(); } finally { this.close(socket); }
  }
  async loginSignature(timestamp) {
    if (typeof this.credentials.sign === "function") return this.credentials.sign(`${timestamp}GET/users/self/verify`);
    if (!this.credentials.secretKey) throw new Error("OKX WebSocket secretKey is required");
    const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(this.credentials.secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`${timestamp}GET/users/self/verify`)));
  }
  subscribe() {
    if (!this.socket) return;
    const args = subscriptions[this.kind](this.instIds);
    this.pendingAcks = new Set(args.map(key));
    this.socket.send(JSON.stringify({ op: "subscribe", args }));
    if (this.pendingAcks.size === 0) { this.baseline = true; this.retry = 0; this.emitState(); }
  }
  message(socket, event) {
    if (socket !== this.socket) return;
    this.lastMessageAt = this.clock.nowMs();
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    if (raw === "pong") return;
    let message; try { message = JSON.parse(raw); } catch { return; }
    if (message.code === "64008") return this.reconnect();
    if (message.event === "login") { if (message.code !== "0") return this.reconnect(); this.subscribe(); return; }
    if (message.event === "subscribe") {
      if (message.code !== "0" || !message.arg || !this.pendingAcks.delete(key(message.arg))) return this.reconnect();
      if (this.pendingAcks.size === 0) { this.baseline = true; this.retry = 0; this.emitState(); }
      return;
    }
    const arg = message.arg;
    if (!arg || !Array.isArray(message.data)) return;
    for (const row of message.data) {
      const observation = normalize(this.kind, arg, row); if (!observation) continue;
      const observationKey = key(arg, observation); const previous = this.lastTs.get(observationKey);
      if (previous !== undefined && observation.ts < previous) continue;
      this.lastTs.set(observationKey, observation.ts);
      this.onObservation({ ...observation, generation: this.generation });
    }
  }
  close(socket) { if (socket !== this.socket) return; this.socket = null; this.connected = false; this.baseline = false; if (this.pingTimer) this.timers.clearInterval(this.pingTimer); this.pingTimer = null; this.emitState(); this.scheduleReconnect(); }
  reconnect() { if (this.socket?.close) this.socket.close(); else this.close(this.socket); }
  scheduleReconnect() { if (this.reconnectTimer) return; const delay = Math.min(30_000, 500 * 2 ** this.retry) * (0.5 + this.random()); this.retry += 1; this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay); }
  stop() { if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer); if (this.pingTimer) this.timers.clearInterval(this.pingTimer); this.reconnectTimer = this.pingTimer = null; const socket = this.socket; this.socket = null; if (socket?.close) socket.close(); this.connected = this.baseline = false; this.emitState(); }
}

export class OkxPublicWsClient extends OkxWsClient { constructor(options) { super({ ...options, kind: "public" }); } }
export class OkxPrivateWsClient extends OkxWsClient { constructor(options) { super({ ...options, kind: "private" }); } }
export class OkxBusinessWsClient extends OkxWsClient { constructor(options) { super({ ...options, kind: "business" }); } }
