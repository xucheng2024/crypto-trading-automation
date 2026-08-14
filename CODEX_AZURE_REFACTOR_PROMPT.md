# Codex Azure 改造执行指令

请在当前仓库持续完成从 Cloudflare Cron + D1 + OKX trigger 到 Azure 常驻 WebSocket Cross Margin 交易系统的生产级改造。

## 必读顺序

1. 根目录 AGENTS.md（若存在）
2. AZURE_WS_TRADING_DESIGN.md
3. docs/design/01-architecture-runtime.md
4. docs/design/02-capital-risk-buy.md
5. docs/design/03-sell.md
6. docs/design/04-delist-protection.md
7. docs/design/05-persistence-recovery.md
8. docs/design/06-observability-operations.md
9. docs/design/07-implementation-plan.md
10. 当前 src、migrations、tests、Python/GitHub/Cloudflare 写入口

专题文档是对应规则的唯一事实源；不要把同一规则复制到多个新文档或实现模块。

## 工作方式

- 不只输出方案或伪代码；完成代码、migrations、测试、Bicep、配置示例和 runbook。
- 严格按 07 的 P0–P5 阶段推进；T0–T8 是阶段内工作包。只有阶段验收门全部通过才进入下一阶段，每次报告阶段状态、测试证据、未验证项和下一阶段风险。P5 生产切换必须另获用户明确授权。
- 做最小、安全、可回退的改动；复用现有 Decimal、stable ID、instrument normalization、fill tradeId 幂等和退市恢复思路。
- 旧 Cloudflare/D1 路径在切换前保持只读；使用一次性离线 JSON 工具把 active blacklist 导入为 `instrument_protection(state=BLACKLISTED)`，把旧 limit 配置转换为版本化部署配置。D1 daily limit cache 不迁移，Azure 启动后从 OKX 日 K 重新计算。Azure 运行时不得包含 D1 SDK、adapter、凭证、双写或回退。
- 不让 Azure、旧 Cloudflare、GitHub 或 Python 同时拥有本策略 mutation 权限；共享账户其他独立策略使用不同 API Key、tag 和 clOrdId 前缀。
- 首版固定使用共享 Multi-currency Margin `acctLv=3` 和配置的 `BASE-USDT`，不实现 Portfolio、cash 或 isolated 分支。订单生命周期所有权以版本化 `clOrdId` 前缀、固定 `tag` 和本系统 attempt ledger 为准；管理起点之后配置交易对且确认 `tdMode=cross` 的 SPOT/MARGIN fills 统一进入 managed fill ledger。其他订单、algo、余额和衍生品仓位/fills 忽略，不撤销、不恢复，也不影响 READY。
- production owner 使用 PostgreSQL session advisory lock 全自动互斥，不实现 TTL lease、fencing_epoch 或人工授予；保持 single revision/单 replica。新 owner 自动进入 RECOVERING，等待 expTime/timeout 窗口并对账非终态 attempt，满足 READY 后自动恢复交易。
- 不创建 Redis、Service Bus、第二个 Strategy Container App 或复杂事件溯源，除非代码证据证明单进程方案无法满足需求并先报告原因。
- 首版直接订阅全部启用交易对的 candle5m；只有实际限制证明不可行时才实现动态订阅状态机。
- PostgreSQL 运行时只保留 TradingStateRepository 和 OrderRepository；maintenance 使用版本化固定 SQL，不单建 Operations/Recovery/Audit repository 或 service，也不创建 system_control/crypto_limits/运行时配置表。启用交易对、best_limit、hold_hours 和风控参数只来自版本化部署配置；daily_limit_cache 只保存当日冻结结果。
- 严格按 07 的公共能力边界复用 Decimal、instrument normalization/protection、统一 `domain/order.js`、Account Snapshot、OKX transport、Order Coordinator、reconciliation primitives 和 telemetry context；不要拆分 `orders.js`/`order-id.js`，也不要创建 Intent Scheduler、Asset Exit Coordinator、command bus、`utils/common/helpers`、BaseStrategy、generic state machine 或 generic CRUD repository。
- BUY/SELL/DELIST 不得各自实现签名、mutation retry、订单状态转换、同币退出互斥或 UNKNOWN 查询；mutation 统一提交一次后对账。
- BUY/SELL/DELIST 只保存业务阶段，不保存 activeAttemptId；活动 attempt 由业务引用和部分唯一约束查询。attempt 只使用 `PREPARED|SUBMITTED|UNKNOWN|NOT_CREATED|SETTLED`，前三者非终态，不使用 SUBMITTING；filled/partially_filled/canceled/rejected 只保存为交易所结果。Reconciliation 只提交观察结果，只有 Order Coordinator 可以转换 attempt 状态。
- 业务意图只在内存优先级队列等待；取得 mutation slot 后重新校验 TRADING_MODE、READY 和依赖，再原子创建 PREPARED + reservation 并立即提交。不得为仍在队列中的意图提前创建 PREPARED。

