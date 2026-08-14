# 01 架构与运行时

## 范围

定义 Azure workload、Trading Engine 内部边界、WebSocket/内存/REST 分工以及串并行规则。业务价格条件见 02 和 03。

## Azure workloads

默认区域为 eastasia，并通过配置覆盖。部署前必须验证订阅 SKU/配额和目标 OKX 账户端点延迟；交易热路径资源放在同一区域，不跨区域访问 PostgreSQL。

| Workload | 持续职责 | 预期活动 |
|---|---|---|
| Container Apps | Trading Engine 常驻运行三类 OKX WS 和交易状态机；计划型 Job 执行 D+1 maintenance | 24x7 实例、Job execution、请求和 revision 指标 |
| PostgreSQL Flexible Server | watch、订单、fills、reservation、黑名单和审计事实源 | 持续连接、事务、备份和容量指标 |
| Key Vault | 保存 OKX 凭证 | Managed Identity 读取、轮换审计 |
| NAT Gateway | Trading Engine 访问 OKX 的固定公网出口 | 持续 SNAT 流量和连接指标 |
| Monitor + Application Insights | 健康、延迟、错误、订单和风险告警 | 每日 telemetry 和告警状态 |
| Container Registry | 保存版本化 Trading Engine 镜像 | 构建、按 digest 拉取和 revision 对应关系 |

Milestone 3 要求至少 5 个独立 Azure 服务连续约 60 天保持每项至少 1 美元费用。首版只部署具有真实生产职责的 Container Apps、PostgreSQL、NAT Gateway、Container Registry、Monitor/Application Insights 和 Key Vault；其中 Monitor/Key Vault 低用量或免费额度内可能不计数。部署后以 Microsoft for Startups 平台确认实际 workload、60 天起算日和连续费用；未确认不足 5 前不预加 Private Link 或其他资源。不要为计数创建空资源、自有 evidence/WORM、内部消息转发 Service Bus 或仅复制内存状态的 Redis。

交易热路径只硬依赖 Container App、NAT、OKX 和 PostgreSQL。Monitor、maintenance Job、Key Vault 的轮换检查和 ACR 管理不得进入逐 tick/逐订单等待链；它们故障时告警并恢复自身任务，不能拖慢已经加载有效凭证的交易进程。Key Vault 仅在启动/轮换时读取，凭证只保存在进程内受控内存。

生产 revision 必须引用不可变 image digest（非可变 tag）。Trading Engine 与 maintenance Job 各自使用 system-assigned Managed Identity 获取 `AcrPull` 权限，不创建额外的 user-assigned identity 资源。

## 单一 Trading Engine

Container App 设置 minReplicas=1。首版建议 maxReplicas=1，正确性仍依靠 PostgreSQL 唯一约束和 CAS，而不是依赖单实例。

单实例和“完全无交易所 trigger”意味着 Azure、网络或 OKX WS 中断期间不会执行应用内 BUY/SELL，恢复后才会依据最新状态继续。minReplicas=1、健康探针和自动重启只能缩短中断，不能消除该风险；首版接受此取舍，不用 active-active 或 TTL fencing lease 增加复杂度。重启 owner 恢复由 PostgreSQL session advisory lock 和自动 reconciliation 完成。

owner lock 必须由不参与连接池复用的专用 PostgreSQL session 持有。每次 OKX mutation 前同时确认该 session 健康、锁仍持有且 owner=READY；任一条件不满足即禁止 mutation。新 revision 获锁后先等待 `OWNER_SAFETY_WAIT_MS`、对账 pending/unknown orders，再进入 READY。

内部模块：

- Market Projection：ticker、instrument/status 原始事件和 closed candle。
- Account Snapshot：`totalEq/adjEq/mgnRatio`、币种实际余额、可售量和 freshness；只服务账户级 BUY 风险门控及本系统 SELL 数量上限，不建立手续费、借款本金、利息或外部活动归因模型。
- Instrument Protection：唯一保护状态、退市元数据和 version；产生 DELIST 意图。
- BUY、SELL Service：只产生内存意图，不拥有持久化订单状态机。
- Order Coordinator：唯一 mutation owner；内置 `DELIST > SELL > BUY` 优先级队列，原子创建含 reservation 的 attempt，并通过单一 HTTP mutation 通道提交同类小批次和转换逐单状态。请求仍串行，但一个请求可并列提交最多 5 个不同交易对的订单。
- Reconciliation/Recovery：启动、断线和周期只读对账；只向 Order Coordinator 提交观察结果，不直接转换订单状态。
- Telemetry port：异步聚合日志和 summary，不拥有业务状态。

