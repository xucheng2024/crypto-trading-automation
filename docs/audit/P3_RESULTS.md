# P3 results

## P3 status

已通过。T6–T7 的逐 fill SELL、ACCOUNT SELL 乱序分配、统一 Coordinator 退出通道、protection/DELIST、恢复、retention 与非阻塞 telemetry 均完成离线回放和真实临时 PostgreSQL 验证；实现停在 P3，未进入 P4。

## Delivered

- `0002_p3_exit.sql` 增加退出查询/幂等索引和持久化公告 receipt；`0001_p1_core.sql` 保持不变。
- SELL callback 只更新投影、锁存并投递关键事件；消费者通过 CAS 持久化 protection/`SELL_TRIGGERED`，逐 fill 进入唯一 Coordinator。
- Coordinator 实现 `DELIST > SELL > BUY`、最多五个不同 base 的 cross reduce-only market batch、逐项 SUBMITTED/NOT_CREATED/UNKNOWN、base reservation、partial generation 和矛盾隔离。
- ACCOUNT SELL 使用与系统退出相同的 account/base advisory lock，按双 SPOT/MARGIN watermark 和 `(fillTime,numeric billId,tradeId)` 分配；重复、并发、重启和短缺均 fail closed。
- durable protection 驱动逐 fill 串行 DELIST；重启后从真实 ledger 计算下一 generation，最终只按真实 fills 收敛 `EXITED` 或 `DELIST_DUST`，共享账户额外 BASE 不进入计划数量。
- 公告以整页事务保存 `title+pTime` receipt/protection，覆盖 24 小时、20 页、失败回滚和幂等重放；固定 retention SQL 只清理过期终态 attempt。
- telemetry 对同步异常、rejected promise 和永久 pending promise均与交易、事务和 reconciliation 隔离。

## Scenario → automatic-test mapping

| Scenario | Automatic evidence | Status |
|---|---|---|
| DELIST > SELL、1–5 batch、reduce-only payload、UNKNOWN reservation | `p3-exit.test.js` — `P3 exits submit…` | Covered |
| ticker/candle 乱序、same-ts 修正、breach latch、关键队列/CAS | `p3-exit.test.js` — `P3 engine latches…` | Covered |
| WAITING/SELL_TRIGGERED/DUST_PENDING 与 PREPARED/UNKNOWN recovery | `p3-exit.test.js` — `P3 recovery retains…` | Covered |
| dust 恢复且不重新等待 breach | `p3-exit.test.js` — `P3 dust recovery…` | Covered |
| slow/throw/rejected telemetry 不阻塞 Coordinator 或 READY fail-closed | `p3-exit.test.js` — `P3 slow or rejected telemetry…` | Covered |
| partial/SETTLED ack-loss、精确 remaining、generation+1 一次 | `postgres.integration.test.js` — `P3 partial exit…` | Covered |
| numeric billId、重复 SYSTEM SELL、非法 billId PENDING | `postgres.integration.test.js` — `P3 account SELL allocation…` | Covered |
| PREPARED 人工 SELL、双 watermark 较小值 | `postgres.integration.test.js` — `P3 account SELL releases…` | Covered |
| protection → DELIST reservation/payload | `postgres.integration.test.js` — `P3 unified PG protection orchestrator…` | Covered |
| 同一 fake OKX + 同一 PG 的 multi-fill、partial、UNKNOWN、重启、DELIST_DUST/EXITED | `postgres.integration.test.js` — `P3 unified fake OKX…` | Covered |
| 并发 ACCOUNT SELL、活动系统退出、HTTP 后矛盾隔离 | `postgres.integration.test.js` — `P3 concurrent ACCOUNT SELL…` | Covered |
| 公告跨页/24h/20页、失败整页回滚、持久化幂等 | `postgres.integration.test.js` — `P3 announcement paging…` | Covered |
| retention 不删除活动 attempt、PENDING SELL、receipt、watermark | `postgres.integration.test.js` — `P3 fixed retention…` | Covered |
| owner session 丢失、PG stop/start、安全等待 | `postgres.integration.test.js` — `P2 database restart…` | Covered/no regression |

## Verification

| Command | Result |
|---|---|
| `npm test` | PASS — 94 tests |
| `npm run test:postgres` | PASS — 22 temporary PostgreSQL tests |
| `python3.11 -m pytest tests` | PASS — 29 tests |
| `npm run check` | PASS — Wrangler dry-run only; no deployment |
| `git diff --check` | PASS |

`7day_limit.json` SHA-256 remained `b2db9d9fa6bdc4a362f0053ee119ce585622e07717841a1b548419a392182add`; `limits_d1.json` remained `0e748f56129e63c95dc2978ac4a6362674f2fa35e17c62aa98e8f61b74fa74b6`.

## Deliberately unverified / P4 boundary

- 未访问真实 OKX、Cloudflare、Azure 或远端 PostgreSQL，未使用模拟盘，未部署。
- 未实现 P4 的 Azure IaC、容器镜像、maintenance Job、生产只读预检或切换 runbook。
- `reduceOnly` 不能提供共享现货的跨客户端原子隔离；系统订单越过 HTTP 边界后与人工卖单仍可能同时成交。实现只按真实 tradeId 对账、隔离矛盾并告警，不宣称消除此账户级剩余风险。
