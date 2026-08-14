# P2 results

## P2 status

已通过。所有 P2 blocker 已关闭；ACCOUNT SELL 分配顺序和 SELL/DELIST 真实抢占提交明确属于 T6/P3 deferred，未实现且不作为 P2 blocker。

## Delivered sub-phases

- **T4 runtime:** `MarketProjection` implements versioned ticker/candle/instrument projections, same-timestamp correction acceptance, exact-duplicate suppression, out-of-order rejection, freshness, bounded priority work, ticker coalescing, one pending BUY intent per instrument, active-BUY tracking, deterministic `(generation, eligible_since, instId)` selection, global READY dependency gate, and injectable watchdog timer.
- **T4 recovery:** `ReconciliationService` forces READY false during recovery, requires the owner, waits an injected `OWNER_SAFETY_WAIT_MS`, loads protection/daily/fill/attempt/watermark inputs, reads paged SPOT/MARGIN pending/history/archive/fills/fills-history overlap windows, stably sorts and de-duplicates fills by `(instId, tradeId)`, and persists continuous fills watermarks. PREPARED is queried exactly as UNKNOWN; a single NOT_FOUND retains the reservation and triggers all consistency sources rather than release/retry.
- **T5 coordinator:** `OrderCoordinator` is the only new mutation caller and accepts only an injected transport. It serializes one immediate BUY batch of at most five, keeps DELIST/SELL priority reserved for future preemption, performs one max-avail read for the selected candidates, persists PREPARED/reservations through `OrderRepository`, rechecks mode/owner/READY/freshness before HTTP, sends once, and records independent SUBMITTED/NOT_CREATED/UNKNOWN outcomes. UNKNOWN is retained and never blindly resent.
- **T5 lifecycle and ledger boundary:** settlement inserts fills and transitions reservation/SETTLED in one injected transaction; a later generation requires prior `SETTLED` plus a changed market key. Recovery rebuild inputs are available from frozen attempts and real fills, with no `buy_cycles`. Post-start configured cross SPOT/MARGIN ACCOUNT BUY fills are idempotently admitted through the existing fill ledger and stop later system BUY for that instrument; non-cross, derivatives, old and non-configured fills are ignored. ACCOUNT SELL is only persisted as `PENDING`; no allocation or exit mutation is implemented.
- **T5 persistence boundary:** PostgreSQL repository transitions now atomically record SUBMITTED, UNKNOWN, NOT_CREATED/released, SETTLED/released-or-converted, and sync watermark upsert states. The temporary PostgreSQL suite verifies real transaction behavior for the new transitions.
- **P2 final-gap work:** duplicate-key handling now reads a durable PREPARED row by `clOrdId` and verifies its payload hash after a simulated commit acknowledgement loss; a mismatch is `HASH_COLLISION` fail-closed. A batch transport exception or omitted per-item result is durably `UNKNOWN`, never left PREPARED and never resent. `PostgresOwnerGuard` emits session-loss notification; reconciliation clears `READY.owner` synchronously and requires a new lock plus safety wait/recovery.

## Modified files

- `tests-worker/okx-infrastructure.test.js`
- `tests-worker/p2-buy-runtime.test.js`
- `tests-worker/postgres.integration.test.js`
- `src/application/trading-engine.js`
- `src/application/reconciliation-service.js`
- `src/application/order-coordinator.js`
- `src/infrastructure/postgres/repositories.js`
- `docs/audit/P1_RESULTS.md`
- `docs/audit/P2_RESULTS.md`

## Test results

| Command | Result |
|---|---|
| `npm test` | PASS — 80 tests |
| `npm run test:postgres` | PASS — 14 temporary PostgreSQL integration tests |
| `python3.11 -m pytest tests` | PASS — 29 tests |
| `npm run check` | PASS — Wrangler dry-run only |
| `git diff --check` | PASS |

## Coverage evidence