生产允许共享 `acctLv=3` 账户。每张本系统订单同时带版本化 `clOrdId` 前缀和固定 `STRATEGY_TAG`（不超过 16 位字母数字）；已持久化 attempt 的精确 clOrdId 也是所有权事实。管理起点之后，配置交易对上确认 `tdMode=cross` 的 ACCOUNT SPOT/MARGIN BUY fill 直接纳入 managed inventory；ACCOUNT SELL 一律先 PENDING，等 SPOT/MARGIN 连续 fills watermarks 覆盖其 fillTime 且无同 base 活动退出 attempt 后才按时间顺序减少 managed inventory，期间阻止该 base 新系统退出。ACCOUNT fills 不伪造外部订单状态机。切换前余额、cash/isolated 和 FUTURES/SWAP/OPTION fills 仍忽略。共享账户无法为已提交系统订单与同时发生的人工卖单提供原子互斥，这是不使用独立子账户的明确剩余风险。

模块通过进程内有界优先级队列通信：

1. 订单、账户风险、退市事件不可丢；队列满时暂停读取/重连并告警。
2. ticker 按 instId 合并，只保留最新版本。
3. BUY 候选也按 instId 合并：最多一条 pending BUY 意图加一张活动 attempt，pending 只保留最新非重复的 ticker+candle 市场投影；限频等待期间用新意图覆盖旧意图，不能把每个 tick 排成订单队列。BUY 按 `(generation ASC, eligible_since ASC, instId ASC)` 取数，使大量币同时触发时所有 generation 0 先获得机会，不能被某一币的连续 IOC 重试长期占用。SELL/DELIST 触发与订单结果仍不可丢。
4. mutation 不设置凑批等待时间：当前有 1 个合格意图就立即提交，有多个时一次最多取 5 个不同 instId/base 的同优先级意图。不同优先级不混批；max-avail 只读准备异步执行，不能阻塞 Coordinator 接收和选择新到达的 DELIST/SELL。
5. closed candle 的 instId+ts+规范化 OHLC payload 完全相同才去重；同 instId+ts 但 payload 不同视为交易所修正，更新 candle version 并告警，不能静默忽略。
6. 日志和非关键指标允许采样或丢弃，不得阻塞交易事件。

## 三类 WebSocket

- Public：`tickers`、`instruments`、`status`。
- Private：`orders(instType=ANY)`、`account`、`balance_and_position`。account 订阅省略 `extraParams`，接收事件和 OKX 定期推送但不假定精确周期；orders 正常处理本系统订单，另观察管理起点之后配置交易对且 `tdMode=cross` 的外部 SPOT/MARGIN BUY/SELL fills；其余忽略。不订阅 `positions`，也不为外部仓位建立 REST baseline。
- Business：首版订阅“全部启用交易对 ∪ 存在未完成 managed fill 的交易对 ∪ EXITING 交易对”的 `candle5m`，只接受 `confirm=1`。配置删除不能让既有退出任务失去行情。

每条连接独立维护：

- login/subscribe 确认；
- event timestamp/version；
- ping/pong 和空闲检测；
- 带抖动指数退避；
- 64008 主动重连；
- `connected`、connection generation、baseline version 和 freshness；不维护通道级 READY。

所有投影版本都包含 connection generation。Public ticker/instrument、Business candle 和 Private account/balance 只接受当前 generation 中不倒退的 exchange timestamp/version；同时间不同 payload 按各业务规则作为修正处理，旧 generation 事件直接丢弃。Private 重连后在 REST baseline 完成前不得用新 generation 的零散 account 事件恢复 READY。orders 事件可以乱序到达，但只作为 observation 交给 Order Coordinator；本地 attempt 状态只能按 05 的单向转换，SETTLED/NOT_CREATED 永不被迟到的 live/partially_filled 观察回滚。

