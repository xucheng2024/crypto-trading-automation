const boundary = (base) => new RegExp(`(^|[^A-Z0-9])${base}(?:-USDT)?([^A-Z0-9]|$)`, "i");
function emit(port, event) { try { Promise.resolve(port(event)).catch(() => {}); } catch { /* non-blocking port */ } }

export class InstrumentProtectionService {
  constructor({ state, transaction = async (fn) => fn(null), onExit = () => {}, telemetry = () => {}, nowMs = () => Date.now() }) { Object.assign(this, { state, transaction, onExit, telemetry, nowMs }); }
  async scanAnnouncements(fetchPage, instruments) {
    let crossedWindow = false;
    for (let page = 1; page <= 20; page += 1) {
      let details;
      try { details = (await fetchPage(page))?.data?.[0]?.details ?? []; } catch (error) { emit(this.telemetry, { type: "protection", reason: "ANNOUNCEMENT_FETCH_FAILED", error: error?.message }); return { retry: true }; }
      if (!details.length) return { crossedWindow, pages: page };
      const work = [];
      for (const item of details) {
        if (Number(item.pTime) < this.nowMs() - 86_400_000) { crossedWindow = true; continue; }
        if (!/\bspot\b/i.test(item.title ?? "")) continue;
        const matched = instruments.filter((row) => boundary(row.base ?? row.instId.split("-")[0]).test(item.title ?? ""));
        if (matched.length) work.push({ item, matched });
      }
      const notifications = [];
      try {
        await this.transaction(async (tx) => {
          for (const { item, matched } of work) {
            const receipt = await this.state.claimAnnouncement?.(tx, item);
            if (receipt && receipt.rowCount === 0) continue;
            for (const instrument of matched) {
              await this.state.upsertProtection?.(tx, { instId: instrument.instId, baseCcy: instrument.base, state: "EXITING", reason: "ANNOUNCEMENT", announcement: item });
              notifications.push({ instId: instrument.instId, baseCcy: instrument.base, reason: "ANNOUNCEMENT", announcement: item });
            }
          }
        });
      } catch (error) {
        emit(this.telemetry, { type: "protection", reason: "ANNOUNCEMENT_PAGE_TRANSACTION_FAILED", page, error: error?.message });
        return { retry: true, pages: page };
      }
      for (const protection of notifications) await this._notifyExit(protection);
      if (crossedWindow) return { crossedWindow, pages: page };
    }
    emit(this.telemetry, { type: "protection", reason: "ANNOUNCEMENT_PAGE_LIMIT" }); return { retry: true, pages: 20 };
  }
  async _notifyExit(protection) { try { await this.onExit(protection); } catch (error) { emit(this.telemetry, { type: "protection", reason: "PROTECTION_ORCHESTRATION_DEFERRED", instId: protection.instId, error: error?.message }); } emit(this.telemetry, { type: "protection", reason: "EXITING", instId: protection.instId }); }
  async confirm(protection) {
    await this.transaction((tx) => this.state.upsertProtection?.(tx, { ...protection, state: "EXITING" }));
    await this._notifyExit(protection);
  }
  instrumentEvent(row) { return { freezeBuy: row.state !== "live", confirmDelist: Boolean(row.expTime) }; }
}
