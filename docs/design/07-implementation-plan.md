# 07 模块拆分、任务顺序与生产切换

## 当前代码

当前 src/tasks.js 同时包含行情、trigger、fills、普通卖出、退市和重试，是主要拆分对象。保留已有安全资产：

- src/decimal.js 的定点 Decimal 工具；
- stableId 思路；
- instrument rules 的 tickSz/lotSz/minSz 规范化；
- fill tradeId 幂等；
- 退市 stable ID 和 UNKNOWN 恢复思路；
- 现有测试作为迁移基线。

必须替换：

- algo trigger 和每日 cancel/rebuild；
- 同一交易对在 Margin 失败后改走 Spot 的回退路径；
- 固定 OKX_ORDER_SIZE 资金；
- autoSellOrders 逐 fill/逐 REST 一次性卖出；
- mutation 盲重试；
- MAX(ts)+1 fills 水位；
- POSITION_GATE_USD=1；
- 写死 www.okx.com、SPOT 和单进程局部限频。

## 建议模块

~~~text
src/
  domain/
    market.js
    capital-risk.js
    buy.js
    sell.js
    instrument-protection.js
    order.js
    decimal.js
    instrument.js
  application/
    market-projection.js
    account-snapshot.js
    buy-service.js
    sell-service.js
    instrument-protection-service.js
    order-coordinator.js
    reconciliation-service.js
  infrastructure/
    okx/rest-client.js
    okx/ws-public.js
    okx/ws-private.js
    okx/ws-business.js
    postgres/repositories/
    azure/
    telemetry/
  entrypoints/
    azure/trading-engine.js
    azure/maintenance-job.js
    cloudflare/legacy-worker.js
~~~

依赖只能由外向内。domain 不依赖 OKX、Azure、Cloudflare、数据库或系统时间。不要每个函数一个文件；围绕状态所有权拆分。

recovery 作为 reconciliation-service 的一组用例，不再建立独立服务；审计通过 application 共用的小型 telemetry port 输出，不建立拥有业务状态的 Audit Service。

## 公共能力边界

只抽取具有单一事实口径、被至少两个业务流程复用且错误会影响交易正确性的能力。禁止建立无业务所有权的 `utils/common/helpers` 大杂烩。

| 公共能力 | 唯一所有者 | 使用方 | 约束 |
|---|---|---|---|
| Decimal、step rounding | `domain/decimal.js` | BUY、SELL、DELIST、risk | 所有价格、数量、名义价值计算；禁止 JavaScript Number |
| instrument normalization | `domain/instrument.js` | Market Projection、BUY、SELL、DELIST | `instId/base/quote/tickSz/lotSz/minSz/state/expTime` 的唯一解析与校验 |
| order rules、stable IDs + payload hash | `domain/order.js` | BUY、SELL、DELIST、recovery | 统一订单状态、字符集/长度/版本和 payload hash；历史 intent 永不复用 |
| account/risk projection | `account-snapshot.js` | BUY gate、SELL 可售量、DELIST、告警 | 合并 account/balance；统一 freshness/version，不归因共享账户其他活动 |
| instrument protection | `instrument-protection.js` | BUY、DELIST | 单一 BLACKLISTED/EXITING/EXITED/DELIST_DUST 状态；临时 non-live 由 Market Projection 管理 |
| OKX authenticated transport | `infrastructure/okx/rest-client.js` + WS clients | 所有 OKX 调用 | 共用签名、实体域名、server time、限频、响应 `code/sCode` 校验、只读重试；mutation 不使用通用重试器 |
| mutation queue + order lifecycle | `order-coordinator.js` | BUY、SELL、DELIST | 内置 DELIST>SELL>BUY 单 HTTP 提交队列、最多五单同类 batch、逐项 attempt 状态/reservation、同 base 退出约束、幂等查询和 owner 检查 |
| reconciliation primitives | `reconciliation-service.js` | 启动、重连、UNKNOWN、定时全量对账 | 共用 pending/history/fills 重叠分页、去重和差异分类；不查询 bills |
| telemetry context | `telemetry/` 小型 port | 所有模块 | 使用 OpenTelemetry trace_id/span_id 和既有业务 ID，统一 reason code 与阶段耗时；不生成 correlation/watch ID，不拥有业务状态 |

现有代码迁移对应关系：

