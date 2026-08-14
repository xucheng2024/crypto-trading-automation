# 06 监控、运维与 Milestone 3

## 目标

系统必须能够解释：

- 何时进入/退出 BUY_WATCH 或 SELL_WATCH；
- 为什么没有买卖；
- 什么条件最终触发；
- 下单、成交或恢复在哪一步失败；
- WS 收到、策略判断、数据库抢占、REST ack、orders WS 和 fill 对账各耗时多久；
- Microsoft for Startups 是否已识别至少 5 个 Azure workloads，且每项在约 60 天内持续保持至少 1 美元费用。

## 交易审计

关键关联字段：

~~~text
trace_id / span_id
inst_id
strategy_day
source_buy_trade_id
attempt_id / generation
clOrdId / ordId / tradeId
quote / candle / account / instrument version
mutation_batch_id / mutation_batch_size
~~~

`trace_id/span_id` 直接使用 OpenTelemetry/Application Insights 自动上下文，不生成自定义 correlation_id。BUY_WATCH 是内存状态，不生成 watch_id；BUY 用 `inst_id + strategy_day`，SELL 用 `source_buy_trade_id`，订单和成交使用既有 attempt/clOrdId/ordId/tradeId。

PostgreSQL 只持久化：

- 每个订单 attempt 和最终结果；
- partial/fill/reconciliation；
- instrument protection 和 sync watermarks；不持久化手续费明细、借款利息或债务状态。

watch 进入、命中、退出、阻止原因变化和延迟作为结构化 Application Insights 事件；交易表不保存 last_reason 或 reason_counts。普通 WAIT 不逐 tick 保存，全量 ticker 不进入日志或 PostgreSQL。

建议 reason codes：

- BUY：PRICE_OUTSIDE、CANDLE_MISSING、NOT_REBOUNDING、ASK_ABOVE_LIMIT、YESTERDAY_GAIN_SKIPPED、STRATEGY_POSITION_EXISTS、BLACKLISTED、SNAPSHOT_STALE、CLOCK_UNTRUSTED、ACCOUNT_RISK_UNSAFE、AUTO_LOAN_OFF、MAX_AVAIL_LOW、LEVERAGE_LIMIT、LEVERAGE_BREACH、RATE_LIMITED、IOC_ZERO/PARTIAL/FILLED、ORDER_UNKNOWN、HASH_COLLISION。
- SELL：NOT_DUE、DUST、CANDLE_MISSING、ABOVE_PROTECTION、FILL_TRIGGERED、ORDER_PREPARED/SUBMITTED/PARTIAL/FILLED/UNKNOWN、ACCOUNT_FILL_WATERMARK_STALE、BALANCE_SHORTFALL、BALANCE_UNAVAILABLE、DB_DURABILITY_BLOCKED、HASH_COLLISION。
- DELIST：INSTRUMENT_NOT_LIVE、INSTRUMENT_NOT_TRADABLE、BLACKLISTED、EXIT_LOCKED、BALANCE_UNAVAILABLE、INFLIGHT_RECONCILING、DB_DURABILITY_BLOCKED、DELIST_DUST、EXIT_FILLED。

## 日志与容量

默认：

~~~text
APP_INSIGHTS_RETENTION_DAYS=30
APP_INSIGHTS_DAILY_CAP_MB=50
ORDER_AUDIT_RETENTION_DAYS=365
~~~

- 订单、成交、风险 halt、退市和错误 100% 保留。
- PostgreSQL 是订单事实源；Application Insights daily cap 不能作为关键交易审计的唯一存储。关键告警采用不采样指标，并在 cap 达到 70%/90% 时告警。
- Application Insights 使用一个 workspace-based resource；应用 SDK 与 Diagnostic Settings 不得重复发送同一事件，避免双倍摄取与相互矛盾的告警。
- 普通 info/debug 自适应采样。
- 日志不记录 API key、passphrase、签名、Authorization 或完整账户响应。
- 字段和错误正文截断。
- 高频 raw risk snapshots 不保存；BUY attempt 只保存本次准入使用的 equity/exposure/version 精简摘要，风险拒绝进入结构化 telemetry。
- 共享账户其他对象在输入边界过滤，不产生逐对象日志；管理起点之后配置交易对且模式可确认的 SPOT/MARGIN BUY/SELL fills 统一写入 fill ledger，并保存实际模式和 `margin|spot` 路由，只以 `source=SYSTEM|ACCOUNT` 区分并聚合记录数量和异常。本系统仍记录准入所用账户风险快照版本。
- 初期不做表分区；当单表达到 5 GB、月增长超过 100 万行或 retention DELETE 明显影响交易时再分区。
- maintenance Job 每日小批量执行 retention；非终态、UNKNOWN 和未完成退市永不按时间删除。owner 和 READY 是运行时派生状态，不参与 retention。

告警：

- WS stale/reconnect/64008；
- READY=false；
- advisory lock 丢失、owner 长时间 RECOVERING 或发现本策略存在第二个下单入口；
- BUY leverage/risk halt；
- UNKNOWN order；
- SELL/DELIST recovery backlog、ACCOUNT fill watermark 长时间不推进或 PENDING ACCOUNT SELL 积压；
- clOrdId HASH_COLLISION、OKX server time 不可信或持续限频；
- PostgreSQL 连接池/存储 70% 和 85%；
- Application Insights ingestion 70% 和 90%；
- maintenance Job 或备份任务失败；
- Key Vault/NAT/Container App 异常。

