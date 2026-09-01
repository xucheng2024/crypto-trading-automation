import { classifyManagedFill } from "../infrastructure/okx/rest-client.js";
import { addDecimal, compareDecimal, divideDecimal, multiplyDecimal } from "../decimal.js";

export const FILL_WATERMARK_SETTLEMENT_LAG_MS = 5 * 60_000;
export const ORDER_ABSENCE_CONFIRMATION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

// Observability must never become part of the reconciliation correctness path.
// Ports are intentionally fire-and-forget: both a synchronous throw and a
// rejected promise are contained here.
function emit(port, event) { try { Promise.resolve(port(event)).catch(() => {}); } catch { /* telemetry is best effort */ } }

function keyOf(fill) { return `${fill.instId}:${fill.tradeId}`; }
function fillKey(fill) { return [Number(fill.fillTime), /^\d+$/.test(String(fill.billId ?? "")) ? BigInt(fill.billId) : -1n, String(fill.tradeId)].map(String).join(":"); }
function normalizePage(value) { return Array.isArray(value) ? { rows: value, cursor: null } : { rows: value?.data ?? value?.rows ?? [], cursor: value?.next ?? value?.cursor ?? null }; }

function recordConfirmedBuy(groups, { managed, fill, attempt, sellTime }) {
  const clOrdId = attempt?.cl_ord_id ?? attempt?.clOrdId ?? null;
  const key = [managed.source, managed.instId, clOrdId ?? "UNLINKED"].join(":");
  const current = groups.get(key) ?? { source: managed.source, instId: managed.instId, clOrdId, decisionId: attempt?.decision_id ?? attempt?.decisionId, executionMode: managed.executionMode, executionRoute: managed.executionRoute, fillCount: 0, filledSize: "0", fillNotional: "0", priced: true, minFillPrice: null, maxFillPrice: null, firstFillTime: null, lastFillTime: null, sellTime, sellState: "WAITING" };
  const price = fill.fillPx;
  current.fillCount += 1; current.filledSize = addDecimal(current.filledSize, managed.sz);
  if (price && compareDecimal(price, "0") > 0) {
    current.fillNotional = addDecimal(current.fillNotional, multiplyDecimal(managed.sz, price));
    current.minFillPrice = !current.minFillPrice || compareDecimal(price, current.minFillPrice) < 0 ? price : current.minFillPrice;
    current.maxFillPrice = !current.maxFillPrice || compareDecimal(price, current.maxFillPrice) > 0 ? price : current.maxFillPrice;
  } else current.priced = false;
  const fillTime = Number(managed.fillTime);
  current.firstFillTime = current.firstFillTime == null ? fillTime : Math.min(current.firstFillTime, fillTime);
  current.lastFillTime = current.lastFillTime == null ? fillTime : Math.max(current.lastFillTime, fillTime);
  current.sellTime = current.sellTime == null ? sellTime : Math.min(current.sellTime, sellTime);
  groups.set(key, current);
}

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
    const [protection, daily, initialLedger, attempts, buyAttempts, watermarks] = await this.transaction((tx) => Promise.all([
      this.state.listProtection?.(tx, accountId) ?? [], this.state.listDaily?.(tx, accountId) ?? [], this.state.listManagedFills?.(tx, accountId) ?? [],
      this.orders.listNonTerminal?.(tx, accountId) ?? [], this.orders.listTodayBuys?.(tx, accountId, strategyDay) ?? [], this.orders.listWatermarks?.(tx, accountId) ?? [],
    ]));
    const recovered = await this.reconcileAll({ accountId, attempts, watermarks });
    // reconcileAll may have just discovered ACCOUNT fills.  Re-read after it
    // commits so the startup risk and sell projections include them on their
    // first build, rather than only after a later restart or SYSTEM fill.
    const ledger = await this.transaction((tx) => this.state.listManagedFills?.(tx, accountId) ?? initialLedger);
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
    const raw = []; const watermarks = new Map();
    for (const instType of instTypes) {
      const readStartedAt = this.clock.nowMs();
      const recent = await this.pages((cursor) => this.transport.fills(instType, { begin: overlapBegin, limit: "100", ...cursor }));
      const history = await this.pages((cursor) => this.transport.fillsHistory(instType, { begin: overlapBegin, limit: "100", ...cursor }));
      const rows = [...recent, ...history]; raw.push(...rows);
      const latestFillTime = rows.reduce((latest, fill) => Math.max(latest, Number(fill?.fillTime) || 0), Number(overlapBegin) || 0);
      // A successful non-full recent page proves the stream was read through
      // its request boundary even when that instType has no fills. Keep a
      // conservative settlement lag for delayed exchange visibility. A full
      // page remains event-bounded because older omitted rows may still exist.
      const completeThrough = recent.length < 100 ? readStartedAt - FILL_WATERMARK_SETTLEMENT_LAG_MS : 0;
      watermarks.set(instType, Math.max(Number(overlapBegin) || 0, latestFillTime, completeThrough));
    }
    const unique = [...new Map(raw.filter((fill) => fill?.instId && fill?.tradeId).map((fill) => [keyOf(fill), fill])).values()]
      .sort((a, b) => fillKey(a).localeCompare(fillKey(b), undefined, { numeric: true }));
    const accountBuys = new Set();
    const batch = { observed: unique.length, managed: 0, inserted: 0, linked: 0, alreadyPresent: 0, ignored: 0, systemBuys: 0, systemSells: 0, accountBuys: 0, accountSells: 0 };
    const confirmedBuys = new Map();
    await this.transaction(async (tx) => {
      for (const fill of unique) {
        const order = typeof this.transport.order === "function" ? await this.transport.order({ instId: fill.instId, ordId: fill.ordId, clOrdId: fill.clOrdId }) : null;
        await this.ingestFill(tx, fill, order, accountBuys, batch, confirmedBuys);
      }
      for (const instType of instTypes) await this.orders.upsertWatermark?.(tx, { accountId, instType, endpoint: "fills", watermark: watermarks.get(instType), overlapBegin, healthy: true });
    });
    for (const instId of accountBuys) await this.refreshAccountBuy(instId);
    // This deliberately reports only post-commit aggregate counts. It is safe
    // to retain, useful when recovery is the only path that sees a fill, and
    // contains no account, order, trade, or exchange identifiers.
    emit(this.telemetry, { type: "fill_reconciliation", reason: "FILL_BATCH_COMMITTED", ...batch });
    for (const row of confirmedBuys.values()) emit(this.telemetry, {
      type: "trade_lifecycle", reason: "BUY_LEDGER_CONFIRMED", intent: "BUY", source: row.source,
      instId: row.instId, clOrdId: row.clOrdId ?? undefined, decisionId: row.decisionId ?? undefined,
      executionMode: row.executionMode, executionRoute: row.executionRoute,
      fillCount: row.fillCount, filledSize: row.filledSize,
      fillNotional: row.priced ? row.fillNotional : undefined,
      weightedAvgPrice: row.priced ? divideDecimal(row.fillNotional, row.filledSize) : undefined,
      minFillPrice: row.priced ? row.minFillPrice : undefined, maxFillPrice: row.priced ? row.maxFillPrice : undefined,
      firstFillTime: row.firstFillTime, lastFillTime: row.lastFillTime, sellTime: row.sellTime, sellState: row.sellState,
    });
    return unique;
  }
  async reconcileAll({ accountId, attempts, watermarks }) {
    const observations = [];
    for (const attempt of attempts) observations.push(await this.reconcileAttempt(attempt));
    const overlap = Math.min(...watermarks.filter((row) => row.endpoint === "fills" && row.healthy).map((row) => Number(row.overlap_begin ?? row.overlapBegin ?? 0)), 0);
    if (accountId) {
      await this.recoverFills({ accountId, overlapBegin: overlap });
      // A PENDING ACCOUNT SELL blocks every future SYSTEM SELL/DELIST reservation for
      // its base forever unless something resolves it. Sweep every base with a PENDING
      // ACCOUNT SELL on the same cadence recovery/periodic reconcile already runs on.
      const bases = await this.transaction((tx) => this.state.listPendingAccountSellBases?.(tx, accountId) ?? []);
      for (const baseCcy of bases) await this.allocateSafeAccountSells({ accountId, baseCcy });
    }
    return observations;
  }
  async reconcileAttempt(attempt) {
    const instId = attempt.inst_id ?? attempt.instId; const clOrdId = attempt.cl_ord_id ?? attempt.clOrdId;
    let direct; let explicitNotFound = false;
    try { direct = await this.transport.order({ instId, clOrdId }); }
    catch (error) {
      if (String(error?.okxCode ?? "") === "51603") { direct = { state: "NOT_FOUND" }; explicitNotFound = true; }
      else {
        // A failed lookup says nothing about whether the exchange accepted it.
        emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome: "RETAIN_UNKNOWN", reason: "ORDER_LOOKUP_FAILED", error: error?.message });
        return { clOrdId, outcome: "RETAIN_UNKNOWN" };
      }
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
    if (found) {
      emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome: "FOUND_BY_CONSISTENCY" });
      return { clOrdId, outcome: "FOUND_BY_CONSISTENCY" };
    }
    const state = attempt.state; const createdAt = new Date(attempt.created_at ?? attempt.createdAt ?? NaN).getTime(); const ageMs = this.clock.nowMs() - createdAt;
    const recentUnknown = state === "UNKNOWN" && Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= ORDER_ABSENCE_CONFIRMATION_MAX_AGE_MS;
    if (explicitNotFound && recentUnknown && tasks.length === 10 && typeof this.orders.markSettled === "function") {
      const settled = await this.transaction((tx) => this.orders.markSettled(tx, clOrdId, "NOT_FOUND", "RELEASED"));
      if (settled?.rowCount) {
        emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome: "TERMINAL_SETTLED", reason: "ORDER_ABSENT_ALL_SOURCES", state: "NOT_FOUND" });
        return { clOrdId, outcome: "TERMINAL_SETTLED", direct };
      }
    }
    emit(this.telemetry, { type: "reconcile_attempt", clOrdId, outcome: "RETAIN_UNKNOWN" });
    return { clOrdId, outcome: "RETAIN_UNKNOWN" };
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
    const clOrdId = order?.clOrdId; const ordId = order?.ordId;
    if (!clOrdId && !ordId) return { handled: false };
    const state = String(order.state ?? "").toLowerCase();
    const terminal = ["filled", "canceled", "mmp_canceled"].includes(state);
    const attempt = clOrdId ? await this.transaction((tx) => this.orders.findByClOrdId?.(tx, clOrdId)) : null;
    if (attempt) {
      if (!terminal) return { handled: false };
      await this.settleTerminal(attempt, order); return { handled: true };
    }
    // An order created outside this process has no local attempt.  The private
    // orders stream is nevertheless the earliest reliable notification that
    // it may have filled, so load its immutable fills immediately.  REST
    // reconciliation remains the recovery path when the fills endpoint lags.
    if (!["partially_filled", "filled"].includes(state) || (order.accFillSz !== undefined && compareDecimal(order.accFillSz, "0") <= 0)) return { handled: false };
    const fills = await this.fillsForOrder({ instId: order.instId, clOrdId, ord_id: ordId }, order);
    let ingested = 0; const accountBuys = new Set();
    await this.transaction(async (tx) => {
      for (const fill of fills) if (await this.ingestFill(tx, fill, order, accountBuys)) ingested += 1;
    });
    for (const instId of accountBuys) await this.refreshAccountBuy(instId);
    return { handled: ingested > 0, source: "ACCOUNT", fills: ingested };
  }
  async refreshAccountBuy(instId) {
    try { await this.onAccountBuy(instId); }
    catch (error) { emit(this.telemetry, { type: "account_fill", reason: "ACCOUNT_BUY_PROJECTION_REFRESH_FAILED", instId, error: error?.message }); }
  }
  async ingestFill(tx, fill, order, accountBuys = null, batch = null, confirmedBuys = null) {
    const managed = classifyManagedFill(fill, order, this.ownership);
    if (!managed) { if (batch) batch.ignored += 1; return false; }
    if (batch) batch.managed += 1;
    let sourceAttemptClOrdId = null; let attempt = null;
    if (order?.clOrdId && typeof this.orders.findByClOrdId === "function") {
      attempt = await this.orders.findByClOrdId(tx, order.clOrdId);
      if (attempt) {
        managed.source = "SYSTEM";
        sourceAttemptClOrdId = attempt.cl_ord_id ?? attempt.clOrdId;
        managed.executionMode = attempt.execution_mode ?? attempt.executionMode ?? managed.executionMode;
        managed.executionRoute = attempt.execution_route ?? attempt.executionRoute ?? managed.executionRoute;
      }
    }
    const isBuy = managed.side === "buy";
    if (isBuy && !this.ownership.holdHoursByInst?.[managed.instId]) { if (batch) batch.ignored += 1; emit(this.telemetry, { type: "account_fill", reason: "STRATEGY_CONFIG_MISSING", instId: managed.instId }); return false; }
    const baseCcy = managed.instId.split("-")[0];
    if (managed.source === "ACCOUNT" && !isBuy) await this.orders.lockExitBase?.(tx, this.ownership.accountId, baseCcy);
    const inserted = await this.state.insertFill(tx, {
      accountId: this.ownership.accountId, instId: managed.instId, baseCcy, tradeId: managed.tradeId, billId: managed.billId,
      source: managed.source, side: isBuy ? "BUY" : "SELL", fillSize: managed.sz, fillTime: managed.fillTime, fillPrice: fill.fillPx, fee: fill.fee, feeCcy: fill.feeCcy,
      executionMode: managed.executionMode,
      executionRoute: managed.executionRoute,
      sourceAttemptClOrdId,
      ...(isBuy ? { holdHours: this.ownership.holdHoursByInst?.[managed.instId], maxHoldHours: this.ownership.maxHoldHoursByInst?.[managed.instId] ?? null, strategyConfigHash: this.ownership.configHash, sellTime: Number(managed.fillTime) + Number(this.ownership.holdHoursByInst?.[managed.instId] ?? 0) * 3_600_000, forceSellTime: this.ownership.maxHoldHoursByInst?.[managed.instId] ? Number(managed.fillTime) + Number(this.ownership.maxHoldHoursByInst[managed.instId]) * 3_600_000 : null, sellState: "WAITING" } : { allocationState: "PENDING" }),
    });
    if (inserted?.rowCount === 0) await this.state.attachFillBillId?.(tx, {
      accountId: this.ownership.accountId, instId: managed.instId, tradeId: managed.tradeId, billId: managed.billId,
    });
    let linked = 0;
    if (managed.source === "SYSTEM" && sourceAttemptClOrdId && inserted?.rowCount === 0) {
      linked = (await this.state.attachSystemFillAttempt?.(tx, { accountId: this.ownership.accountId, instId: managed.instId, tradeId: managed.tradeId, sourceAttemptClOrdId }))?.rowCount ?? 0;
    }
    if (batch) {
      if (inserted?.rowCount) batch.inserted += 1; else batch.alreadyPresent += 1;
      batch.linked += linked;
      if (managed.source === "SYSTEM") { if (isBuy) batch.systemBuys += 1; else batch.systemSells += 1; }
      else if (isBuy) batch.accountBuys += 1; else batch.accountSells += 1;
    }
    if (isBuy && inserted?.rowCount === 1 && confirmedBuys) {
      const sellTime = Number(managed.fillTime) + Number(this.ownership.holdHoursByInst?.[managed.instId] ?? 0) * 3_600_000;
      recordConfirmedBuy(confirmedBuys, { managed, fill, attempt, sellTime });
    }
    if (managed.source === "ACCOUNT" && isBuy && inserted?.rowCount !== 0) {
      // Refresh the in-memory risk and exit indexes only after the durable
      // transaction commits. A callback failure must not roll back or invalidate
      // an already recorded exchange fill; polling/recovery can retry later.
      if (accountBuys) accountBuys.add(managed.instId);
      else await this.refreshAccountBuy(managed.instId);
    }
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
