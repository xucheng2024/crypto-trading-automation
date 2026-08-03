# Cloudflare deployment guide

## Production resources

- Worker: `crypto-trading-cloudflare-prod`
- D1: `crypto-trading-prod`
- Durable Object binding: `CRON_DEDUP`
- Health endpoint: `https://crypto-trading-cloudflare-prod.eatfreshapple.workers.dev/health`

## Install and verify

```bash
npm install
npm test
npm run check
wrangler d1 migrations apply crypto-trading-prod --remote
```

## Required secrets

```bash
wrangler secret put OKX_API_KEY
wrangler secret put OKX_SECRET_KEY
wrangler secret put OKX_PASSPHRASE
wrangler secret put OKX_ORDER_SIZE
wrangler secret put MANUAL_TRIGGER_TOKEN
```

Use an OKX key with Read and Trade permissions only. Do not grant Withdraw permission. A key restricted to the old VPS IP will not authenticate from standard Cloudflare Workers; update its IP policy or use an appropriate fixed-egress setup.

## Safety switch

`wrangler.toml` defaults to:

```toml
TRADING_ENABLED = "false"
```

While false, scheduled and manual runs return before making private OKX calls or D1 mutations. Enable trading only after:

1. D1 contains the latest production SQLite snapshot.
2. All three OKX credential values are current in Cloudflare Secrets.
3. The old VPS scheduler and runner are stopped.
4. `GET /health` reports `status: ok`.

Then change `TRADING_ENABLED` to `"true"`, run the complete test suite, and deploy once more.

## D1 configuration import

```bash
node scripts/config-to-sql.mjs limits_d1.json /tmp/crypto-trading-config.sql
wrangler d1 execute crypto-trading-prod --remote --file=/tmp/crypto-trading-config.sql
```

For a final VPS SQLite cutover, stop the old scheduler, take a consistent SQLite backup while holding `/home/ubuntu/.local/share/crypto-trading/trading.lock`, and run:

```bash
python3 scripts/sqlite-to-d1.py trading.sqlite3 migration-export.sql
wrangler d1 execute crypto-trading-prod --remote --file=migration-export.sql
```

The export contains private trading history. Keep it outside Git and delete it after row counts have been verified.

## Manual runs

Send an authenticated request to `/run`:

```bash
curl -X POST \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tasks":["fetch_filled_orders"]}' \
  https://crypto-trading-cloudflare-prod.eatfreshapple.workers.dev/run
```

Supported tasks are `monitor_delist`, `cancel_pending_limits`, `fetch_filled_orders`, `auto_sell_orders`, `cancel_pending_triggers`, and `create_algo_triggers`.