## 绝对安全限制

- 交易开关只有 `TRADING_MODE=OFF|EXIT_ONLY|FULL`，默认 `OFF`；`EXIT_ONLY` 允许既有订单恢复和新的 SELL/DELIST，`FULL` 才允许 BUY。生产显式启用后，启动、重启、部署和故障恢复不需要人工 owner 操作。
- 不部署 Azure，不修改真实 OKX 账户，不发送真实订单，不写真实外部数据库，除非用户另行明确授权。
- 不使用 OKX 模拟盘，不建设 Shadow 交易路径。
- 验证使用单元/集成测试、fake mutation transport、脱敏事件回放、故障注入、IaC dry-run 和真实账户只读预检。
- mutation 超时必须先查询，不盲目重发。
- 重启发现 PREPARED 必须按 UNKNOWN 语义先查询；它可能代表尚未发送，也可能代表 OKX 已接收但进程尚未保存响应。确认未创建前不得释放 reservation 或重发。
- 单次 order NOT_FOUND 不足以重发；必须在 expTime 和一致性等待窗口之后同时核对 `orders-pending`、`orders-history`、`orders-history-archive`、重叠 `fills/fills-history` 与 orders WS；历史接口显式传 `instType`。
- PostgreSQL transaction 内不等待 OKX、日志或其他网络。
- 未成功持久化 PREPARED attempt 和数量 reservation 前，BUY/SELL/DELIST 都不得调用 OKX；数据库故障时内存退出队列只保存意图，不能先下单后补库。
- WS callback 不等待 PostgreSQL或 REST。
- BUY 在风险数据不完整时 fail closed；SELL、还款、退市和恢复不能静默丢失。
- `mmr=0` 时允许 `mgnRatio` 为空；只有 `mmr>0` 时才要求 `mgnRatio>1`。account WS 不假定精确 2000ms 推送，按本地 freshness 过期后 REST 恢复。

## 核心业务验收

### BUY

