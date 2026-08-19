---
name: production-trade-ops
description: Diagnose recent production trading health, opportunities, blocks, and an exact instrument's durable execution timeline in this repository. Use for questions such as “有交易机会么”, “为什么被阻止”, “这个币什么时候买入/进入卖出监控”, or when telemetry and ledger evidence must be distinguished. This skill is read-only and must not be used to deploy, promote, trade, or access production by SSH.
---

# Production Trade Ops

This is a workflow-saver project automation. When reporting results, mention that once and the qualitative saving (reused setup or validation).

Use the existing operations entry points; do not construct ad-hoc Azure, PostgreSQL, SSH, or exchange commands.

## Workflow

1. Start every production-status question with:

   ```sh
   npm run ops:status -- report --since-last --details --expect-mode FULL
   ```

   Report the time range, health, configured/current-state coverage, candidate count, execution telemetry coverage, durable recovery confirmation, and every reported block. Treat `PRICE_OUTSIDE`, `BREAKOUT_NOT_CONFIRMED`, `CANDLE_PENDING`, and `ASK_ABOVE_LIMIT` as market waiting.

2. For a block, use `blocks --details`; report its stage, classification, capacity gap, and recorded evidence. For `HARD_STOP`, state that `ALL_OPEN_MANAGED_BUYS_MTM` is global ledger exposure. Do not attribute it to the candidate instrument unless a durable per-instrument timeline proves that relationship.

3. For one instrument, require an exact uppercase symbol and use the read-only timeline workflow:

   ```sh
   npm run ops:status -- trade --instrument BTC-USDT --request
   ```

   After the workflow completes, read only its matching artifact:

   ```sh
   npm run ops:status -- trade --instrument BTC-USDT --run-id <run-id> --json
   ```

   Interpret `DURABLE_EVENT` fills as ledger facts. Treat `CURRENT_STATE_SNAPSHOT` order/protection rows as current state, not historical transitions. `attemptRef` is an anonymous query-local link only.

4. Distinguish evidence explicitly:

   - `telemetry` is observed lifecycle evidence and can be incomplete.
   - `durable recovery confirmation` is a post-commit aggregate, not a complete account ledger.
   - the instrument timeline is the durable source for returned fills, prices, quantities, sell timing, and watch state.
   - absence of a trace never proves absence of execution.

5. Interpret sell watch state precisely: `WAITING` with a null protection price can mean the hold period has not reached `sellTime`; it is not proof that a watch is missing. Report `sellTime`, `forceSellTime`, `sellState`, and `protectionPrice` together.

## Safety

- Keep all reads bounded and use the scripts' redacted output only.
- Never expose credentials, account IDs, trade IDs, order IDs, decision IDs, full configuration, or raw logs.
- Never modify risk thresholds, reconciliation rows, orders, or production revisions while diagnosing.
- Deploy only through the existing GitHub Actions workflows and promote FULL only with explicit user authorization.
