# P0 baseline and OKX mutation inventory

## Baseline recorded 2026-08-14

| Command | Result | Notes |
|---|---|---|
| `node --version` | `v26.7.0` | local runtime |
| `npm --version` | `11.19.0` | local package manager |
| `python3 --version` | `Python 3.9.6` | default interpreter; project requires Python >=3.11 |
| `python3.11 --version` | `Python 3.11.7` | compatible local interpreter |
| `npm test` | PASS, 38/38 | legacy Worker tests plus P0 Azure safety tests |
| `npm run check` | PASS | `wrangler deploy --dry-run`; no deployment |
| `python3.11 -m pytest tests` | PASS, 29/29 | Python safety and SQLite backend tests |

## Mutation inventory

All entries below are legacy Cloudflare, GitHub Actions, or Python tooling. P0 adds no Azure OKX transport and changes none of these paths.

| Code evidence | REST/SDK mutation | Class | Trigger source | Retry/timeout/idempotency | Key/config | Future disposition |
|---|---|---|---|---|---|---|
| `src/okx.js:174-198`, called by `src/tasks.js` | `POST /api/v5/trade/cancel-order`, `cancel-batch-orders`, `cancel-algos`, `order`, `order-algo` | maintenance; BUY; SELL | Cloudflare task dispatch / GitHub script | transport POST has 0 retries; trigger placement wraps three retries; cancellation verifies and retries up to 3 | Worker `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `OKX_TESTNET` | Coordinator or delete at cutover |
| `src/tasks.js:160-192` | cancel batch limits and trigger algos | maintenance | Cloudflare cron/manual task; delist path; GitHub reconciliation | three verification cycles, 100/300ms sleeps | Worker OKX secrets | switch-cleanup only / delete |
| `src/tasks.js:244-270`, `273-326` | `POST /trade/order` market SELL | SELL | `auto_sell_orders` cron/manual task | unknown outcome queried by ordId/clOrdId; no submit retry | Worker OKX secrets, `OKX_MIN_USD_VALUE` | Order Coordinator |
| `src/tasks.js:342-370`, `373-430` | `POST /trade/order` limit BUY and `POST /trade/order-algo` trigger BUY | BUY | trigger rebuild task; GitHub workflow | `placeWithRetry`: max 3 retryable attempts, then pending-order lookup by client ID | Worker/GitHub OKX secrets, `OKX_ORDER_SIZE` | delete (new design prohibits algo triggers) |
| `src/tasks.js:493-540`, `548-570` | cancellations then `POST /trade/order` market SELL | DELIST plus maintenance | 5-minute Cloudflare `monitor_delist` | prior attempt reconciliation, unknown state, three order polls | Worker OKX secrets | Order Coordinator; legacy cleanup only |
| `.github/workflows/reconcile-buy-triggers.yml:1-58`, `scripts/github-trigger-reconcile.mjs:43-55` | invokes legacy trigger cancel/rebuild mutations | maintenance and BUY | GitHub repository dispatch/workflow_dispatch | GitHub FIFO concurrency; task-level behavior above | GitHub OKX and Cloudflare/D1 secrets | remove before cutover |
| `cancel_pending_limits.py:158-317` | SDK `cancel_order` | maintenance | Python CLI / external scheduler | Tenacity 3 exponential attempts | `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `OKX_TESTNET` | switch-cleanup only / delete |
| `cancel_pending_triggers.py:151-389`, `fetch_filled_orders.py:624-687` | SDK `cancel_algo_order` | maintenance | Python CLI; fill-reconciliation cleanup | Tenacity 3 exponential attempts; batches of 10 | same Python OKX env | switch-cleanup only / delete |
| `create_algo_triggers.py:392-493` | SDK `place_order` limit BUY; `place_algo_order` trigger BUY | BUY | Python CLI / external scheduler | script sleeps; result validation; no durable mutation ledger | same Python OKX env and order-size config | delete (new design prohibits algo triggers) |
| `auto_sell_orders.py:495-605` | SDK `place_order` market SELL | SELL | Python CLI / continuous monitor | result validation and order polling; no durable mutation ledger | same Python OKX env | Order Coordinator |
| `okx_client.py:296-345` | SDK `place_order` market SELL | DELIST | invoked by Python protection flow | three order polls after submit; no submit retry | same Python OKX env | Order Coordinator |
| `monitor_delist.py`, `protection_manager.py:27-31` | starts cancellation scripts and protection manager; sale reaches `okx_client.py` | DELIST and maintenance | Python 5-minute monitor / CLI | subprocess-style orchestration; individual scripts own retries | Python OKX env | switch-cleanup only / delete |

No `repay`, `borrow`, account-setting, leverage-setting, amend-order, or WebSocket mutation call was found in JavaScript, Python, workflow, cron, or configuration search scopes. Read-only `GET /api/v5/trade/order` and pending/fill queries are excluded from this inventory.