- 完全没有 OKX algo trigger。
- daily limit 当天固定：`bar=1D` 按 UTC+8；按时间戳取当日 K（允许 `confirm=0`）的 open 和前一交易日 `confirm=1` K 的 open/close，不能依赖返回数组固定下标。昨日涨幅过滤为 `yesterdayClose*10 > yesterdayOpen*11`；为 true 时缓存 SKIPPED_YESTERDAY_GAIN 并整日不买，恰好 10% 不跳过。原始价格为 `todayOpen*bestLimit/100`，按 tickSz 向下取整；Trading Engine 通过 `(instId,strategyDay)` first-writer-wins，不能覆盖当天值。OKX 校时不可信或新日 cache 未生成时不得沿用昨日 limit。
- last <= limit 进入 BUY_WATCH；last > limit 立即退出。
- 使用最近 confirm=1 的 5m open；只有 last > previous_closed_open 才可能买。
- 新鲜 askPx 必须 <= limit，否则不调用 max-avail 或下单。
- 不调用或缓存 `max-loan`；BUY 时点的 `max-avail-size.availBuy`、风险快照和 reservation 是唯一额度准入口径。
- 下单为 cross limit IOC + 版本前缀稳定 clOrdId + 固定 STRATEGY_TAG；sz 是 base currency，clOrdId 不超过 32 位、tag 不超过 16 位且均为字母数字；REST expTime 必须放 request header。tag 只表达共享账户策略所有权，不是 correlation ID。autoLoan 是启动必须验证为 true 的账户配置，不作为普通订单字段，也不由系统自动修改。
- clOrdId 使用短版本/intent 前缀 + canonical 业务 tuple 的至少 128-bit SHA-256 截断 Base32；唯一冲突只有 tuple 与 payload hash 均一致才幂等复用，不一致必须 HASH_COLLISION fail closed，不能接管碰撞订单。
- 启动分别查询 `GET /api/v5/account/instruments?instType=SPOT` 和 `instType=MARGIN`，交叉确认每个交易对对当前账户/注册实体可做 cross MARGIN 并读取 `tradeQuoteCcyList`；包含 USDT 时固定发送 `tradeQuoteCcy=USDT`，空列表时省略，非空但不含 USDT 时 NOT_READY。不能只用 public instruments 推断账户下单资格。
- BUY 意图按 instId coalesce，最多一条 pending 加一张活动 attempt；ticker 或 closed candle 更新都可用最新新鲜市场投影重评。只读准备阶段对当前最多 5 个候选只调用一次 max-avail，且不占不可抢占的 submit slot；若更高优先级退出到达则 BUY 回队列。随后取得 submit slot，用 account-scoped transaction advisory lock 原子汇总 reservation、逐项校验准入并把 decision_quote_ts/quote hash/decision_candle_ts/candle hash/decision_market_key、execution_limit_price、冻结目标、instrument version、hold_hours/config hash 和 equity/exposure/version 摘要写入各 attempt。首版不实现 order-precheck 状态。
- 多币同时触发按 `(generation,eligible_since,instId)` 调度，所有仍合格的 generation 0 先于任一 generation 1；不平均拆分资金、不为每币预留容量，按 2.95 风险上限尽可能准入。买后继续下跌而不满足 `last > previous_closed_open` 时暂停后续 IOC，不自动摊平；再次回升也只能消费原冻结目标剩余量。
- 本轮计划资金直接使用 OKX `totalEq`；130 USDT + 价值 20 USDT crypto 时为 150。`adjusted_net_equity=min(totalEq,adjEq)`；不使用 liab/interest 重算净值，不计算借款利息。
- 交易费用固定按每次成交 0.05% 估算。BUY 用 `order_notional*1.0005` 做资金留量和 reservation；不读取或分摊实际 feeCcy。
- 不设置持仓币种名额或 position slot。所有 BUY 只共用本策略 exposure reservation；同币种已有其他轮次/ACCOUNT 有效持仓、活动 BUY 或未释放 reservation 时不开启或继续 BUY。当前轮次自己的 SYSTEM fills 不阻止继续消耗冻结目标。
- 首次满足信号并创建 generation 0 时按 `instId+strategyDay` 冻结计划上限。本轮已消费资金只按 SYSTEM BUY fills 的 `fillSz*fillPx*1.0005` 累计，后续 SYSTEM/ACCOUNT SELL 不返还预算。每张 IOC 原子 SETTLED 后，只允许 quote/candle 时间不倒退且 `decision_market_key=hash(quote.ts,last,askPx,bidPx,closedCandleTs,closedCandleHash)` 与上一 generation 不同的最新合格市场投影继续；同毫秒不同 ticker payload、新 closed candle或同 ts candle 修正均可重评，完全重复/倒序事件不重发。IOC 在途或限频等待期间 ticker/BUY intent 都按 instId coalesce，不能排队旧行情或并发下单；信号/额度/风险暂时失效只暂停，当天恢复后继续原轮次。达到目标、低于 minSz、跨日、配置移除、instrument protection 或出现非尘埃 ACCOUNT managed BUY 时结束本轮。重启从当日 BUY attempts 的冻结目标与真实 fills 恢复剩余量，不增加 buy_cycles 表；迟到 SYSTEM fill 仍绑定原 attempt 的 strategy_day/config。
- daily_limit_price 不改写；若 tickSz 日内变化，每张新 attempt 使用 `execution_limit_price=roundToStep(daily_limit_price,currentTickSz,down)` 做 ask 检查、数量计算和 payload。PREPARED 后 instrument version 变化则 NOT_CREATED，禁止发送旧 tickSz payload。
- `MAX_STRATEGY_EFFECTIVE_LEVERAGE=3` 是本策略运行时硬停止线，`BUY_ADMISSION_LEVERAGE=2.95` 是默认 BUY 准入线；本策略达到 3 立即 BUY HALT 和告警。当前需求未授权自动卖出未到期持仓，不实现自动去杠杆旁路。
- `strategy_committed_exposure=managed_fill_remaining_exposure+system_unfilled_or_reserved_buy_exposure`。managed exposure 来自全部 SYSTEM/ACCOUNT managed BUY fills 的未卖完部分，并用新鲜 bidPx 保守估值；SYSTEM fill 与 reservation 转换时同一数量只计一次。该比率只约束本策略，不声称等于共享账户总杠杆。
- 多币种 BUY 共用本策略 exposure reservation。