系统只有一个全局 READY。启动执行一次完整 baseline；任一 mutation 必需通道断开或 freshness 失效时立即 `READY=false`。单条 WS 重连只恢复受影响范围：Public 恢复 ticker/instrument/status，Business 恢复启用交易对 candle，Private 恢复 account/pending/history/fills；恢复完成后统一重算全局 READY，不建立通道级 READY 状态机。

首版默认一次订阅上述完整集合的 candle5m，避免维护 PREWARM、动态订阅和冷却状态。只有实际交易对数量或 OKX 订阅限制证明该方式不可用时，才升级为活动集合动态订阅；这不是首版必做项。

## 内存、PostgreSQL 与 REST

内存保存：

- 最新 quote、instrument rules 和系统状态；
- 最新 closed 5m candle；
- BUY/SELL watch 索引；BUY watch 仅在内存存在；
- AccountCapitalSnapshot；
- 非终态订单及其已预留数量投影；
- 黑名单与部署配置版本。

首版集中配置并在启动时校验：

~~~text
QUOTE_MAX_AGE_MS=1500
ACCOUNT_MAX_AGE_MS=5000
ORDER_EXPIRY_MS=3000
HTTP_TIMEOUT_MS=2500
CLOCK_SKEW_ALLOWANCE_MS=500
OWNER_SAFETY_WAIT_MS=6000
~~~

Private `account` 依赖事件和 OKX 定期推送，不把任意 `updateInterval` 值解释为毫秒级 SLA。quote 以收到时的单调时钟计龄；BUY 超过 1500ms fail closed，SELL 只由实际收到的新 ticker 触发。account 超过 5000ms 时停止 BUY，并在 SELL 规划数量前恢复可售量。closed candle 不用“距现在多久”判断，而必须严格匹配预期上一完整 5 分钟桶且 `confirm=1`。instrument 规则以 Public 连接 generation + baseline version 判断有效性，不因长时间没有规则更新自然过期。`OWNER_SAFETY_WAIT_MS` 必须不少于 `ORDER_EXPIRY_MS + HTTP_TIMEOUT_MS + CLOCK_SKEW_ALLOWANCE_MS`。

使用交易所 UTC 时间做跨服务关联、进程单调时钟计算本地延迟；超过阈值即按业务文档 fail closed/恢复。

PostgreSQL保存：

- 所有非终态/终态交易状态；
- 唯一订单 ID、fills 和逐 fill SELL 状态；订单行同时保存其预留的 BUY exposure 或退出 base 数量；
- 黑名单、退市、恢复水位和关键审计。

REST 仅用于：

- 启动/重连 baseline；
- 数据过期或矛盾恢复；
- 本次 BUY 专用 max-avail-size；
- SELL/DELIST 下单前读取当前实际可售量，并请求 `tdMode=cross,reduceOnly=true` 的 max-avail `availSell`；它只作为 managed remaining 的上限，reduceOnly 不是共享现货隔离；
- mutation 和未知结果查询；
- fills/history 重叠回看；
- account config、leverage-info、server time 和公告等无合适 WS 的低频数据。

Daily Limit 只由 Trading Engine 使用纯函数按需计算并原子持久化；首个 BUY 判断以 REST 日 K 线 single-flight 补齐，之后复用不可变缓存。新加坡当日 limit 未确认前只停止 BUY，不影响 SELL/DELIST。

公告轮询由 Trading Engine 的低频任务执行，复用既有 NAT 出口和集中限频器；它不进入逐 tick/逐订单链路。

禁止每 tick、每 IOC 或每卖出批次重新请求 balance、instrument、candle 或 leverage。

## OKX API 契约

生产端点必须按注册实体配置；Global 默认 REST `https://openapi.okx.com`，Public/Private/Business WS 分别为 `wss://ws.okx.com:8443/ws/v5/public|private|business`。US/AU、EEA 等账户必须使用对应区域域名，不能回退 Global。启动以 `GET /api/v5/public/time` 校时并完成以下 baseline：

