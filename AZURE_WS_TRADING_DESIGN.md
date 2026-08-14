# Azure + OKX Cross Margin 交易系统设计

本文是设计索引和全局约束。详细规则只在对应专题文档维护，避免多处复制后产生冲突。

## 目标

- 将现有 Cloudflare Cron + D1 + OKX trigger 路径迁移为 Azure 常驻 WebSocket 交易系统。
- 使用 OKX Cross Margin Auto Borrow，允许主动使用借款，但本策略已成交敞口与未成交 BUY reservation 的预计有效杠杆不得超过 3 倍。
- BUY、SELL 均使用应用内状态机，完全不创建 OKX algo trigger。
- 简化首版架构，同时让 5 个以上 Azure 服务在约 60 天内承担真实、持续的生产职责，并确保每项持续产生至少 1 美元费用；里程碑进度以 Microsoft for Startups 平台统计为准。

## 全局硬规则

1. 本策略生产实例只有一个自动选出的 mutation owner；本系统 BUY、SELL、DELIST 都必须通过同一个 Order Coordinator。使用 PostgreSQL session advisory lock 互斥，不约束共享账户其他策略，也不使用 TTL lease 或人工授予。mutation HTTP 请求并发固定为 1，但每次可立即提交 1 至 5 个同类、不同交易对订单，不等待凑批。
2. 交易开关统一为 `TRADING_MODE=OFF|EXIT_ONLY|FULL`，默认 `OFF`。`OFF` 禁止新 mutation，`EXIT_ONLY` 只允许既有订单恢复和新的 SELL/DELIST，`FULL` 才允许 BUY。生产部署显式设为 `FULL` 后，启动、重启、升级和故障恢复自动完成 owner 获取、RECOVERING、对账和 READY；异常时优先降为 `EXIT_ONLY`，彻底停机才使用 `OFF`。
3. 不建设 Shadow 交易路径，不使用 OKX 模拟盘，也不使用 cash 小额过渡。
4. 生产使用共享 Multi-currency Margin 账户（`acctLv=3`、`autoLoan=true`）。所有新订单固定使用 `tdMode=cross`；每小时按账户 instruments 刷新能力分类：MARGIN/USDT 路由先用自有 USDT、不足时由 OKX 自动借贷，SPOT-only 路由只用自有资金。它们不是同一订单的优先级或失败回退路径。每笔 attempt/fill 同时持久化实际 `execution_mode` 与语义 `execution_route=margin|spot`，退出沿用原 BUY 路由；Margin 退出发送 `reduceOnly=true`，Spot-only 退出省略。订单生命周期只管理本系统 `clOrdId/tag/attempt`；管理起点之后配置交易对的 SPOT/MARGIN BUY/SELL fills 统一进入 managed fill ledger，只以 `source=SYSTEM|ACCOUNT` 区分。BUY 直接形成任务；ACCOUNT SELL 先 PENDING，等 SPOT/MARGIN 连续 fills watermarks 安全后才按时间顺序增加统一 `disposed_size`，期间阻止同 base 新系统退出。FUTURES/SWAP/OPTION fills 忽略。已提交系统订单与同时发生的人工卖单无法在共享账户内原子互斥，这是不使用独立子账户的明确剩余风险。
5. 净资产直接使用 OKX `totalEq`，BUY 分母使用 `min(totalEq, adjEq)`；交易成本统一按每次成交 0.05% 做保守估算，不读取或分摊实际 feeCcy；不单独计算借款利息，也不使用自定义固定 100 USDT。
6. 本策略有效杠杆 = 全部 managed BUY fills（SYSTEM 及管理起点后的 ACCOUNT）未卖完部分的保守市值 + 本系统未成交 BUY reservation，再除以调整后净权益；同一敞口只计一次。默认按 2.95 做 BUY 准入、3.0 做本策略硬停止线；这不宣称控制共享账户的总杠杆，其他活动造成的账户级风险由新鲜 `mgnRatio` 和 `max-avail-size` 自然压缩或阻止本次 BUY。
7. 不设置持仓币种名额或 position slot；BUY 数量只受本策略杠杆、OKX 可用额度、账户级风险快照和本策略同币种不重复买入约束。
8. BUY 使用 Cross Margin limit IOC；首次满足信号时冻结当日该币目标资金，只按本轮 SYSTEM BUY fills 扣减，SELL 不返还预算。每张 IOC 的 fills、reservation 和 SETTLED 原子落库后，只由非重复、不倒退的 ticker+candle 市场投影继续下一 generation；同毫秒不同价格和新 closed candle 可重评。条件暂时失效只暂停，当天恢复后继续，直至目标基本用完或出现跨日/配置移除/保护/非尘埃 ACCOUNT BUY 等终止条件。在途和限频等待期间 ticker/BUY intent 均按 instId 合并，不并发、不等待新 K 线。多币同时触发按 generation、首次合格时间、instId 排序，generation 0 优先于任何重试；继续下跌而不满足回升条件时不补仓。
9. 每条 managed BUY `tradeId` 独立保存来源、该币种 limit 配置的 `hold_hours`/配置 hash、`sell_time=fill_ts+hold_hours*3,600,000`、fill_size、disposed_size、保护价和卖出资格状态；配置更新不重算旧 fill。实际卖出量取 remaining、账户可售量与 cross reduce-only `availSell` 的较小值，统一使用 `tdMode=cross, reduceOnly=true`。`reduceOnly` 只防止建立反向保证金仓位，不保证隔离共享账户现货；真正的数量边界仍是 managed remaining、可售量和 reservation。永续成交和管理起点前余额/fills 不倒灌。
10. 所有 `POST /trade/batch-orders` 经 Order Coordinator 的单一优先级通道串行提交：`DELIST > SELL > BUY`；每批即时提交当前 1 至 5 个同类、不同 instId/base 的订单。行情、只读检查和 reconciliation 仍并发；请求得到响应或超时后释放提交通道，逐项 UNKNOWN 保留 reservation 并后台对账。同一 `(accountId, baseCcy)` 仍只允许一张非终态退出单。
11. SELL_WATCH 一旦观察到 `last <= protection_price` 就对该 fill 在内存单调锁存并排入关键队列；之后反弹不能取消本次卖出，也不重新等待行情。
12. 单 fill 剩余价值低于 0.1 USDT 或数量低于 minSz 时进入可恢复的 `DUST_PENDING`，不重复产生卖出噪音；价格或 instrument 规则变化后由每日低频复核决定是否恢复，尘埃仍由 OKX `totalEq` 和实际余额自然计入风险。
13. 每 5 分钟分页轮询最近 24 小时的 delist announcements，直到越过时间窗口或空页，最多 20 页；按 spot 标题和边界安全的币种匹配识别影响，拉取失败或未在页数上限内越界时告警重试。instruments 的 `state != live` 只由 Market Projection 临时冻结 BUY，不写数据库保护状态；expTime/公告确认退市后将 `instrument_protection.state` 原子置为 EXITING，该状态天然禁止 BUY，并在当前同 base SELL/DELIST attempt 终态后清理持仓。冻结会阻止新 BUY_WATCH，并在创建 PREPARED attempt 前和 IOC 最终提交前再次拦截。已提交 IOC 只对账实际成交。status 只做系统维护 BUY HALT。
14. 确认 `BASE-USDT` 退市后，只退出 managed BUY fills 未卖完的剩余数量，并复用逐 fill SELL 状态机；数量仍受账户当前可售余额约束。不会清空共享账户未纳管的额外 BASE，也不寻找备用交易对；不可交易或不可售时保持 EXITING，等待后续余额或 instrument 更新。
15. WS callback 不等待 PostgreSQL、日志或 REST；数据库只在可行动状态、订单和恢复节点使用短事务。
16. mutation 超时不等于失败。必须先按 clOrdId/ordId 查询，禁止盲目重发。
17. 应用不主动兑换其他资产还款；但 OKX 平台的强制还款或清算不受应用控制。
18. BUY/SELL/DELIST 只保存业务阶段，不保存 `activeAttemptId`；活动订单通过 `order_attempts` 的业务引用和部分唯一约束查询。业务意图只在内存队列等待，取得 mutation slot 后才创建 PREPARED 与 reservation 并立即提交。attempt 状态只使用 PREPARED、SUBMITTED、UNKNOWN、NOT_CREATED、SETTLED；交易所成交/部分成交/取消/拒绝只作结果字段，并且只能由 Order Coordinator 转换。Reconciliation 只提供交易所观察结果。