### SELL

- 管理起点之后配置交易对且确认 `tdMode=cross` 的每个 SPOT/MARGIN BUY `tradeId` 都是一条 managed 卖出任务，不论来自系统还是账户其他入口。`sell_time=fill_ts+hold_hours*3,600,000`；SYSTEM fill 继承 BUY attempt 提交前冻结的 hold_hours/config hash，ACCOUNT fill 在首次纳管时冻结当时配置。remaining 只由 `fill_size-disposed_size` 读取时计算，不保存实际手续费或常量 exit_mode。
- 每条 fill 使用最近 closed 5m low 作为只上调保护价；每次 ticker 更新检查该 instId 所有到期 fills，`last <= protection` 即触发。
- Market Projection 按 fill 单调锁存跌破并排入关键队列；后续 ticker 反弹、提交失败或 partial 都不能回到价格等待。
- 触发时以该 fill 全部确认剩余 base 数量生成一张 market sell，不按固定金额拆单。
- `MUTATION_SUBMIT_CONCURRENCY=1`、`MUTATION_BATCH_MAX_ORDERS=5`：Order Coordinator 按 `DELIST > SELL > BUY` 串行执行 mutation HTTP 请求，但每次立即用 `POST /trade/batch-orders` 提交当前 1 至 5 个同类、不同 instId/base 的订单，不等待凑批、不混优先级。max-avail 一次查询同批最多 5 个 instId；BUY 在 account-scoped 事务按 `(generation,eligible_since,instId)` 逐项准入，退出按 canonical base 顺序取锁。响应按 clOrdId 逐项进入 SUBMITTED/NOT_CREATED/UNKNOWN；单项失败不影响兄弟项。请求返回或超时即释放通道，UNKNOWN 保留 reservation 后台逐单对账。同一 `(accountId,baseCcy)` 的非终态退出仍禁止替代订单。
- 每批使用相同所有权前缀的稳定 clOrdId 和固定 STRATEGY_TAG，REST expTime 放 header；market sell 的 sz 为 base currency，不发送 `tgtCcy/slippagePct`，不等待价格。所有 managed BUY 用 `tdMode=cross,reduceOnly=true` 和 reduce-only availSell 退出。reduceOnly 只防止建立反向保证金仓位，债务还清后的剩余量仍可能作为 SPOT 成交；所有订单必须受 managed remaining、实际可售量和原子 SELL reservation 限量。
- UNKNOWN 不补发；partial/canceled 的交易所结果或 NOT_CREATED 只在原 attempt 明确终态并确认该 fill 剩余量后生成一个 recovery generation。
- 观察到 exchange terminal 不等于本地 SETTLED；只有去重 fills 合计等于 accFillSz 后，才能在同一事务保存 fills、转换/释放 reservation 并置 SETTLED。零成交 accFillSz=0 也在同一事务结算。
- NOT_CREATED 只有在 decision_market_key 或导致失败的依赖版本变化后才能重试；相同 payload/dependency/sCode fingerprint 不循环。PREPARED 后必须再次校验 FULL、owner lock、READY、risk、instrument/protection/config。
- 只读 429 按 Retry-After 重试；BUY 等限频且尚未 PREPARED 时不阻塞更高优先级退出。mutation 发送边界后的 429/5xx/断线一律 UNKNOWN，不自动重发。PostgreSQL commit 响应丢失先按业务唯一键重读并幂等恢复。
- 单 fill 剩余价值小于 0.1 USDT 或数量小于 minSz 时进入 `DUST_PENDING`，不聚合其他 fills、不重复制造任务和日志；每日复核恢复可交易后直接回到 SELL_TRIGGERED，不重新等待保护价。
- 只有真实 SYSTEM/ACCOUNT SELL fills 使单 fill remaining 归零才标记 SOLD；可售余额归零时保留可恢复退出状态并低频复核。不存在 position slot。`AUTO_REPAY=false`，不维护 REPAY_PENDING，不计算借款利息，未来 BUY 继续由 totalEq/adjEq、mgnRatio、exposure 和 max-avail 门控。
- `AUTO_REPAY=false` 只约束应用主动 mutation；OKX 平台强制还款或清算仍可能出售资产，必须监控并对账。
- orders WS 与 REST fills/history 对本系统 `clOrdId/tag` 重叠回补；管理起点之后配置交易对且经 ordId 联查确认 cross 的外部 SPOT/MARGIN BUY/SELL fills 也必须进入 managed ledger。ACCOUNT SELL 一律先 PENDING；相关 SPOT/MARGIN 连续 fills watermarks 的较小值越过其 fillTime、所有更早 BUY 已入账且同 base 无活动系统退出 attempt 后，才按 `(fillTime,numeric billId,tradeId)` 顺序分配给 key 不晚于 SELL 的 BUY；billId 缺失时继续 PENDING，不猜同毫秒顺序。PENDING 期间阻止同 base 新 SYSTEM SELL/DELIST。账户余额只用于限制实际可售量，不要求与本系统 ledger 相等。
- ACCOUNT SELL 分配必须原子更新 disposed_size 与 fill version；尚未提交的 SELL_WATCH/SELL_TRIGGERED/批次候选在 PREPARED 前重读 version/remaining，人工全卖则丢弃，部分卖出只退出剩余量。非尘埃 ACCOUNT BUY 会终止同 instId 未完成 SYSTEM BUY 轮次；已提交 IOC 只对账，两边 fills 都纳管但不再继续 generation；保护中的币直接 EXITING。