| 用途 | OKX API / channel | 关键约束 |
|---|---|---|
| 规则/退市 | `GET /api/v5/public/instruments?instType=SPOT`; Public `instruments` | `state=live` 才可买；`tickSz/lotSz/minSz/expTime` 增量更新 |
| 账户可交易合约 | `GET /api/v5/account/instruments?instType=SPOT` 与 `instType=MARGIN` | 启动时交叉确认配置交易对对当前账户/实体可做 cross MARGIN，并读取 `tradeQuoteCcyList`；包含 USDT 时固定发送、空列表时省略、非空但不含 USDT 时 NOT_READY |
| 行情/K 线 | Public `tickers`; Business `candle5m` | ticker 用 `last/askPx/bidPx`; candle 只收 `confirm=1` |
| 新加坡日线 | `GET /api/v5/market/candles?...&bar=1D` | `1D` 是 UTC+8，不要误用 `1Dutc`；数组按 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]` 解析，当日 K 可为 `confirm=0`，昨日 K 必须为 `confirm=1` |
| 维护 | `GET /api/v5/system/status`; Public `status` | 仅系统维护，不能推导具体币种退市 |
| 账户风险/余额 | `GET /api/v5/account/config`, `GET /api/v5/account/balance`; Private `account`, `balance_and_position` | `acctLv`、`autoLoan`、`totalEq/adjEq/mgnRatio`、币种实际余额和可售量；不盘点或归因共享账户其他持仓 |
| 杠杆 | `GET /api/v5/account/leverage-info?ccy=USDT&mgnMode=cross` | Multi-currency cross MARGIN 按币种查询 leverage；下单容量只使用订单时点的 max-avail、风险快照和 reservation |
| 下单额度 | `GET /api/v5/account/max-avail-size` | 一次最多传 5 个逗号分隔 instId；SPOT/MARGIN 的 `availBuy` 为 quote、`availSell` 为 base；Auto Borrow 下不能把它当自有余额 |
| 下单/查询 | `POST /api/v5/trade/batch-orders`; `GET /api/v5/trade/order`; Private `orders(instType=ANY)` | OKX batch 上限虽为 20，首版为与 max-avail 对齐固定每批最多 5 单；`ordType=ioc` 买、`market` 卖；订单带固定 `tag` 和版本化 clOrdId；REST `expTime` 在 header；orders 首订阅无快照 |
| 恢复 | `GET /api/v5/trade/orders-pending`; `GET /api/v5/trade/orders-history`; `GET /api/v5/trade/orders-history-archive`; `GET /api/v5/trade/fills`; `GET /api/v5/trade/fills-history` | 结果先按“clOrdId 前缀与 tag 同时匹配”或 attempt 精确 ID 过滤；只恢复本系统订单并重叠回补其 fills；orders-history/fills-history 均显式传 `instType` |
| 公告 | `GET /api/v5/support/announcements?annType=announcements-delistings&page=<n>` | 每 5 分钟分页到最旧 pTime 越过 24 小时窗口或空页，最多 20 页；响应读取 `data[0].details[]` 的 `title/url/pTime` |

REST 与 WS 交易接口共享下单限频；WS connect 为每 IP 每秒 3 次，每连接 `login/subscribe/unsubscribe` 合计每小时 480 次。所有 REST/WS 调用通过集中限频和抖动退避；429/限频响应优先遵守 `Retry-After` 或接口窗口。只读 GET 可安全重试并继续合并 BUY 意图；任何已越过 mutation 发送边界的 429/5xx/断线都按 UNKNOWN 查询，不能交给通用重试器。低优先级 BUY 等待限频许可且尚未创建 PREPARED 时不得占住不可抢占的 mutation submit 通道，新的 DELIST/SELL 可先执行。收到 `64008` 时在服务关闭前主动重连。

所有 mutation 响应必须同时检查顶层 `code == "0"` 和每个结果的 `sCode == "0"`，并按 clOrdId 对应到各 attempt：成功项进入 SUBMITTED；明确未创建的失败项进入 NOT_CREATED 并各自原子释放 reservation；缺项、无法对应或响应边界异常的受影响项进入 UNKNOWN。一个 item 失败不能回滚或重发同批已确认的其他 item。ack 只表示请求被交易所接收，最终状态以 Private `orders` 或 `GET /api/v5/trade/order?instId=...&ordId=...|clOrdId=...` 为准。`clOrdId` 限 32 个大小写字母/数字，并由系统保证历史 intent 永不复用。

## 串行、并行与异步

必须串行或原子：

- 同 instId 行情/candle 按版本处理。
- 同 BUY generation 只能有一个订单在途。
- 所有 BUY 共享本策略 exposure reservation，并使用 account-scoped transaction advisory lock 保证原子汇总。
- 所有 OKX mutation HTTP 请求通过 Order Coordinator 单通道提交；`MUTATION_SUBMIT_CONCURRENCY=1` 限制的是 HTTP 请求数，不把同一 batch 内的订单串成逐单请求。
- 每批最多 5 个不同 instId/base 的同类 BUY、SELL 或 DELIST。BUY 的 account reservation 在一个事务内按确定顺序逐项准入；退出批次按 canonical base 顺序取锁，避免死锁。
- 同一个 `(accountId, baseCcy)` 只有一个 SELL/DELIST mutation 在途，由 `order_attempts` 的部分唯一约束保证。
- PostgreSQL session advisory lock 的自动获取/释放，以及 owner 从 RECOVERING 到 READY 的状态转换。

可以受限并行：

- 三条 WS 连接和恢复。
- 不同币种的策略判断。
- BUY/SELL/DELIST 的最多 5 个 instId 合并 max-avail 读取；最终 exposure/数量 reservation 仍原子。
- 不同 base 资产已持久化 attempt 的只读 reconciliation；新 mutation 仍进入单通道。
- REST 启动预热，但必须服从集中限频器。

异步移出热路径：

- fills/history 精确补齐；
- 日志和指标；
- 低频公告元数据；
- retention 和容量报告。

## 故障原则

- 行情或风险快照过期：停止新 BUY。
- account risk snapshot 过期：停止新 BUY；SELL/DELIST 在恢复实际可售量后继续。
- 数据库不可用：继续接收并合并行情；禁止所有新 mutation；SELL/DELIST 意图进入高优先级恢复队列，恢复持久化后优先处理。
- Private orders WS 不健康：本系统 UNKNOWN 订单先 REST 查询，不补发。
- Container 重启：先恢复非终态订单和未卖完 fills；BUY watch 由最新行情重新计算，完成 READY 后才处理新信号。
- `TRADING_MODE=EXIT_ONLY` 禁止 BUY，但继续既有订单恢复和新的 SELL/DELIST；`OFF` 禁止所有新 mutation，但仍保留只读 reconciliation 和告警。

## 网络与密钥

- Container Apps Environment 必须使用 Workload Profiles、自定义 VNet 和专用委派子网（至少 `/27`）；NAT Gateway 绑定该子网，保证 Trading Engine 固定出口。
- maintenance Job 与 Trading Engine 使用同一 Container Apps Environment、同一 image digest 和 VNet，但以显式 `maintenance` command 启动；它只访问 PostgreSQL 与 Azure 管理面，不访问 OKX。Job 使用独立的 system-assigned identity，仅授予 `AcrPull`、PostgreSQL maintenance role 和 Monitoring Reader，不授予 Key Vault/OKX 读取权限。
- OKX API Key 绑定该出口 IP，只授予 Read + Trade，禁止 Withdraw。
- Azure 使用绑定 NAT IP、仅有 Read + Trade 且禁止 Withdraw 的本策略专用 API Key；同一共享账户的其他应用使用不同 Key。系统不接管或修改其他来源对象。
- Key Vault 仅保存 OKX 凭证；应用使用 Managed Identity/Entra 认证 PostgreSQL。普通运行配置只来自版本化 Container App 部署配置，PostgreSQL 不保存第二份运行配置；敏感值不写入镜像、日志或数据库。
- PostgreSQL 首版不使用 Private Link/Private Endpoint/Private DNS；使用强制 TLS 的公网端点，防火墙只允许 Container Apps 的固定 NAT 出口 IP，并启用适合区域/SKU 的 HA、PITR 和定期恢复演练。Key Vault 和 ACR 使用公网端点、Managed Identity/RBAC、禁用 admin credentials；Key Vault 在服务支持且不影响启动时限制到 NAT 出口。只有出现明确合规或网络隔离需求时才评估 Private Link。
- REST/Public/Private/Business 域名按账户注册实体配置，启动时用只读 account config 验证，不写死单一区域域名。
