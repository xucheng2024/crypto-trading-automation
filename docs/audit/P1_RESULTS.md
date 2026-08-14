# P1 results

Completed 2026-08-14 after P1-C parsing, reconnect and recovery-pagination remediation. P1 stops at T1–T3; no P2 runtime queue, Order Coordinator, or production mutation wiring was added.

## Delivered

- **P1-A:** `src/domain/` centralizes Decimal-based instrument, order and trading-rule contracts. Domain tests cover rounding, limit and leverage boundaries, UTC+8 day selection, duration units, rebound/ask checks, and SELL/DELIST size limits.
- **P1-B:** `migrations/postgres/0001_p1_core.sql`, the two PostgreSQL repositories, session owner guard, temporary-cluster integration suite, and `tools/convert-d1-export.mjs` implement the P1 persistence boundary. PostgreSQL `numeric` is used for admission/exposure arithmetic; tests cover real two-connection contention, constraints, transaction rollback, fail-closed database loss, owner-lock release, migrations, and repeatable offline conversion.
- **P1-C:** `src/infrastructure/okx/rest-client.js` is the only new OKX REST transport. It defaults to `https://openapi.okx.com` and has entity profiles, signed skew-adjusted requests, timeout/rate pacing, GET-only retry with `Retry-After`, `expTime`, response validation, batch item classification, SPOT+MARGIN account-profile validation, fail-closed cross-fill ownership parsing, and paged pending/history/archive reads. `ws-client.js` provides Public, Private and Business clients with signed private login, failure-triggered close/reconnect, complete subscribe-ack tracking, ping/pong and tested idle expiry/reconnect, jittered reconnect, 64008 handling, per-instrument/generation watermarks, `pTime` account ordering, numeric status timestamps, freshness, ordered normalized observations, and confirmed candle-only output. The freshness/idle path is explicitly driven by an injected clock and fake timers: a baseline connection becomes fresh after a message, becomes stale after `idleMs`, then the idle interval closes the old socket and schedules reconnect.
- **P1-D:** Azure/domain transport-boundary tests preserve P0 authorization isolation. The new transport is not connected to `AzureMutationPort`, an entrypoint, credentials configuration, a database transaction, or a real socket/fetch test.

## Verification

| Command | Result |
|---|---|
| `npm test` | PASS — 62 tests |
| `npm run test:postgres` | PASS — 8 temporary PostgreSQL integration tests |
| `python3.11 -m pytest tests` | PASS — 29 tests |
| `npm run check` | PASS — Wrangler dry-run only |
| `git diff --check` plus whitespace scan of P1 delivery files (including untracked files) | PASS |

The JS suite includes offline fake REST/WS coverage for timeout/UNKNOWN, explicit timeout and network-error GET retry, mutation no-retry, `Retry-After`, paged pending/history/archive reads, missing/failed per-item batch `sCode`, SPOT+MARGIN capability cross-checks, ledger-or-prefix-and-tag ownership, login signature failure recovery, login failure backoff, complete subscribe acknowledgement, disconnect/reconnect, 64008, `pTime`, numeric status timestamps, same-time corrections, stale per-instrument and generation watermarks, and an explicit injected-clock/fake-timer idle test that verifies `fresh=true` after a message, `fresh=false` after `idleMs`, old-socket closure, and reconnect scheduling. The converter suite verifies schema validation, duration-unit rejection, stable sorting/hash, and repeatability.

## Deliberately unverified

- No real OKX endpoint, credentials, demo account, WebSocket, PostgreSQL service, Azure resource, deployment, or external write was used. PostgreSQL tests create and remove an isolated temporary local cluster.
- Entity-specific OKX endpoint behavior, production clock skew, account permissions, and live WebSocket baselines require a separately authorized read-only preflight.

## P2 risks

- P2 must keep `TRADING_MODE=OFF` by default and route any future mutation exclusively through authorization, persistent PREPARED/reservation transactions, owner lock, and the single coordinator.
- Live reconciliation must retain UNKNOWN semantics; it must never turn a timeout into a retry without the required order/fill history checks.
- The legacy Cloudflare OKX client remains legacy-only and is not a valid dependency for the Azure path.