- `src/decimal.js` 保留并迁入 domain；不要重新实现第二套金额类。
- `tasks.js` 的 `stableId` 和 `orderState` 合并迁入 `domain/order.js`；`instrumentRules/normalizeInstrumentRules` 迁入 `domain/instrument.js`。
- `OKXClient` 的签名、query、顶层/逐项错误校验和 GET retry 保留到统一 transport；删除业务层 `placeWithRetry`，mutation 只能经 Order Coordinator 提交一次后对账。
- `availableBalance` 不作为公用余额真相；统一由 Account Snapshot 提供带 version/freshness 的余额和可售量。
- `cancelAndVerify` 仅用于生产切换前清理旧系统自己的订单；运行时不匹配所有权的订单直接忽略，不把撤单能力扩展到共享账户其他对象。

以下内容故意不抽象合并：

- BUY_WATCH 与 SELL_WATCH：触发条件、锁存和终态不同，保持独立状态机。
- BUY exposure reservation 与 SELL base quantity reservation 可以保存在同一 `order_attempts`，但必须使用互斥字段和 intent-specific CHECK 约束：BUY 只允许 `reserved_exposure_usd`，SELL/DELIST 只允许 `reserved_base_size`，禁止混用数量语义。
- BUY、SELL、DELIST service：只向 Order Coordinator 提交内存意图，不建立独立 Intent Scheduler、`BaseStrategy` 或 command bus。
- BUY、SELL、DELIST 只保存业务阶段，不保存 `activeAttemptId`；活动 attempt 由 `order_attempts` 业务引用和部分唯一约束查询。Reconciliation 只提交观察结果，由 Order Coordinator 转换状态。
- PostgreSQL 运行时只保留 TradingStateRepository 和 OrderRepository；maintenance 用固定 SQL，不创建 generic CRUD 或每表 repository。
- WS client：共用连接/session primitives，Public、Private、Business 保持各自订阅和恢复范围，但只保存 connected/generation/baseline/freshness；系统只有一个 READY。

## 六个项目阶段

阶段按顺序推进；阶段内工作可并行，但验收门未通过不得进入下一阶段。T0–T8 是下方的具体工作包，不再把任务完成等同于阶段完成。

| 阶段 | 包含工作包 | 主要交付 | 进入下一阶段的验收门 |
|---|---|---|---|
| P0 基线与安全封口 | T0 | 当前行为/测试基线、全部 mutation 入口清单、默认 `TRADING_MODE=OFF` 的新 Azure 入口、Clock/config/owner guard 契约 | 现有 legacy 测试通过；证明新 Azure 路径默认不能发送真实订单；未遗漏 mutation 入口；不连接真实 PostgreSQL/OKX/Azure |
| P1 交易基础设施 | T1–T3 | 纯领域规则、PostgreSQL schema/约束、统一 OKX transport、三类 WS 与只读 baseline | domain/DB/transport 测试通过；并发 reservation 不超限；断线/乱序/UNKNOWN 可恢复；仍不启用真实 mutation |
| P2 BUY 闭环 | T4–T5 | 单进程运行时、READY/recovery、Order Coordinator、风险门控、五单 batch IOC BUY | fake transport 跑通全成/部分/零成交/超时/重启/集中暴跌；累计目标与 2.95 准入线不被突破 |
| P3 退出闭环 | T6–T7 | 逐 fill SELL、人工 BUY/SELL 纳管、退市优先退出、审计与告警 | SELL/DELIST、人工交易竞态、partial/UNKNOWN/重启回放全部通过；同 base 无重叠退出，managed remaining 不超卖 |
| P4 部署候选 | T8 + 全部回放场景 | Azure IaC、容器镜像、迁移工具、runbook、完整故障注入和只读生产预检 | 全量自动测试、IaC dry-run、迁移 rehearsal、真实账户只读检查通过；形成可部署版本和未验证风险清单 |
| P5 受控切换与稳定观察 | 单次生产切换 | `OFF` 部署、旧入口清理、baseline/RECOVERING、READY 后显式启用 `FULL`、监控与回退能力 | 需要用户单独授权；切换核对项全部完成，首批真实订单与账本一致，无 UNKNOWN/重复 mutation/风险越线；否则立即 `EXIT_ONLY` 或 `OFF` 并按 runbook 回退 |