- Fake-clock runtime replay proves same-ms market corrections, duplicate/out-of-order behavior, ticker coalescing, generation-zero fairness, commit-ack-loss business-key lookup, and missing batch item -> UNKNOWN.
- Fake recovery replay proves owner wait, READY=false recovery, PREPARED/UNKNOWN query-only treatment, full consistency reads after a lone NOT_FOUND, fills/fills-history pagination, stable ordering, tradeId de-duplication and watermark persistence.
- Fake mutation transport replay proves a three-item BUY batch, cross IOC payload fields, independent SUBMITTED/NOT_CREATED/UNKNOWN outcomes, reservation release on final owner failure, no UNKNOWN resend, full/zero/late-fill settlement completeness, and next-generation market-key gating.
- Fifty-asset fake replay proves 1–5 immediate selection, generation-zero priority, deterministic fairness and q2…q100 ticker coalescing.
- ACCOUNT ledger replay proves post-start configured cross SPOT/MARGIN BUY admission and subsequent SYSTEM BUY termination while cash/isolated, derivative, old and non-configured fills are ignored.
- Decimal boundary replay proves 130+20=`totalEq` 150, 2.95 admission, 3.0 hard stop, strict yesterday-gain boundary, and tick-size projection updates.
- Real temporary PostgreSQL proves PREPARED commit-ack-loss lookup, SETTLED transaction replay (tradeId unique + CAS state leaves exactly one fill/exposure conversion), and 50 concurrent account-scoped transaction-advisory reservations stop at 435 <= 442.5 (2.95 × 150).
- A real isolated cluster stop/start proves owner session loss immediately clears READY; a replacement session reacquires the advisory lock, performs the safety wait and recovery, and remains not-ready until fresh baselines complete.
- The existing P1 injected fake-clock/fake-timer WebSocket test proves `ws-client.js` freshness becomes false after `idleMs` and that idle handling closes the old socket before reconnect.

## P2-D scenario → automatic-test mapping

`C` means the named test asserts payload, attempt state, reservation/exposure, generation and reason where that lifecycle exists. `P` means only a boundary or partial replay exists. `M` means no adequate automatic test yet; it is a release blocker.

| Scenario | Test(s) | Status |
|---|---|---|
| Full / partial / zero / late fill | settlement/coordinator replay; real 50 coordinator partial/zero paths | C |
| stale quote/risk; Private baseline incomplete | final guard; risk-version replay; recovery gate | C |
| batch partial rejection / missing item / total timeout | coordinator/commit-ack-loss replay | C |
| one NOT_FOUND / UNKNOWN / restart | real pagination UNKNOWN retention; real restart test | C |
| mode/owner/READY/risk changes before HTTP | final guard + dynamic configuration guard | C |
| same-ms quote / candle correction | runtime coalescing test | C |
| Singapore day missing data / +10% boundary / tickSz change | decimal boundary and daily-data guard replay | C |
| ACCOUNT cross BUY startup, reconnect, realtime | ACCOUNT ledger/recovery fill ingestion | C |
| cash/isolated, derivatives, pre-management fills rejected | ACCOUNT ledger test | C |
| PREPARED commit acknowledgement loss | fake commit-ack-loss test; real PostgreSQL commit-ack-loss test | C |
| SETTLED commit acknowledgement loss | real PostgreSQL SETTLED replay test | C |
| owner connection loss, PostgreSQL stop/start, safety wait | real PostgreSQL restart test | C |
| SPOT/MARGIN fills multi-page dedupe + watermark | real repository pagination test | C |
| watermark not advanced on mid-stream failure | real repository pagination test | C |
| replay must not release UNKNOWN reservation | real repository pagination test | C |
| 50 coins / five-order batches / 2.95 aggregate / gen-0 fairness | real 50 coordinator test; 50 concurrent reservation test | C |
| UNKNOWN retained; rejected/zero release; partial converts | real 50 coordinator/settlement tests | C |
| insufficient funds only resumes after risk version changes | risk-version replay | C |
| protection/config removal before submit | dynamic configuration guard replay | C |
| terminal status before all fills / order-state regression | settlement incomplete/frozen-field replay | C |
| UTC/Singapore midnight late fill strategy-day retention | frozen-field midnight replay | C |
| external ACCOUNT SELL PENDING/allocation ordering | P3 deferred / N/A — P2 asserts only PENDING recording; no allocation | N/A |
| BUY rate limit preempted by SELL/DELIST | P3 deferred / N/A — P2 has only the unprepared-BUY priority interface | N/A |

## Deferred outside P2

- ACCOUNT SELL allocation ordering remains T6/P3 deferred. P2 only records the object as `PENDING`.
- Actual SELL/DELIST mutation and its rate-limit preemption remain T6/T7/P3 deferred. P2 does not create those mutations.

## P3 risks

- P3 SELL/DELIST is intentionally not implemented. The coordinator reserves only priority/preemption interfaces for it.
- No Azure IaC, deployment, real account, real OKX, Cloudflare, or remote database access was performed.