### DELIST

- 每 5 分钟从 page 1 顺序调用 `GET /api/v5/support/announcements?annType=announcements-delistings&page=<n>`，直到空页或最旧 pTime 越过最近 24 小时，最多 20 页；读取 `data[0].details[]`，只处理最近 24 小时且标题包含 spot 的公告，并用边界安全的标题匹配识别配置币种。继续以 `title+pTime` 幂等，不新增 watermark；拉取失败或达到页数上限仍未越界必须告警重试，不能视为无公告。
- instruments state 非 live 只更新 Market Projection 并临时冻结 BUY，不持久化 FROZEN。active blacklist 写 `instrument_protection.state=BLACKLISTED`；expTime 新增/提前或公告确认退市写 EXITING，公告幂等沿用 `title+pTime` 语义。BUY 在创建 PREPARED attempt 前和最终提交 IOC 前重新检查 instrument/protection version；不创建独立 blacklist 或 delist_events 表。status 仅执行全局 BUY HALT。
- 普通 SELL 与退市清仓由 `(accountId,baseCcy)` 非终态 `order_attempts` 的部分唯一约束互斥。DELIST 停止领取新普通 SELL，并先对账已有 SELL/UNKNOWN；不取消、不抢占已创建订单。
- 确认 `BASE-USDT` 退市后，把该 instId 全部未完成 managed BUY fills 直接推进 DELIST 退出并复用逐 fill SELL 流程；每次卖出为 `min(fill remaining, account available, unreserved available, cross reduce-only availSell)`，不清空共享账户未纳管 BASE，也不做备用路由。
- 退市通过统一 Order Coordinator 下单。
- 在途普通 sell attempt 先对账，再卖确认剩余量。
- `BASE-USDT` 不可交易或已下线时保持 EXITING，不循环提交、不改走其他交易对；若恢复 live 则立即继续，否则持续高优先级告警。

## 简化后的 Azure workloads

实现并用 Bicep 定义：

1. Container Apps：单 Trading Engine。
2. PostgreSQL Flexible Server。
3. Key Vault。
4. NAT Gateway。
5. Monitor + Application Insights。
6. Container Registry。

每项必须承担 01 和 06 中的实际职责。不要创建空资源凑数。

默认 eastasia；固定 NAT 出口，OKX Key 仅 Read + Trade 且禁止 Withdraw。账户实体端点配置化，不写死域名。