阶段状态只使用 `未开始 / 进行中 / 已通过 / 阻塞`。每次阶段交付必须附测试结果、尚未验证项和下一阶段风险，不用代码行数或“任务基本完成”代替验收。

## 九个实施工作包

### T0 基线和安全闸

- 阅读 AGENTS、现有 JS/Python、migrations、cron 和 GitHub workflow。
- 运行 npm test 和现有最小检查。
- 列出所有真实 mutation 入口。
- 新增 runtime-validated config、Clock、`TRADING_MODE=OFF|EXIT_ONLY|FULL`、OwnerGuard 接口和内存 recovery state；不创建 system_control 表。P0 的 OwnerGuard 默认拒绝 mutation，不伪造 PostgreSQL 锁已持有；真实 session advisory lock 在 P1 建立 PostgreSQL 基础后接入。
- 新 Azure 路径默认 `OFF`；生产显式设为 `FULL` 后仍必须同时满足后续阶段实现的 owner/READY guard。P0 不改变仍在运行的 legacy Cloudflare 行为、不部署、不调用真实 OKX mutation。

验收：旧行为和测试不变；新增配置/guard 单元测试证明缺省、非法模式、owner 未持有和 READY=false 时新 Azure 路径无法发送 mutation；mutation 清单包含代码位置、操作类型、触发入口、当前重试方式和后续迁移归属。P0 不实现交易策略、PostgreSQL schema、WS 或 Order Coordinator，验收后停止。

### T1 纯领域规则

- 提取唯一的 Decimal、`domain/order.js` 和 instrument normalization；删除 `tasks.js` 中对应重复实现。
- 实现 daily limit、capital/leverage、BUY、SELL 和 DELIST 纯函数。
- 固定 clock 和事件输入，补 deterministic tests。

验收：domain 无网络/数据库依赖。

### T2 PostgreSQL 与迁移

- 建立 05 文档中的最小 schema、唯一约束和两个运行时 repositories。
- 实现 CAS、BUY exposure reservation、逐 fill SELL 状态字段和单币串行 attempt tests；不创建 managed position 或 sell group/items。
- 提供一次性 D1 JSON 工具，把 active blacklist 导入为 `instrument_protection(state=BLACKLISTED)`，把旧 limit 的 best_duration 显式规范为每币种 `hold_hours` 并连同 best_limit 写入版本化部署配置；单位缺失且源 schema 未声明时拒绝转换，禁止默认 24 小时。不迁移 D1 daily limit cache，Azure 从 OKX 日 K 正常重算。Azure 运行时不包含 D1 adapter、SDK、凭证或 `crypto_limits` 运行时表。

验收：并发事务测试证明不超买、同一 `(accountId, instId)` 只有一个 PREPARED/SUBMITTED/UNKNOWN BUY、每 fill generation 不重复且同一 `(accountId, baseCcy)` 只有一个 SELL/DELIST 在途；attempt 状态仅有 PREPARED/SUBMITTED/UNKNOWN/NOT_CREATED/SETTLED；H/D duration 正确转换为 hold_hours、无单位且 schema 未声明时拒绝、配置升级不重算旧 fill sell_time；数据库故障时任何新 mutation 都不会在 PREPARED/reservation 持久化前提交；业务表不保存 activeAttemptId。

### T3 OKX transport 与三类 WS

- REST profile、server-time、签名、expTime、集中限频、响应校验和只读 GET retry全部走共享 transport。
- mutation 提交一次 + 未知结果查询。
- Public/Private/Business WS、ping/pong、订阅确认、64008 和 REST baseline。
- Private account/balance_and_position 提供共享账户风险和可售量；orders(ANY) 在入口识别本系统订单，另纳管管理起点之后配置交易对且模式可确认的外部 SPOT/MARGIN BUY/SELL fills。REST fill 回补必须按 `ordId` 联查 order details/history 确认实际模式，不能从不含 `tdMode` 的 fill 猜测。isolated BUY、永续、资产和仓位不进入业务逻辑；不扫描 pending algo 或 positions。
- 固定 Multi-currency `acctLv=3`、`autoLoan=true`，所有新订单使用 `tdMode=cross`。按小时刷新的是能力分类：MARGIN/USDT live 为 `margin`，否则 SPOT live 为 `spot`；这不是优先级或失败回退，不实现 Portfolio/isolated 分支。
- autoLoan 只从 account config 验证，不把它拼进 order payload；Margin 路由先消耗自有 USDT、不足时由 OKX 借贷，Spot-only 路由只用自有资金。managed 退出沿用 BUY fill 的 `execution_mode` 与 `execution_route`，Margin 发送 `reduceOnly=true`，Spot 省略。启动和每小时分别查询账户级 SPOT/MARGIN instruments；Margin 路由在需要时发送 `tradeQuoteCcy=USDT`，Spot 路由省略。

