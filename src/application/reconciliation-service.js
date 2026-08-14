import { classifyManagedFill } from "../infrastructure/okx/rest-client.js";
import { addDecimal, compareDecimal } from "../decimal.js";

// Observability must never become part of the reconciliation correctness path.
// Ports are intentionally fire-and-forget: both a synchronous throw and a
// rejected promise are contained here.
function emit(port, event) { try { Promise.resolve(port(event)).catch(() => {}); } catch { /* telemetry is best effort */ } }

function keyOf(fill) { return `${fill.instId}:${fill.tradeId}`; }
function fillKey(fill) { return [Number(fill.fillTime), /^\d+$/.test(String(fill.billId ?? "")) ? BigInt(fill.billId) : -1n, String(fill.tradeId)].map(String).join(":"); }
function normalizePage(value) { return Array.isArray(value) ? { rows: value, cursor: null } : { rows: value?.data ?? value?.rows ?? [], cursor: value?.next ?? value?.cursor ?? null }; }

/** Read-only reconciliation and ACCOUNT fill ingestion; it never invokes mutation transport. */
export class ReconciliationService {
  constructor({ orders, state, transport, ownerGuard, readyGate, clock = { nowMs: () => Date.now() }, sleep = async () => {}, safetyWaitMs, telemetry = () => {}, transaction = async (fn) => fn(null), ownership = {}, onAccountBuy = () => {}, onRecovery = async () => {}, onTerminal = async () => {} }) {
    Object.assign(this, { orders, state, transport, ownerGuard, readyGate, clock, sleep, safetyWaitMs, telemetry, transaction, ownership, onAccountBuy, onRecovery, onTerminal });
    if (!Number.isFinite(safetyWaitMs) || safetyWaitMs < 0) throw new TypeError("safetyWaitMs is required");
    // Session advisory locks disappear with their connection. READY must disappear in the
    // same turn; reacquisition always goes through recover() and its safety wait.
    this.ownerGuard.onLost?.(() => {
      this.readyGate.set("owner", false);
      emit(this.telemetry, { type: "owner_lost", reason: "SESSION_ADVISORY_LOCK_LOST" });
    });
  }
  async recover({ accountId, scopes = ["public", "private", "business"], strategyDay } = {}) {
    this.readyGate.set("owner", false); for (const scope of scopes) this.readyGate.set(scope, false);
    if (!this.ownerGuard.isHeld()) return { ready: false, reason: "OWNER_NOT_HELD" };
    this.readyGate.set("owner", true); await this.sleep(this.safetyWaitMs);
    const [protection, daily, ledger, attempts, buyAttempts, watermarks] = await this.transaction((tx) => Promise.all([
      this.state.listProtection?.(tx, accountId) ?? [], this.state.listDaily?.(tx, accountId) ?? [], this.state.listManagedFills?.(tx, accountId) ?? [],
      this.orders.listNonTerminal?.(tx, accountId) ?? [], this.orders.listTodayBuys?.(tx, accountId, strategyDay) ?? [], this.orders.listWatermarks?.(tx, accountId) ?? [],
    ]));
    const recovered = await this.reconcileAll({ accountId, attempts, watermarks });
    // Consumers rebuild their in-memory watch/index strictly from this
    // durable snapshot before READY can be restored by baseline completion.
    await this.onRecovery({ protection, daily, ledger, attempts, buyAttempts, watermarks, recovered });
    emit(this.telemetry, { type: "recovery_loaded", protection: protection.length, daily: daily.length, fills: ledger.length, attempts: attempts.length, buyAttempts: buyAttempts.length, watermarks: watermarks.length, recovered: recovered.length });
    return { ready: false, reason: "BASELINES_REQUIRED", attempts, buyAttempts, recovered };
  }
  async pages(read, initial = {}) {
    const rows = []; let cursor = initial; let guard = 0;
    while (guard++ < 10_000) {
      const page = normalizePage(await read(cursor)); rows.push(...page.rows);
      if (!page.cursor || page.rows.length === 0) break;
      cursor = { ...initial, after: page.cursor };
    }
    return rows;
  }
  async recoverFills({ accountId, instTypes = ["SPOT", "MARGIN"], overlapBegin = 0 }) {
    if (typeof this.transport.fills !== "function" || typeof this.transport.fillsHistory !== "function") return [];
    const raw = [];
    for (const instType of instTypes) {
      raw.push(...await this.pages((cursor) => this.transport.fills(instType, { begin: overlapBegin, ...cursor })));
      raw.push(...await this.pages((cursor) => this.transport.fillsHistory(instType, { begin: overlapBegin, ...cursor })));
    }
    const unique = [...new Map(raw.filter((fill) => fill?.instId && fill?.tradeId).map((fill) => [keyOf(fill), fill])).values()]
      .sort((a, b) => fillKey(a).localeCompare(fillKey(b), undefined, { numeric: true }));
    await this.transaction(async (tx) => {
      for (const fill of unique) {
        const order = typeof this.transport.order === "function" ? await this.transport.order({ instId: fill.instId, ordId: fill.ordId, clOrdId: fill.clOrdId }) : null;
        await this.ingestFill(tx, fill, order);
      }
      for (const instType of instTypes) await this.orders.upsertWatermark?.(tx, { accountId, instType, endpoint: "fills", watermark: unique.at(-1)?.fillTime ?? overlapBegin, overlapBegin, healthy: true });
    });
    return unique;
  }
  async reconcileAll({ accountId, attempts, watermarks }) {
    const observations = [];
    for (const attempt of attempts) observations.push(await this.reconcileAttempt(attempt));
    const overlap = Math.min(...watermarks.filter((row) => row.endpoint === "fills" && row.healthy).map((row) => Number(row.overlap_begin ?? row.overlapBegin ?? 0)), 0);
    if (accountId) await this.recoverFills({ accountId, overlapBegin: overlap });
    return observations;
  }
  async reconcileAttempt(attempt) {
    const instId = attempt.inst_id ?? attempt.instId; const clOrdId = attempt.cl_ord_id ?? attempt.clOrdId;
    let direct;
    try { direct = await this.transport.order({ instId, clOrdId }); }
    catch (error) {
      // A failed lookup says nothing about whether the exchange accepted it.
      emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome: "RETAIN_UNKNOWN", reason: "ORDER_LOOKUP_FAILED", error: error?.message });
      return { clOrdId, outcome: "RETAIN_UNKNOWN" };
    }
    if (direct?.state && direct.state !== "NOT_FOUND") {
      const terminal = ["filled", "canceled", "mmp_canceled"].includes(String(direct.state).toLowerCase());
      const settlement = terminal ? await this.settleTerminal(attempt, direct) : null;
      const outcome = !terminal ? "FOUND" : settlement?.settled ? "TERMINAL_SETTLED" : "TERMINAL_PENDING_FILLS";
      emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome, state: direct.state, reason: settlement?.reason });
      return { clOrdId, outcome, direct };
    }
    // A single NOT_FOUND is deliberately insufficient. Query every required consistency source and retain reservation.
    const methods = ["ordersPending", "ordersHistory", "ordersHistoryArchive", "fills", "fillsHistory"];
    const tasks = [];
    for (const instType of ["SPOT", "MARGIN"]) {
      for (const name of methods) {
        if (typeof this.transport[name] === "function") tasks.push(this.pages((cursor) => this.transport[name](instType, { ...cursor, clOrdId })));
      }
    }
    const reads = await Promise.all(tasks);
    const found = reads.flat().some((row) => row?.clOrdId === clOrdId || row?.ordId === attempt.ord_id);
    emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome: found ? "FOUND_BY_CONSISTENCY" : "RETAIN_UNKNOWN" });
    return { clOrdId, outcome: found ? "FOUND_BY_CONSISTENCY" : "RETAIN_UNKNOWN" };
  }
  async fillsForOrder(attempt, order) {
    const ordId = order.ordId ?? attempt.ord_id ?? attempt.ordId; const clOrdId = order.clOrdId ?? attempt.cl_ord_id ?? attempt.clOrdId;
    const expected = order.accFillSz;
    if (expected !== undefined && compareDecimal(expected, "0") === 0) return [];
    const rows = []; const unique = () => [...new Map(rows.filter((row) => (!ordId || row.ordId === ordId) && (!clOrdId || !row.clOrdId || row.clOrdId === clOrdId)).map((row) => [`${row.instId}:${row.tradeId}`, row])).values()];
    for (const method of ["fills", "fillsHistory"]) {
      for (const instType of ["SPOT", "MARGIN"]) if (typeof this.transport[method] === "function") {
        try { rows.push(...await this.pages((cursor) => this.transport[method](instType, { ...cursor, ordId }))); }
        catch (error) { emit(this.telemetry, { type: "reconcile_attempt", reason: "ORDER_FILLS_READ_FAILED", clOrdId, instType, endpoint: method, error: error?.message }); throw error; }
      }
      const found = unique();
      if (expected !== undefined && compareDecimal(found.reduce((sum, fill) => addDecimal(sum, fill.fillSz), "0"), expected) === 0) return found;
    }
    return unique();
  }
  async settleTerminal(attempt, order) {
    const fills = await this.fillsForOrder(attempt, order);
    return this.onTerminal({ attempt, order, fills, exchangeState: order.state, accFillSz: order.accFillSz ?? "0" });
  }
  async observeOrder(order) {
    const clOrdId = order?.clOrdId; if (!clOrdId || !["filled", "canceled", "mmp_canceled"].includes(String(order.state).toLowerCase())) return { handled: false };
    const attempt = await this.transaction((tx) => this.orders.findByClOrdId(tx, clOrdId));
    if (!attempt) return { handled: false };
    await this.settleTerminal(attempt, order); return { handled: true };
  }
  async ingestFill(tx, fill, order) {
    const managed = classifyManagedFill(fill, order, this.ownership);
    if (!managed) return false;
    if (order?.clOrdId && typeof this.orders.findByClOrdId === "function") {
      const attempt = await this.orders.findByClOrdId(tx, order.clOrdId);
      if (attempt) { managed.source = "SYSTEM"; managed.executionMode = attempt.execution_mode ?? attempt.executionMode ?? managed.executionMode; managed.executionRoute = attempt.execution_route ?? attempt.executionRoute ?? managed.executionRoute; }
    }
    const isBuy = managed.side === "buy";
    if (isBuy && !this.ownership.holdHoursByInst?.[managed.instId]) { emit(this.telemetry, { type: "account_fill", reason: "STRATEGY_CONFIG_MISSING", instId: managed.instId }); return false; }
    const baseCcy = managed.instId.split("-")[0];
    if (managed.source === "ACCOUNT" && !isBuy) await this.orders.lockExitBase?.(tx, this.ownership.accountId, baseCcy);
    const inserted = await this.state.insertFill(tx, {
      accountId: this.ownership.accountId, instId: managed.instId, baseCcy, tradeId: managed.tradeId, billId: managed.billId,
      source: managed.source, side: isBuy ? "BUY" : "SELL", fillSize: managed.sz, fillTime: managed.fillTime, fillPrice: fill.fillPx, fee: fill.fee, feeCcy: fill.feeCcy,
      executionMode: managed.executionMode,
      executionRoute: managed.executionRoute,
      ...(isBuy ? { holdHours: this.ownership.holdHoursByInst?.[managed.instId], strategyConfigHash: this.ownership.configHash, sellTime: Number(managed.fillTime) + Number(this.ownership.holdHoursByInst?.[managed.instId] ?? 0) * 3_600_000, sellState: "WAITING" } : { allocationState: "PENDING" }),
    });
    if (managed.source === "ACCOUNT" && isBuy) this.onAccountBuy(managed.instId);
    // Before an HTTP send a PREPARED exit is purely local and can safely be
    // released. SUBMITTED/UNKNOWN are never cancelled here: they must settle
    // through exchange fills/history.
    if (managed.source === "ACCOUNT" && !isBuy && inserted?.rowCount === 1) {
      const released = await this.orders.releasePreparedExitsForBase?.(tx, this.ownership.accountId, baseCcy);
      if (released?.rowCount) emit(this.telemetry, { type: "account_sell", reason: "PREPARED_EXIT_NOT_CREATED", baseCcy, count: released.rowCount });
    }
    emit(this.telemetry, { type: "account_fill", source: managed.source, side: managed.side, instId: managed.instId });
    return true;
  }
  async allocateSafeAccountSells({ accountId, baseCcy }) {
    const watermarks = await this.transaction((tx) => this.orders.listWatermarks?.(tx, accountId) ?? []);
    const fills = watermarks.filter((row) => row.endpoint === "fills" && row.healthy && ["SPOT", "MARGIN"].includes(row.inst_type ?? row.instType));
    if (fills.length < 2) { emit(this.telemetry, { type: "account_sell", reason: "ACCOUNT_FILL_WATERMARK_STALE", baseCcy }); return 0; }
    // Both feeds must have advanced.  Their *smaller* fence is the only safe
    // point at which an external SELL can be allocated chronologically.
    const watermark = Math.min(...fills.map((row) => Number(row.watermark)));
    const result = await this.transaction((tx) => this.state.allocatePendingAccountSells(tx, { accountId, baseCcy, watermark }));
    if (result?.reason) emit(this.telemetry, { type: "account_sell", reason: result.reason, baseCcy, tradeId: result.tradeId });
    return result;
  }
  completeBaseline(scope, fresh = true) { this.readyGate.set(scope, fresh); return this.readyGate.ready; }
  connectionLost(scope) { this.readyGate.set(scope, false); }
}