Milestone 3 按 Microsoft for Startups 平台记录执行：至少 5 个被识别的独立 Azure 服务，每项持续至少 1 美元费用约 60 天。首版只部署具有真实职责的 Container Apps、PostgreSQL、NAT Gateway、Container Registry、Monitor/Application Insights 和 Key Vault，不预加 Private Link；Monitor/Key Vault 低用量时不得假定计数。实现 Cost Management 告警和部署后人工核对步骤，不创建自有 evidence、Blob manifest、WORM、补采任务或虚假流量；若平台实际不足 5，再选择另一个真实生产服务。

## 数据与恢复

- PostgreSQL 是交易事实源，内存是高速投影。
- PostgreSQL 交易 ledger 从切换时开始；启用 `FULL` 前必须人工确认旧系统 managed 持仓、相关借款及其 pending/algo orders 已处置干净。共享账户其他策略已有余额、负债、订单和仓位不迁移、不阻塞 READY；策略从 `managed_fill_start_time` 之后的 SYSTEM/ACCOUNT fills 开始管理。
- 本系统订单按版本化 `clOrdId/tag` 或 attempt ledger 进入订单恢复。首次启动原子冻结 `managed_fill_start_time`；之后配置交易对且确认 `tdMode=cross` 的 SPOT/MARGIN BUY/SELL fills 统一进入 fill ledger。REST fills 不含 tdMode，断线回补必须按 ordId 联查 order details/history 确认 cross。ACCOUNT BUY 不伪造 BUY attempt；ACCOUNT SELL 一律先 PENDING，在相关连续 watermarks 安全且无同 base 活动退出 attempt 后分配并终态。cash/isolated、FUTURES/SWAP/OPTION fills 忽略。
- freshness 使用 01 的集中参数；account channel 接收事件和 OKX 定期推送但不假定精确周期，closed candle 必须匹配预期上一完整 5m 桶，instrument 规则按连接 generation/baseline version 判断。WS 只保存 connected/generation/baseline/freshness，系统只有一个全局 READY。
- 使用 05 的最小表集合、唯一约束以及 TradingStateRepository/OrderRepository；TRADING_MODE 来自环境，owner 来自 advisory session，READY 在内存派生。普通 decision telemetry 进 Application Insights。
- Private orders 使用 `instType=ANY` 并在入口按所有权过滤；不扫描普通 pending、algo 或 positions。BUY 只要求 account risk snapshot 新鲜。
- telemetry 使用 OpenTelemetry/Application Insights 自带 trace_id/span_id，不生成 correlation_id/watch_id。
- PostgreSQL 首版使用强制 TLS 的公网端点且防火墙只允许固定 NAT 出口 IP，不使用 Private Link/Private Endpoint/Private DNS；Key Vault、ACR 使用公网端点和 Managed Identity/RBAC。
- orders WS + REST fills/history 重叠回看；不使用 MAX(ts)+1。
- 启动必须完成完整 pending/history/fills/account/instrument baseline 才 READY；RECOVERING/READY=false 只允许 baseline、只读 reconciliation 和既有订单恢复，不得创建或提交新的 BUY/SELL/DELIST attempt。重连只恢复受影响通道，但全局 owner READY 不拆成多套状态。
- private fills WS/VIP4 不是首版依赖。
- 初期不做表分区或全量 ticker 持久化；达到 06 的容量阈值后再升级。

## 测试

先运行现有 npm test 建立基线。实现期间运行最小相关测试，最终运行：