验收：fake transport 和录制事件覆盖断线、乱序、超时、单次 NOT_FOUND、多源对账和重连；不使用 OKX 模拟盘。

### T4 单进程运行时与恢复

- 有界优先级队列、ticker coalescing、按 instId 合并且最多一条 pending 的 BUY intent、版本化内存投影。
- 单一 READY gate、启动/重启 reconciliation；RECOVERING 只允许 baseline、只读对账和既有订单恢复。当日未完成 BUY 轮次从已有 attempts 的冻结目标与真实 fills 重算剩余量，watch 仍由最新行情重建，不增加 buy_cycles 表。
- Trading Engine 背景 watchdog 和低频任务接口。

验收：背压不阻塞 WS；重启后先恢复非终态订单再接收 BUY；遗留 PREPARED 先按 clOrdId 查询，不直接提交或释放 reservation。

### T5 Order Coordinator、Risk 与 BUY

- advisory lock 保证的唯一自动 mutation owner、订单 ledger 和 recovery。
- AccountCapitalSnapshot、Auto Loan/Cross 校验和本策略 exposure reservation；strategy exposure 包含全部 managed fill remaining 和按固定 0.05% 费用放大的 SYSTEM BUY reservation。ACCOUNT BUY 不创建 reservation，成交纳管后直接增加 exposure。共享账户安全只依赖新鲜 `totalEq/adjEq/mgnRatio/max-avail-size`；不计算借款利息。
- BUY 意图排队时不调用 max-avail；只读准备阶段对当前最多 5 个候选只调用一次 max-avail且不占 submit slot，更高优先级退出可抢先。随后取得 submit slot，通过 account-scoped transaction advisory lock 按确定顺序原子重算 reservation 和写入各自准入风险摘要。首版不实现 order-precheck 状态。
- BUY_WATCH、严格高于上一根已确认原生 3m high × 1.003、ask 过滤和 limit IOC；generation 0 冻结当日目标，部分/零成交后只以非重复、不倒退的最新 `decision_market_key` 串行继续；ticker、新 closed candle 或同 ts candle payload 修正均可用最新新鲜投影重评，同毫秒不同 payload 不漏判。IOC 在途或限频等待期间只 coalesce 最新市场投影/intent，不设置额外 cooldown。SYSTEM/ACCOUNT SELL 不返还已消费 BUY 预算；tickSz 变化只派生向下取整的 execution_limit_price，不改写 daily cache。
- 禁止 BUY service 自己签名、重试 mutation 或实现第二套订单状态转换。

验收：130+20=150；本策略并发币种合计不超过 2.95 准入线，3.0 为本策略运行时硬停止线；管理起点后的配置交易对 ACCOUNT cross BUY/SELL fills 在启动、重连和实时路径按规则进入 ledger，其余共享账户外部对象不进入 ledger 或阻塞 READY；全成/部分/零成交累计不超过冻结目标，重复 quote、上一 attempt 未原子 SETTLED 或 UNKNOWN 时不创建下一 generation。

### T6 逐 fill SELL 与债务观察