## 简化后的 Azure 架构

首版不使用 Redis、Service Bus，也不拆分 WS Gateway 与 Strategy Engine。一个 Azure Container App 内部按模块隔离职责，PostgreSQL 保存事实状态。

核心数据流：

~~~text
OKX Public / Private / Business WS
                |
                v
Azure Container App: Trading Engine
  market/account memory projections
  BUY / SELL / DELIST state machines
  Order Coordinator
  reconciliation and watchdog loops
                |
                v
Azure Database for PostgreSQL
~~~

Azure 运行层使用以下真实生产服务。Milestone 3 按独立 Azure 服务计数；只有平台识别且持续高于 1 美元费用的服务才计入约 60 天时钟：

| 类型 | Workload | 责任 |
|---|---|---|
| 核心 | Container Apps | 单一常驻 Trading Engine（`min=max=1`）和计划型 D+1 maintenance Job |
| 核心 | PostgreSQL Flexible Server | 交易事实源、唯一约束、owner lock、PITR/HA；Entra/Managed Identity 认证 |
| 核心 | NAT Gateway | Trading Engine 的 OKX 固定出口 IP |
| 核心 | Container Registry | 按不可变 image digest 保存并供应生产镜像；使用持续计费层级 |
| 生产支撑 | Monitor + Application Insights | 健康、风险、订单、恢复与成本告警；免费额度内可能不计 workload |
| 生产支撑 | Key Vault | 仅保存 OKX 凭证；Managed Identity 读取；低用量可能不计 workload |