- 全部现有和新增单元测试；
- PostgreSQL migration/repository 并发测试；
- 公共 Decimal/instrument/order contract tests，以及所有业务模块只经共享 Order Coordinator mutation 的架构约束测试；
- BUY 两币种 reservation 后本策略不超过 2.95 准入线，3.0 为本策略运行时硬停止线；
- 退市/非 live 能阻止新 BUY_WATCH、终止已有未提交 watch，并通过 IOC 提交前检查拦截旧排队回调；已提交 IOC 仅对账实际成交；
- BUY 多币种并发通过 account-scoped transaction advisory lock 共享本策略 exposure reservation、固定 0.05% 费用留量、adjEq 保守选择和运行时 LEVERAGE_BREACH；
- 同一 instId 活动 BUY 的数据库部分唯一约束；部分/零成交只按非重复、不倒退的最新 market key 串行继续 generation、累计不超过冻结目标，IOC 在途/限频等待时 BUY intent 只保留最新版本；
- daily limit 并发 first-writer-wins、日 K 缺失和 tickSz 向下取整；本策略 managed fill 估值缺失时 fail closed；
- limit duration 的 H/D 显式转换、无单位拒绝、SYSTEM/ACCOUNT BUY 使用各币种 hold_hours，以及配置升级不改变旧 fill 的 sell_time；
- 所有 mutation HTTP 请求串行、同类最多五单即时 batch、逐项响应/UNKNOWN、同 base 非终态退出互斥，以及 SELL partial、重启和退市优先级；
- 管理起点之后系统/ACCOUNT cross BUY tradeId 各形成独立 SELL tasks；WS/REST 回补不倒灌旧成交，REST fill 必须联查订单确认 cross；ACCOUNT SELL 一律先 PENDING，相关 SPOT/MARGIN 连续 fills watermarks 的较小值覆盖其 fillTime且更早 BUY 已入账、无活动 attempt 后才一次性增加 BUY disposed_size并记录 allocated_size，期间阻止同 base 新退出；所有 managed fill 固定 cross reduce-only，不保存 exit_mode，不建立 managed position/group/items；同一 `(accountId,baseCcy)` 单一系统在途 attempt；
- schema 不包含实际 fee/feeCcy、借款利息、filled_orders.remaining_size/sell_generation/breach_latched/exit_mode、confirmed_sold_size/external_disposed_size，也不包含 protection buy_state/exit_state；测试覆盖固定 0.05% BUY 留量、ACCOUNT SELL 消耗、cross reduce-only availSell 封顶、实际可售量缩单，以及余额为零时保持可恢复、不能伪造 SOLD；
- `OFF/EXIT_ONLY/FULL` 权限矩阵，以及 EXIT_ONLY 继续 SELL/DELIST、OFF 只读对账；
- SELL 短暂跌破不会被 ticker coalescing 覆盖；base-size market payload 不含 tgtCcy/slippagePct；
- 数据库故障时 BUY/SELL/DELIST 都不会在 PREPARED/reservation 落库前下单；session advisory lock 丢失立即停止 mutation，新 owner 自动等待安全窗口并完成恢复；
- 进程在 PREPARED 后任意位置崩溃都不会盲发；恢复先查询，且 schema/代码不存在 SUBMITTING 或业务侧 activeAttemptId；attempt 本地状态严格限定为 PREPARED/SUBMITTED/UNKNOWN/NOT_CREATED/SETTLED；
- exchange terminal 与 fills/reservation/SETTLED 原子收敛，崩溃后不会出现 SETTLED 但成交未计入；人工/系统 SELL 不重新打开 BUY 预算，跨日迟到 fill 沿用原 attempt 配置；
- 退市 instrument suspend 时不循环下单、恢复 live 后退出；不计算借款利息或自动转换资产还款；
- WS 断线、倒序、重复、64008 和 READY 恢复；旧 connection generation/account uTime 不覆盖新投影，SETTLED/NOT_CREATED 不被迟到 order observation 回滚；
- 同毫秒不同 ticker、ticker/candle 到达乱序、昨日涨幅恰好/超过 10%、新加坡跨日校时、tickSz 日内变化、429/Retry-After、PostgreSQL commit ack 丢失和运行中移除交易对；
- clOrdId 同值同 payload 幂等与同值不同 tuple/payload 的碰撞 fail closed；
- 数据库/OKX/日志/maintenance Job 故障注入；
- retention 不删除非终态；
- Milestone 目标服务 Cost Management 告警和平台计数人工核对 runbook；
- Bicep lint/build 或仓库可执行的等价 dry-run。

不得为通过测试降低风险门控、删除幂等保护或恢复 trigger。

## 完成交付

最终简洁报告：

- 实现的模块和关键交易行为；
- 修改/新增文件；
- 测试和 IaC 校验；
- Azure/OKX 一次性部署前置配置；这些步骤不得进入日常交易、恢复或 owner 切换流程；
- 60 天 workload 连续计费保护与微软平台核对步骤；
- 无法在本地验证的风险。

不要创建 commit、push、PR、部署资源或启用真实交易，除非用户另行明确要求。