- 每个 managed BUY tradeId 保存 source/source attempt、实际 `execution_mode`、语义 `execution_route`、fill price、fee/feeCcy、fill_size、disposed_size、hold_hours、strategy_config_hash、sell_time、保护价、成交后最低价/最大不利幅度和 sell_state。SYSTEM fill 继承 BUY attempt 的冻结配置与路由，ACCOUNT fill 使用首次纳管时确认的模式/路由，sell_time 以后不重算。remaining 读取时计算；实际 fee 仅审计，不进入规划公式。generation 只存在于 order_attempts，breach latch 只在内存；不聚合。
- ticker 跌破条件按 fill 在 Market Projection 中单调锁存，防止 coalescing 覆盖瞬时命中。
- 每个 fill 按自己的确认剩余 base 数量提交 market sell，不按固定金额拆单。
- 所有 mutation HTTP 请求经 Order Coordinator 单通道串行提交，每次即时携带当前 1 至 5 个同类、不同 instId/base 的订单；同一 `(accountId, baseCcy)` 的非终态 attempt 继续阻止替代退出单。
- partial/unknown/restart recovery；命中后不再等待价格。
- 本系统 orders 按 `clOrdId/tag` 对账；fill 入口统一接收管理起点之后配置交易对且模式可确认的 SPOT/MARGIN BUY/SELL。BUY 直接成为 managed fill；SYSTEM SELL 按 attempt 更新指定 BUY；ACCOUNT SELL 一律先 PENDING，连续 fills watermark 安全覆盖其 fillTime 且无同 base 活动 attempt 后，才向时间不晚于该 SELL 的最早 BUY 一次分配并保存 allocated_size；PENDING 阻止同 base 新退出。isolated 和永续忽略。每次 SELL/DELIST 以持久化路由查询 max-avail；Margin 使用 reduce-only，Spot-only 使用现货可售量。不查询 bills，不归因手续费或利息。
- market sell 始终按 base 数量下单，不发送 `tgtCcy/slippagePct`。
- SELL 与 DELIST 复用 `order_attempts` 的同币非终态部分唯一约束、行内 base reservation 和剩余量确认，不复制下单/恢复代码。
- 只有真实 SYSTEM/ACCOUNT SELL fills 使单 fill remaining 归零才标记 SOLD；可售余额归零时保留 `SELL_TRIGGERED` 并低频复核。不存在 position slot。`AUTO_REPAY=false`，不维护 REPAY_PENDING，不计算借款利息。

验收：SYSTEM BUY 与管理起点之后的 ACCOUNT SPOT/MARGIN BUY tradeId 各形成独立任务；重启回看不倒灌管理起点之前的成交，REST fills 必须联查订单确认实际模式；ACCOUNT SELL 先于更早 ACCOUNT BUY 到达时保持 PENDING，watermark 覆盖并补齐 BUY 后才按时间分配，期间不创建同 base 系统退出；所有 managed fill 按持久化路由退出，Margin 使用 reduce-only、Spot-only 省略，isolated BUY 和永续不创建任务；同 base 始终一张非终态系统卖单，partial/UNKNOWN/重启不重复。同币种 Margin 可用量为零或下单失败时不创建第二张 Spot 订单。另用集成测试明确记录：reduceOnly 不能隔离共享现货，系统订单已提交后同时人工卖出仍可能双双成交，应用不能声称跨客户端互斥。

### T7 退市、审计和运维

- 退市公告每 5 分钟从 page 1 分页到越过 24 小时窗口或空页，最多 20 页且继续使用 `title+pTime` 幂等，不增加 watermark；spot 标题过滤和边界安全币种匹配保持不变。instruments non-live 只更新 Market Projection，公告/expTime 推进单状态 `instrument_protection`。
- 确认 `BASE-USDT` 退市时原子推进 protection state，并把全部未完成 managed fills 推进 DELIST；逐 fill 复用 SELL attempt，generation 只保存在 order_attempts。
- 只通过 `BASE-USDT` 卖 managed remaining，不做备用路由；每单取 remaining、实际可售量与 cross reduce-only availSell 较小值。共享账户额外 BASE 不卖且不影响 EXITED；仅剩 managed 尘埃时为 DELIST_DUST。
- 决策 reason 只进 App Insights，并实现 retention 和告警；不建 watch summary 表。
- 同一 Container Apps Environment 中的计划型 D+1 maintenance Job 只执行真实需要的 retention/operations；Milestone 3 不实现自有 evidence、Blob manifest、WORM 或补采流程。

验收：退市优先领取不重复卖；逐 fill 退出不超过 managed remaining；共享账户其他 BASE 始终保留；instrument suspend/offline 时不循环下单；单一 protection 聚合无双写竞态；日志不阻塞；非终态不被 retention 删除。

补充验收：instrument 冻结/退市后不能创建新 BUY_WATCH；已有 BUY_WATCH 和排队中的旧回调不能提交 IOC；reservation 前及 IOC 最终提交前的检查均能拦截，已提交 IOC 只对账真实成交并进入退出流程。

### T8 Azure IaC、端到端测试和切换资料