高收益控制点：Daily Limit 由 Trading Engine 以纯函数按需计算并原子缓存；系统只维护一个全局 READY；所有下单前校验专用 PostgreSQL owner session 和 advisory lock；Container Apps 使用 Workload Profiles + 自定义 VNet/NAT；PostgreSQL 首版使用强制 TLS 的公网端点且防火墙只允许固定 NAT 出口 IP，不创建 Private Link/Private Endpoint/Private DNS；maintenance Job 只执行真实需要的 retention/operations。Monitor、Job、Key Vault 和 ACR 均不在逐 tick/逐订单热路径中。系统不建设自有 milestone evidence、Blob manifest 或 WORM，持续使用与费用以 Microsoft for Startups 平台记录为准。

这些服务必须承担实际职责，不能为了数量创建空资源。最终资格、实际计数和连续起算日以 Microsoft for Startups 平台为准；系统不复制里程碑证据。

## 文档导航

- [架构与运行时](docs/design/01-architecture-runtime.md)
- [资金、杠杆与买入](docs/design/02-capital-risk-buy.md)
- [卖出状态机](docs/design/03-sell.md)
- [Instrument Protection 与退市](docs/design/04-delist-protection.md)
- [持久化、幂等与恢复](docs/design/05-persistence-recovery.md)
- [监控、运维与 Milestone 3](docs/design/06-observability-operations.md)
- [模块拆分、任务顺序与切换](docs/design/07-implementation-plan.md)
- [Codex 执行指令](CODEX_AZURE_REFACTOR_PROMPT.md)

## 规则所有权

| 规则 | 唯一事实文档 |
|---|---|
| Azure 组件、WS、内存与 REST | 01 |
| 共享账户净权益、本策略 2.95 准入线/3.0 硬停止线、BUY_WATCH、IOC | 02 |
| 逐 fill SELL_WATCH、保护价、单 mutation 通道、尘埃 | 03 |
| instrument protection、退市和同 base 退出互斥 | 04 |
| PostgreSQL、订单幂等、reconciliation、重启 | 05 |
| 日志、容量、告警、Milestone 3 连续计费 | 06 |
| 代码模块、实施顺序、测试与生产切换 | 07 |

## 非目标

- 不做高频盘口或撮合系统。
- 不保存全量 ticker。
- 不使用多个服务复制同一策略状态。
- 不为首版引入 Redis、Service Bus、Kafka 或复杂事件溯源。
- 不让 Python、Cloudflare 和 Azure 同时拥有生产下单权。
- 不因满足 workload 数量而牺牲交易正确性或制造无业务价值的资源。

## 全量需求审核结论

| 需求域 | 状态 | 事实来源 |
|---|---|---|
| 无任何新 algo trigger、BUY limit IOC | 已覆盖 | 02 |
| Auto Borrow 账户校验及先用自有 USDT | 已覆盖 | 02 |
| OKX 账户净权益、本策略有效杠杆和策略级 exposure reservation | 已覆盖 | 02、05 |
| WS/内存热路径、REST 预热/恢复、数据库不阻塞 callback | 已覆盖 | 01、05 |
| BUY_WATCH、5m open 回升、ask 可成交检查 | 已覆盖 | 02 |
| 逐 BUY/SELL tradeId 成交与本系统 UNKNOWN 订单恢复 | 已覆盖 | 03、05 |
| 每个 managed BUY tradeId 独立卖出、同 base 非终态互斥、全局单请求/五单批量提交 | 已覆盖 | 03 |
| 0.1 USDT/minSz 尘埃与无重复噪音 | 已覆盖 | 03、04 |
| 共享账户只管理本系统订单生命周期，并纳管管理起点后的配置现货 fills | 已覆盖 | 01、03、05 |
| instruments 黑名单与退市持仓清理；status 维护停买 | 已覆盖 | 04 |
| 原因、失败、watch 命中、链路耗时、日志和数据库容量 | 已覆盖 | 06 |
| 5+ Azure workloads 持续约 60 天、每项持续高于 1 美元 | 已覆盖监控要求，实际计数以微软平台为准 | 01、06 |
| 无 Shadow/模拟盘、自动单 owner 恢复 | 已覆盖 | 05、07 |

杠杆边界：系统默认只授权本策略预计杠杆不超过 2.95 的 BUY，以 3.0 作为本策略运行时硬停止线；共享账户的其他活动不归本系统管理，但其对 `totalEq/adjEq/mgnRatio/max-avail-size` 的影响会进入 BUY 门控。市场波动造成的突破只触发 BUY HALT/告警，不实现自动去杠杆。
