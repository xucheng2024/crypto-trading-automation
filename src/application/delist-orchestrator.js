import { compareDecimal } from "../decimal.js";

// Durable protection -> fill-level DELIST bridge.  It creates no attempts:
// the Coordinator remains the sole reservation/HTTP authority.
export class DelistOrchestrator {
  constructor({ transaction, state, orders, coordinator, accountId, market, availableBase = async () => null, telemetry = () => {} }) { Object.assign(this, { transaction, state, orders, coordinator, accountId, market, availableBase, telemetry }); }
  bind() {
    this.coordinator.onExitSettled = async ({ attempt }) => {
      if (attempt.intent === "DELIST") await this.drive(attempt.inst_id ?? attempt.instId);
    };
    return this;
  }
  async recover(protections) {
    for (const row of protections.filter((item) => ["EXITING", "DELIST_DUST"].includes(item.state))) await this.drive(row.inst_id ?? row.instId);
  }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* observability only */ } }
  async drive(instId) {
    const rows = await this.transaction((tx) => this.state.listDelistCandidates(tx, { accountId: this.accountId, instId }));
    if (!rows.length) return this.transaction((tx) => this.state.convergeProtection(tx, { accountId: this.accountId, instId }));
    // An active SYSTEM exit owns the whole base.  Keep every later fill durable
    // and queued for a later drive; never overlap a reservation.
    const base = rows[0].base_ccy;
    const active = await this.transaction((tx) => this.orders.listActiveExitForBase(tx, this.accountId, base));
    if (active.length) return "EXITING";
    const row = rows.find((candidate) => candidate.sell_state !== "DUST_PENDING");
    if (!row) return this.transaction((tx) => this.state.convergeProtection(tx, { accountId: this.accountId, instId }));
    const quote = this.market.ticker(instId); const confirmedAvailable = await this.availableBase(row);
    if (confirmedAvailable !== null && (!confirmedAvailable || compareDecimal(confirmedAvailable, "0") <= 0)) {
      this._emit({ type: "protection", reason: "BALANCE_SHORTFALL", instId, sourceBuyTradeId: row.trade_id });
      return "EXITING";
    }
    this.coordinator.enqueue({ intent: "DELIST", accountId: this.accountId, instId, baseCcy: row.base_ccy, sourceBuyTradeId: row.trade_id, remainingSize: row.remaining_size, fillVersion: row.version, generation: Number(row.next_generation), sellTime: Number(row.sell_time ?? 0), availableBase: confirmedAvailable, bidPx: quote?.bidPx ?? quote?.last, executionMode: row.execution_mode ?? row.executionMode, executionRoute: row.execution_route ?? row.executionRoute });
    this._emit({ type: "protection", reason: "DELIST_QUEUED", instId, sourceBuyTradeId: row.trade_id });
    return "EXITING";
  }
}