- Bicep 定义 01 中 workloads、Managed Identity、NAT、Key Vault、Monitor 和预算。
- 自动 watchdog、每日 operations 和每周全量 reconciliation timers。
- 本地事件回放、并发/重启/数据库/WS/OKX 故障注入。
- 一次性 D1 JSON export/import rehearsal、hash/导入报告、IaC dry-run 和 runbook。

验收：所有本地检查通过；未部署、未修改真实账户、未发送真实订单。

## 必须通过的事件回放场景

| 场景 | 输入时序 | 必须结果 |
|---|---|---|
| 一次完成目标 | 合格 quote -> IOC fully filled 且剩余目标低于 minSz | fills、reservation 转换和 SETTLED 单事务完成；无下一单 |
| 部分成交继续 | q1 -> partial/canceled -> q2 更新且仍合格 | q1 原子结算后只创建 generation+1；累计 SYSTEM BUY 成交成本不超过冻结目标 |
| 零成交且无新价格 | q1 -> zero fill，之后只有重复/倒序 q1 | 原子 SETTLED 并释放 reservation，但不使用同一 quote 重发 |
| 高频价格更新 | IOC 在途或限频等待时收到 q2...q100 | 内存只保留 q100，attempt 原子 SETTLED 后最多生成一个新 BUY 意图，旧 ticker 不排队 |
| 条件暂时失效 | partial 后 ask 超限或 risk stale，稍后同日恢复并出现新 quote | 暂停而非结束；恢复后沿用原冻结目标继续，不新建 buy_cycles |
| HTTP 超时/崩溃 | PREPARED 后任意点超时或进程退出 | 保持 reservation，按 UNKNOWN/PREPARED 查询；确认 NOT_CREATED 前绝不补发 |
| 终态先于 fills | orders 先报 filled/canceled 且 accFillSz>本地 fills 合计 | 保持 SUBMITTED/UNKNOWN；补齐去重 fills 后才与 reservation 一起原子 SETTLED |
| 人工 BUY 插入 | SYSTEM IOC 在途时出现非尘埃 ACCOUNT cross BUY fill | 已提交 IOC 只对账；ACCOUNT fill 纳管并停止该 instId 后续 generation，风险超线只 BUY HALT/告警 |
| 风险在提交前恶化 | PREPARED 后、HTTP 前 account snapshot 变为不安全 | 最终检查把 attempt 置 NOT_CREATED 并释放 reservation，不发送订单 |
| OKX 局部拒绝 | HTTP 顶层 code=0 但结果 sCode!=0 | 不保存 SUBMITTED；明确未创建则 NOT_CREATED，否则按 UNKNOWN 查询 |
| 人工 SELL 插入 | SYSTEM BUY 已消费目标后出现 ACCOUNT SELL | 先 PENDING，watermark 安全后增加 disposed_size；不返还冻结 BUY 预算，不形成买卖循环 |
| 午夜与迟到 fill | 旧 strategy_day 的 IOC/UNKNOWN 在次日才回补 fill | fill 绑定原 attempt 的 strategy_day、hold_hours/config hash；不能计入次日轮次 |
| 退市插入 | BUY 排队/PREPARED/已提交三个时点分别收到 protection | 排队意图丢弃；未提交 PREPARED -> NOT_CREATED；已提交订单只对账，新增 fill 立即进入 DELIST |
| SELL 竞态 | SYSTEM SELL partial，同时收到 ACCOUNT SELL 或进程崩溃 | 先按真实 tradeId 幂等入账；disposed_size 不超过 fill_size，同 base 不生成重叠系统退出单 |
| 同毫秒行情 | q1 与 q2 的 ts 相同但 last/ask 不同 | payload hash 使 market key 不同；q2 可重评，完全相同的重复 q1 不可重发 |
| ticker/candle 乱序 | ticker 先到、随后新 confirm=1 candle 到达 | BUY 用最新新鲜 quote 重新判断；SELL 上调保护价后也立即检查最新新鲜 ticker，不等待偶然的下一 tick |
| closed candle 修正 | 同 instId+ts 的 confirm=1 candle 第二次到达但 OHLC 不同 | BUY 的 candle hash/market key 更新并重评；SELL 保护价只能保持或上调，不能被修正下调 |
| 昨日涨幅边界 | 昨日恰好 +10% 与大于 +10% 两组日 K | 恰好 10% 正常计算；大于 10% 写 SKIPPED_YESTERDAY_GAIN，整日零 BUY attempt |
| 新加坡跨日缺数据 | strategy_day 切换但 OKX 校时或新日 K 缺失 | BUY HALT，不沿用昨日 daily limit；补齐后 first-writer-wins 恢复 |
| tickSz 日内变化 | daily cache 已冻结，instrument tickSz 随后改变 | cache 不改写；新单 px 向下重算 execution_limit_price，旧 PREPARED 不使用失效 payload |
| 限频与优先级 | BUY 等待 429/Retry-After 时 DELIST/SELL 到达 | BUY 保持 coalesced pending 且不占不可抢占 submit 通道；退出先执行；mutation 429 不盲重发 |
| PREPARED commit ack 丢失 | DB 已 commit 但客户端收到断线 | 按 clOrdId/业务唯一键读回已有行，不创建第二 attempt；按 PREPARED 边界恢复 |
| SETTLED commit ack 丢失 | fills/SETTLED 事务已 commit 但响应丢失 | CAS、tradeId 唯一键和 reservation 状态使重放无重复 exposure/disposed_size |
| 模式或 owner 切换 | PREPARED 后切到 EXIT_ONLY/OFF 或 advisory lock 丢失 | HTTP 前最终检查 -> NOT_CREATED+释放 reservation；不得继续 BUY |
| 运行中移除交易对 | 当日 BUY 轮次未完成时发布删除该 instId 的配置 | 不再创建 BUY generation；已有 managed fills 仍继续 SELL/DELIST |
| 相同数量的多条 fills | 同一订单两个不同 tradeId 的 fillSz 恰好相等 | 先按 tradeId 去重再求和，两条都计入；禁止 SUM(DISTINCT fillSz) |
| 外部 fills 乱序 | ACCOUNT BUY 在 t1、ACCOUNT SELL 在 t2，但 SELL 事件先到 | SELL 保持 PENDING并阻止同 base 新退出；连续 watermark 回补 t1 BUY 后再分配，不把 BUY 错留为未卖 |
| 同毫秒外部成交 | ACCOUNT BUY/SELL 的 fillTime 相同但 billId 顺序不同 | 使用 `(fillTime,numeric billId,tradeId)` 决定先后，只分配 key 不晚于 SELL 的 BUY；billId 缺失时不猜 |
| clOrdId 碰撞 | 数据库已有相同 clOrdId，但业务 tuple/payload hash 不同 | HASH_COLLISION fail closed并告警；不查询、提交或接管已有订单 |
| account 事件倒序 | 新风险快照后到达旧 uTime/旧 connection generation 事件 | 旧事件不覆盖投影；Private 重连 baseline 完成前 READY=false，不用零散事件放行 BUY |
| order 状态回退 | SETTLED 后收到迟到的 live/partially_filled observation | attempt 不回滚、不恢复 reservation、不新增 generation；观察仅审计并触发必要对账 |
| 全市场同步下跌 | BTC 与 49 个币同时出现 generation 0，BTC 随后产生重试行情 | 每批最多 5 币且不等待凑批；按 generation/eligible_since/instId 调度，其他仍合格的 generation 0 先于 BTC generation 1；原子 reservation 不越过 2.95，资金不足项等待风险版本变化 |
| 买后继续下跌再回升 | 三币部分成交后跌至不再满足回升条件，随后同日重新满足 | 下跌阶段不追加；重新满足后只消费原冻结目标 remaining，SELL 不开放预算 |
| 崩盘中风险恶化 | 多币批次间 adjEq/mgnRatio/max-avail 下降 | 后续 BUY 批次立即 fail closed；已排队快照不能放行；SELL/DELIST 仍优先提交 |
| 人工提前卖出 | 系统 SELL 排队/PREPARED 时，ACCOUNT SELL 分别覆盖全部或部分 remaining，并覆盖 HTTP 前后时点 | watermark 安全后更新 version；HTTP 前全卖则取消、部分卖只卖剩余；HTTP 后按双方真实 fills 对账且不盲目补单 |
| 人工买入系统未成交/保护币 | SYSTEM 零成交后或币已 EXITING 时出现 ACCOUNT cross BUY | fill 立即纳管并停止系统 BUY generation；普通币按人工 fill 建 SELL 任务，保护币直接进入退出 |
| batch 局部响应与超时 | 5 项中成功、明确拒绝、缺项，或请求整体超时 | 成功项 SUBMITTED；明确拒绝项 NOT_CREATED 并释放自身 reservation；缺项/整体超时项 UNKNOWN 并按 clOrdId 查询，互不回滚或盲目重发 |
| 大量退出同时触发 | 20 个不同 base 同时到 sell_time 或保护价 | DELIST/SELL 优先，按 canonical base 取锁，每批最多 5 且立即提交；同 base 始终无重叠 attempt |
| 突发行情延迟 | fake transport 注入 50 个同时合格币和高频 q2...q100 | 只保留各币最新行情，并满足 06 的 enqueue/prepared/post SLO；不因 telemetry 或历史行情积压拖慢提交 |