## 交易热路径时延与突发行情容量

系统不设置下单 cooldown 或微批等待 timer。健康、未被 OKX 限频且没有更高优先级退出时，验收目标为：

- WS 事件进入进程到完成策略判断并入队：P99 <= 20ms；
- 合格信号到开始发送 mutation HTTP（包含一次 max-avail 网络请求和数据库事务）：P95 <= 500ms、P99 <= 1000ms；
- PREPARED commit 完成到开始发送 mutation HTTP：P99 <= 20ms；
- 5 个不同币同时合格：最多 1 次 max-avail GET + 1 次 batch-orders POST；
- 首轮 50 个不同币同时合格且资金允许：最多 10 组上述请求，不积压每个币的旧 ticker，也不让单币 generation 1 抢在其他仍合格的 generation 0 前。

`signal_to_post` 目标包含下单前必需的 OKX 只读请求，但不包含不可控的下单 ack；限频、恢复和更高优先级抢占单独标记，不能混入正常延迟掩盖。记录 `signal_to_post_ms`、`prepared_to_post_ms`、`signal_to_ack_ms`、batch size、各优先级 queue depth、rate-limit wait 和 UNKNOWN 数量。负载验收使用 fake OKX transport 和脱敏事件回放，不向真实账户压测。

## 5+ workloads、约 60 天连续计费

Milestone 3 要求同时满足服务采用和持续使用：至少 5 个独立 Azure 服务被 Microsoft for Startups 识别为 workload，且每项连续约 60 天保持至少 1 美元费用。任一项跌破门槛并导致总数少于 5，连续计时会中断。最终资格、起算日、计数口径和自动升级结果以微软平台为准，不能由应用代码自行证明或保证。

### 实际用途

| Azure 服务 | 真实生产用途 | 计费稳定性预期 |
|---|---|---|
| Container Apps | Trading Engine 24x7 和必要的 maintenance Job | 常驻实例应稳定产生费用 |
| PostgreSQL Flexible Server | daily limit、orders、fills、protection、owner lock 和 recovery | 常驻数据库应稳定产生费用 |
| NAT Gateway | 所有 OKX REST/WS 的固定公网出口 | Gateway 按小时计费 |
| Container Registry | 保存并供应不可变生产镜像 | 使用持续计费的正式层级，不依赖偶发拉取次数 |
| Monitor/Application Insights | 生产 telemetry、dashboard 和告警 | 可能受免费额度影响，不作为稳定第五项承诺 |
| Key Vault | Managed Identity 读取、版本检查和轮换 OKX 凭证 | 低操作量可能不足 1 美元，不作为稳定第五项承诺 |

系统不创建自有 evidence manifest、WORM 容器、补采任务或为里程碑而生成虚假流量。Azure 自身的计费和 Microsoft for Startups workload 页面是唯一进度来源。

### 连续性保护

- 部署后尽快在 Microsoft for Startups 页面确认被识别的 workload 数量、每项费用和正式起算日；不能仅按 Bicep 资源数量推断。
- Cost Management 为目标服务设置预算和异常告警，但预算告警不能替代 Microsoft for Startups 的 workload 状态。
- 任何缩容、停用、SKU 变更、免费额度变化或网络架构调整前，先确认不会使有效 workload 少于 5 或跌破单项 1 美元门槛。
- 如果平台识别的有效 workload 少于 5，再选择另一个具有真实生产职责、能稳定超过 1 美元的 Azure 服务；不得预加 Private Link、空资源或虚假调用凑数。

## 自动运维任务

不把人工检查放进正常交易或恢复路径：

- Trading Engine watchdog 持续检查 READY、WS、本系统 UNKNOWN orders、risk halt、sell backlog 和 owner lock。
- Container Apps 的单个计划型 D+1 maintenance Job 仅运行真实需要的 retention 和 operations；所有子任务幂等且可补漏。
- reconciliation timer 每周对账本系统 PostgreSQL attempts/fills，并回看管理起点之后配置交易对且模式可确认的外部 SPOT/MARGIN BUY/SELL fills；balance 仅作为 SELL 可售上限和 BUY 账户风险输入。不查询 bills，不归因手续费、利息或强制还款；余额不足只让 SELL 按实际可售量收敛。
- Operations timer 每日检查 Key Vault secret expiry、NAT IP、数据库/日志容量和预算阈值；Milestone 进度由微软平台查看，不在应用内复制。
- 所有失败进入 Azure Monitor 告警；人工只接收异常通知，不参与正常 owner 授予、READY 恢复或逐单处理。

变更/重启：

- 部署 single revision；新实例自动等待 advisory lock。
- 新 owner 自动进入 RECOVERING，等待旧请求失效并查询所有在途订单。
- REST/WS baseline 和对账完成后自动 READY；正常部署不需要人工恢复。
- 异常时优先把 `TRADING_MODE` 从 `FULL` 降为 `EXIT_ONLY`；只有必须阻止全部新订单时才使用 `OFF`。