每个场景都必须同时断言 order payload 数量、attempt 状态、reservation、managed exposure/disposed_size、下一 generation 数量和 telemetry reason；只断言“调用成功”不算通过。

## 可并行与必须串行

可并行开发：

- T2 PostgreSQL 与 T3 OKX read-only transport；
- 三条 WS client；
- T7 监控/IaC 夹具与已经稳定的接口测试。

必须按顺序集成：

- schema/约束 -> Order Coordinator；
- Order Coordinator -> Risk/BUY；
- Risk/BUY -> SELL；
- SELL -> DELIST 抢占；
- 全部交易不变量 -> advisory-lock owner 自动恢复与生产切换。

## 验证方式

不使用 Shadow 或 OKX 模拟盘。使用：

- 纯函数单元测试；
- fake OKX mutation transport；
- 录制并脱敏的 WS/REST 事件回放；
- PostgreSQL 并发集成测试；
- 容器重启和网络故障注入；
- Azure IaC dry-run；
- 真实账户只读 config/balance 预检，并仅校验旧系统或本系统所有权匹配的 pending/fills。

## 单次受控生产切换

1. Azure 部署时先保持 `TRADING_MODE=OFF`，因此不会提交订单。
2. 停止旧 Cloudflare Cron 和旧项目 mutation 入口，撤销旧系统 Trade API Key；共享账户其他应用 Key 不受影响。
3. 保持 single revision/单 replica；旧实例终止后 advisory lock 自动释放，新实例获取锁并自动等待请求超时/expTime 失效窗口。
4. 只取消旧系统通过其所有权标记识别出的 triggers/遗留挂单，并查询对应 pending/history/fills；人工确认旧系统 managed 持仓和相关借款已经处置干净。未通过核对时禁止启用 `FULL`。
5. 使用已校验 JSON 离线导入 D1 protection 并生成版本化 limit 配置；不导入 D1 daily limit cache，Azure 从 OKX 日 K 重算。生产镜像不连接 D1；共享账户其他策略的余额、负债、订单和仓位不在清理范围内。
6. 启动 Trading Engine，三类 WS + REST baseline 达到 READY。
7. 启动前检查账户为 `acctLv=3`、autoLoan、动态 `margin|spot` 能力分类、杠杆和持久化出口路由；所有新单为 cross，market sell 使用 base 数量且不发送 `tgtCcy/slippagePct`；系统只自动对账自己的非终态 attempt。
8. RECOVERING 无矛盾且快照新鲜后自动 READY，开启完整 BUY/SELL/DELIST。
9. 首笔订单直接使用共享账户最新 `min(totalEq,adjEq)` 和本策略 exposure 计算，不使用固定小额、cash 过渡、Shadow 或模拟盘。

回退部署兼容当前 Cross 账户的上一版 Azure revision；它同样自动获取 advisory lock、RECOVERING 对账后 READY。旧 D1 只作为离线导出来源，不能被生产运行时连接，也不能重开旧 scheduler。紧急停买使用 `EXIT_ONLY`，只有必须阻止全部新订单时才使用 `OFF`。

## 完成交付

- 可运行代码、migrations、tests、Bicep、配置示例和 runbook。
- Microsoft for Startups workload 计数、单项 1 美元门槛和连续 60 天保护的部署检查与 Cost Management 告警；不建设自有 evidence/WORM。
- 测试结果、未验证风险和需要用户在 Azure/OKX 控制台完成的步骤。
- 不创建 commit、push、PR、Azure 资源或真实订单，除非用户另行明确授权。
