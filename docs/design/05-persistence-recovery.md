# 05 持久化、幂等与恢复

## 原则

- PostgreSQL 是交易事实源，内存是高速投影。
- WS callback 只解析、校验版本、更新内存和写入有界队列。
- 不在 socket callback 中等待 PostgreSQL、日志或 REST。
- 只有订单、fill、退市、当日 limit 结果和恢复水位进入数据库；运行配置、BUY watch 与周期性风险快照不进入数据库。每个 BUY attempt 只保存其准入时使用的精简风险摘要，便于审计和恢复 reservation。
- transaction 只包含状态校验、CAS、订单及其行内 reservation 和关键审计；持锁期间不调用 OKX。
- 业务意图只在内存优先级队列等待；取得 mutation slot 后才重新校验并提交 PREPARED 和 reservation，随后立即调用 OKX 一次。明确响应后用新短事务确认，任何调用边界异常进入 UNKNOWN。PREPARED 不证明请求未发送。

首版单进程内部不需要 Service Bus/outbox。若未来拆成多个独立 mutation 服务，再为跨服务可靠事件引入 outbox。

## 最小数据模型

PostgreSQL 运行时保留或新建：

- daily_limit_cache；
- filled_orders（统一保存管理起点之后配置交易对的 cross/cash BUY/SELL fills，并保存 fillTime/billId 与 `execution_mode`；`source=SYSTEM|ACCOUNT`。managed BUY 保存 fill_size、disposed_size、hold_hours、strategy_config_hash、sell_time、protection_price、sell_state 和 version；ACCOUNT SELL 保存 `allocation_state=PENDING|APPLIED` 与 allocated_size。remaining/generation/breach latch 不持久化，不保存实际手续费或借款利息）；
- instrument_protection（仅在被保护时存在；保存 BLACKLISTED/EXITING/EXITED/DELIST_DUST 单状态、退市元数据、version 和错误）；

新增：

| Aggregate | 关键内容 |
|---|---|
| order_attempts | 全部 BUY/SELL/DELIST 的 intent、instId、clOrdId、ordId、payload hash、source_buy_trade_id/strategy_day/generation、planned_size、状态、exchange_state、错误/failure fingerprint、`reserved_exposure_usd` 或 `reserved_base_size` 及 reservation 状态；BUY 额外保存冻结目标资金、decision_quote_ts/quote hash/decision_candle_ts/candle hash/decision_market_key、execution_limit_price、instrument version、hold_hours/config hash 和准入使用的 equity/exposure/snapshot version 摘要 |
| sync_watermarks | 按 account/instType/endpoint 分开的 orders/fills/history 连续水位、重叠窗口与健康状态，以及首次启动原子冻结的 `managed_fill_start_time`；不能用某一 SPOT 水位代表 MARGIN 已覆盖 |

关键唯一约束：

~~~text
filled_orders(inst_id, trade_id)
order_attempts(cl_ord_id)
unique order_attempts(account_id, inst_id, strategy_day, generation) where intent = 'BUY'
unique active order_attempts(account_id, inst_id) where intent = 'BUY' and state in ('PREPARED','SUBMITTED','UNKNOWN')
unique order_attempts(source_buy_trade_id, intent, generation) where intent in ('SELL','DELIST')
unique active order_attempts(source_buy_trade_id) where intent in ('SELL','DELIST') and state in ('PREPARED','SUBMITTED','UNKNOWN')
unique active order_attempts(account_id, base_ccy) where intent in ('SELL','DELIST') and state in ('PREPARED','SUBMITTED','UNKNOWN')
check BUY attempt only has reserved_exposure_usd; SELL/DELIST attempt only has reserved_base_size
transaction invariant: BUY generation > 0 uses a non-repeated/non-regressing decision_market_key, or a changed dependency version after NOT_CREATED
remaining = fill_size - disposed_size, not stored
check managed BUY: disposed_size >= 0 and disposed_size <= fill_size
check ACCOUNT SELL: fill_size > 0 and allocated_size >= 0 and allocated_size <= fill_size
PostgreSQL advisory lock singleton
account-scoped transaction advisory lock for BUY reservation
account/base transaction advisory lock for SELL reservation, system fill and external depletion allocation
~~~

所有 SYSTEM BUY 共用本策略 exposure reservation，并将按固定 0.05% 费用放大后的预计订单成本写入其 PREPARED attempt；generation 0 同时冻结本轮目标资金，后续 generation 继承该值并以同轮实际 fills 计算剩余目标。同一短事务先取得 account-scoped `pg_advisory_xact_lock`，再汇总 active reservation 和全部 managed fill remaining exposure，并检查 `strategy_committed_exposure + candidate_cost <= BUY_ADMISSION_LEVERAGE * adjusted_net_equity`。ACCOUNT BUY 已经成交，不创建 reservation，但入账后立即进入 managed exposure；非尘埃 ACCOUNT BUY 停止同 instId 当前 BUY 轮次的后续 IOC。若因此突破硬线，只停止后续 SYSTEM BUY。零成交的 reservation 只在 attempt 原子 SETTLED 时释放；SYSTEM BUY 成交在同一结算事务转为 managed fill exposure。

首版不实现 TTL lease、人工授予或 `fencing_epoch`，而是在专用 PostgreSQL 长连接上获取 session advisory lock。数据库保证同一时刻只有一个连接持锁；连接终止时自动释放。新实例拿到锁后先进入 RECOVERING，禁止新 mutation，等待 `OWNER_SAFETY_WAIT_MS`（不得少于 `ORDER_EXPIRY_MS + HTTP_TIMEOUT_MS + CLOCK_SKEW_ALLOWANCE_MS`），再对账 PREPARED/SUBMITTED/UNKNOWN、`orders-pending`、`orders-history`、`orders-history-archive` 和重叠 `fills/fills-history`。完成全量 baseline、持久化所有未决 observation、保留其 reservation 且必需快照新鲜后即可进入 READY；未解决 UNKNOWN 继续后台对账，并按其 reservation 阻止同 instId BUY 或同 base SELL/DELIST 的替代订单，不阻塞无关资产。

owner 连接丢失时实例立即停止领取和提交新 mutation；因为 PREPARED/reservation 必须先落库，失去数据库的实例不能继续下新单。已经越过最后数据库检查的请求受短 expTime 限制，新 owner 的等待窗口确保它失效后才恢复。若 UNKNOWN 长时间无法解决，系统持续告警和只读对账，保留 reservation 并隔离受影响 inst/base，不要求人工授予 owner，也不冻结无关资产的退出。

不创建 `system_control` 或运行时配置表。`TRADING_MODE`、启用交易对、每币种 `best_limit/hold_hours` 和风控参数均来自版本化部署配置，配置 hash/image digest 是唯一版本；`daily_limit_cache` 只保存当日已冻结的计算输入、SKIPPED 状态和结果，不是第二个配置源。limit 离线转换工具把源 `best_duration` 统一规范为正数 `hold_hours`：显式 `nH` 转为 n，`nD` 转为 `24*n`，无单位旧值必须由源 schema 明确声明单位，运行时禁止猜测。SYSTEM BUY 在 attempt 创建时冻结 hold_hours/hash，fill 继承并计算 sell_time；ACCOUNT BUY 在首次纳管时冻结当时配置。owner 由当前 advisory-lock session 表达，READY/recovery 是内存派生状态。`FULL` 且 lock held/READY/account risk fresh 才允许 BUY；`FULL` 或 `EXIT_ONLY` 且其退出依赖健康时允许 SELL/DELIST；`OFF` 不创建任何新 OKX mutation。所有模式都继续只读对账和数据库状态恢复，这些 guard 写 telemetry，不在数据库复制第二份事实。

Decimal 数值以明确精度的 numeric 或规范字符串保存，禁止通过 JavaScript Number 做价格/数量关键计算。

## Repository 边界

运行时只保留两个 PostgreSQL repository 接口：

- TradingStateRepository：`daily_limit_cache`、`filled_orders` 和 `instrument_protection`；运行配置、BUY watch 与 breach latch 仅在内存。
- OrderRepository：`order_attempts`（含 reservation）和 sync watermarks；advisory lock 由专用 PostgreSQL connection owner 管理。

retention/operations maintenance 使用版本化固定 SQL，不建立 OperationsRepository。D1 只由仓库外或 tools 目录的一次性离线导出脚本访问。不要为每表创建 repository，也不要建立 generic CRUD。

application service 控制 transaction 边界，并把同一个 transaction handle 显式传给 repository；repository 不得自行开始或提交事务，也不能调用 OKX 或其他网络。创建 attempt（含 reservation）在一个短事务完成；NOT_CREATED 与 reservation 释放必须同事务；SYSTEM BUY 的真实 fills、reservation 向 managed exposure 的转换/残量释放和 attempt=SETTLED 必须在同一事务完成；SYSTEM SELL/DELIST 的真实 fills、disposed_size、reservation 释放和 attempt=SETTLED 也必须在同一事务完成；ACCOUNT SELL allocated_size + BUY disposed_size 单独原子完成。旧 `src/db.js` 只属于停用前 legacy Worker，不得被 Azure 代码导入；新 PostgreSQL 代码不提供 D1 adapter 或运行时降级。

## 订单幂等

每个业务 intent 在调用 OKX 前生成永久唯一 clOrdId：

- BUY：instId + strategyDay + generation。
- SELL：instId + sourceBuyTradeId + sellGeneration。
- DELIST：instId + sourceBuyTradeId + generation。

编码固定为短版本/intent 前缀加 canonical tuple 的至少 128-bit SHA-256 截断 Base32，总长不超过 32 且只含字母数字；不得使用语言运行时 hashCode 或过短摘要。插入 clOrdId 唯一冲突时，只有业务 tuple 与 payload hash 都完全一致才视为同一 attempt；任一不一致视为 HASH_COLLISION，立即停止该 intent 并高优先级告警，绝不能查询、提交或接管碰撞行。

mutation 处理：

1. 业务意图在内存优先级队列等待，不提前创建 attempt 或 reservation。
2. 只读准备阶段选择一个最高优先级类别，并立即领取当前最多 5 个不同 instId/base 的意图，不等待凑批；重新校验依赖，再用一次最多 5 instId 的 max-avail 请求取额度。准备和 GET 不占不可抢占的 submit slot；若期间出现更高优先级类别，低优先级候选回队列并先处理退出。
3. 取得 mutation submit slot 后再次校验 TRADING_MODE、READY、行情、账户风险 freshness、instrument/protection version、fill version/remaining 和业务状态。BUY 在一个 account-scoped 短事务内按确定顺序逐项准入并创建 PREPARED/reservation；SELL/DELIST 按 canonical base 顺序取锁并创建各自 PREPARED/reservation。事务失败则本批一项都不能提交。
4. 结束事务后做最后一次 owner/mode/本地最新 version guard；BUY 失去信号或出现 ACCOUNT BUY、退出出现 PENDING ACCOUNT SELL/remaining 变化的受影响项先各自 NOT_CREATED 并释放 reservation。其余项立即通过当前 mutation slot 调用一次 `POST /trade/batch-orders`；即使只有一项也不等待更多意图。越过 HTTP 发送边界后不再假定可以撤销。
5. 明确 ack 按 clOrdId 逐项保存 ordId/SUBMITTED 或 NOT_CREATED；响应缺项、无法对应项按 UNKNOWN。一个 item 的失败不得回滚、重发或覆盖同批其他 item。
6. 请求整体超时、网络断开或进程在调用边界崩溃时，本批所有受影响 PREPARED 均按 UNKNOWN 逐单查询。
7. 按 clOrdId/ordId 查询 pending/history/orders WS。
8. 单次 `GET /trade/order` 的 NOT_FOUND 不足以证明未创建。只有原 expTime 已过、经过一致性等待窗口，并在 `orders-pending`、`orders-history`、`orders-history-archive`、重叠 `fills/fills-history` 和已接收的 orders WS 中都不存在，才可标记 NOT_CREATED 并允许新的 generation。

attempt 本地状态只使用 `PREPARED | SUBMITTED | UNKNOWN | NOT_CREATED | SETTLED`。前三者是非终态；`NOT_CREATED` 表示经最终检查未发送、被 OKX 明确拒绝且未创建，或经过完整一致性检查确认不存在；`SETTLED` 表示交易所订单已终态且 fills 已完整入账。OKX 的 `filled/partially_filled/canceled/rejected` 保存在 `exchange_state`/结果字段中，不扩展成本地状态机。fills 先按 `(inst_id,trade_id)` 去重，再汇总 fillSz；订单已观察到终态但该合计不等于 `accFillSz` 时不得 SETTLED。已有 SUBMITTED 保持 SUBMITTED，原 UNKNOWN 保持 UNKNOWN 并继续补 fills；`accFillSz=0` 的终态订单可直接按零成交原子结算。禁止使用 SQL `SUM(DISTINCT fillSz)`，因为两条不同 tradeId 可能恰好具有相同数量。

~~~text
PREPARED  -> SUBMITTED | UNKNOWN | NOT_CREATED
UNKNOWN   -> SUBMITTED | SETTLED | NOT_CREATED
SUBMITTED -> SETTLED
~~~

NOT_CREATED 与 SETTLED 无任何出边。迟到、重复或状态回退的 orders WS/REST observation 只做审计，不得回滚 attempt、恢复 reservation 或创建额外 generation；新的真实 fills 仍按 tradeId 幂等补入，并在发现“终态后出现未计入 fill”矛盾时隔离该 inst/base、告警和重对账，不能静默修改已消费预算。

重启发现 PREPARED 时不能假定请求从未发送：进程可能在 OKX 已接收后、保存响应前崩溃。它必须走与 UNKNOWN 相同的查询和一致性等待；确认未创建后才释放 reservation。PREPARED 因此是“持久化意图且提交结果未知或尚未提交”，不需要额外 SUBMITTING 状态。

历史 clOrdId 不复用。

任何 PostgreSQL commit 返回丢失或连接断开都属于“本地提交结果未知”：先按 clOrdId 或业务唯一键重读。若 PREPARED 已存在，不创建第二行或新 generation，并按正常 PREPARED 边界恢复；若 SETTLED 事务可能已提交，利用 attempt CAS、`(inst_id,trade_id)` 唯一约束和 reservation 状态幂等重放，不能重复计入 fill/exposure/disposed_size。

## Orders 与 fills

Private orders WS 是低延迟主路径，但没有启动历史快照。正确性依赖：

- orders WS 更新累计成交和订单状态；
- REST fills/fills-history 用时间重叠窗口和 billId 分页；
- 有 tradeId 时按 instId + tradeId 去重；
- 本系统订单的无 tradeId 终态按 ordId + state 去重；若它是本系统 SPOT/MARGIN BUY fill 来源，必须按 ordId 查询 REST fills 并取得真实 tradeId，不能直接据此创建 SELL task；
- 不使用 MAX(ts)+1，避免同毫秒或迟到成交遗漏；
- 本系统 fill 的成交顺序使用 `fillTime`，`ts` 仅作记录生成/接收审计；
- 历史查询分别使用 SPOT/MARGIN `instType`。REST `fills/fills-history` 不返回 `tdMode`，所以断线回补时必须通过 `ordId` 联查 order details/history，确认并持久化 `tdMode=cross|cash` 后才能纳管；不能从 fill 自身猜测模式。不纳管 isolated。

VIP4 fills WS 不作为首版依赖。

订单生命周期仍只管理匹配本系统 `clOrdId/tag` 或 attempt ledger 的订单。fill 入口只接受 `managed_fill_start_time` 之后配置交易对且确认 `tdMode=cross|cash` 的 SPOT/MARGIN BUY/SELL；BUY 成为 managed BUY，SYSTEM SELL 按 attempt 更新指定 BUY。ACCOUNT SELL 一律先 PENDING，只有相关 SPOT 与 MARGIN fills 连续水位的较小值越过其 fillTime、所有更早 BUY 已入账且同 base 没有活动系统退出 attempt 时才一次性分配并终态；PENDING 阻止同 base 新建 SYSTEM SELL/DELIST。SYSTEM BUY fill 继承 attempt 的 strategy_day、hold_hours/config hash；迟到或跨日回补不能改绑到新轮次。ACCOUNT fills 不伪造 order attempt；isolated、FUTURES/SWAP/OPTION fills 忽略。确认退市后活动订单仍按 `order_attempts` 查询。

可售余额只作为本系统 SELL/DELIST remaining 的上限。少于 remaining 时缩单，等于零时保持可恢复并等待账户/fill 更新；只有真实 SELL fills 使 remaining 归零才收敛为 SOLD/EXITED。多于 ledger 时忽略；不做余额所有权归因。

## READY、启动与重连

冷启动/进程重启执行完整顺序：

1. 校验版本化部署配置，加载 instrument protection、当日 daily limit、未卖完 fills、非终态 order、当日全部 BUY attempts 和 sync watermarks；从 BUY attempts 的冻结目标与真实 fills 重算未完成轮次剩余量，BUY watch 本身仍由最新行情重建，不增加 buy_cycles 表。首次启动在数据库原子写入且永不提前 `managed_fill_start_time`，随后用重叠 fills 回看覆盖该时点，避免启动窗口遗漏或倒灌旧成交。
2. 建立三类 WS 并确认订阅。
3. REST 获取 system status、instruments、account config、balance/risk，以及恢复本系统非终态 attempts 与 managed ledger 所需的 pending/history/重叠 fills；先按 fillTime/billId/tradeId 稳定排序并保存全部本系统及 ACCOUNT BUY/SELL fills，再推进无缺口的 fills sync watermark，不扫描 pending algo 或外部 positions。
4. 对账 clOrdId、ordId、tradeId、attempt reservation、PENDING ACCOUNT SELL 和可售量；恢复系统非终态 attempt 后，只分配 watermark 已安全覆盖的 PENDING ACCOUNT SELL，再领取新的退出任务。未被连续 watermark 覆盖的 PENDING 继续阻止同 base 新退出并触发回补。
5. 仅当匹配本系统 `clOrdId/tag` 的 OKX 订单在数据库中不存在时标记 ORPHANED；不匹配所有权的订单生命周期忽略，但管理起点之后配置交易对且确认 cross/cash 的外部 SPOT/MARGIN BUY/SELL fills 仍按 ACCOUNT fill 纳管。
6. 数据库有而 OKX 无：查询 `orders-history`、`orders-history-archive` 和重叠 `fills/fills-history` 后决定终态。
7. 恢复 PREPARED/SUBMITTED/UNKNOWN orders 和未完成逐 fill sell attempts；PREPARED 与 UNKNOWN 一样先查询。
8. 恢复 candle5m 基线。
9. 所有必需快照新鲜且无未处理矛盾后设置 READY=true；当天未完成 BUY 轮次只有在最新信号重新合格时才继续下一 generation。

RECOVERING/READY=false 时只允许 WS/REST baseline、只读 reconciliation 和既有订单状态恢复，不得创建或提交新的 BUY、SELL、DELIST attempt。进入 READY 后才恢复业务意图消费；已经提交的订单始终可以继续只读对账。

单条 WS 连接重连不重复整套冷启动：先把唯一全局 READY 置为 false，Public 只恢复 quote/instrument/status，Business 只恢复启用交易对 closed candle，Private 恢复 account/pending/history/fills。其他健康通道继续更新内存和执行只读处理；受影响 baseline 和 freshness 恢复后统一重算 READY。WS 连接自身只保存 connected/generation/baseline/freshness，不保存 READY。

## 数据库不阻塞

- 使用异步连接池、prepared statements 和超时。
- 行情和 BUY watch 不落库；普通决策事件只发 Application Insights。
- 订单（含 reservation）、fill、instrument protection 和 sync watermarks 走短事务，不可降级丢弃；advisory lock 使用独立长连接，不占业务事务连接。
- 连接池耗尽时新 BUY fail closed。
- SELL/DELIST 持久化失败时，只把尚未提交的退出意图放入内存高优先级恢复队列并告警；未成功持久化 PREPARED attempt 和数量 reservation 前禁止调用 OKX。已提交订单可以继续只读对账，但数据库恢复并完成持久化前不得生成替代 mutation。
- 不执行大事务 retention DELETE；按小批量或后续容量阈值分区处理。

## D1 离线迁移

Azure 运行时不包含 D1 SDK、凭证或 adapter。切换前由一次性离线工具从 D1 导出 JSON，做 schema/hash 校验后导入 PostgreSQL，仅包含：

- active blacklist 映射为 `instrument_protection(state=BLACKLISTED)`，并保留必要 instrument/expiry 元数据；
- 旧 `crypto_limits`/limit JSON 转换为带明确 `best_limit` 和 `hold_hours` 的版本化部署配置文件，不导入运行时数据库；缺失、非正数或单位不明确时转换失败，不能默认为 24 小时。

D1 `daily_limit_cache` 不迁移。Azure 启动后通过正常 single-flight 从 OKX 日 K 重新计算当日值并写入自己的 PostgreSQL cache，避免一次性迁移工具兼容旧 cache schema、计算 hash 和跨系统冻结语义。

不导入旧 `filled_orders`、BUY/SELL/DELIST attempts、公告处理记录、run logs、历史订单或 fills。生产镜像和 Trading Engine 不依赖 D1。启用 Azure 前必须由人工确认旧系统 managed 持仓、借款和旧系统所有 pending/algo orders 已全部处置；否则禁止把 `TRADING_MODE` 设为 `FULL`。

切换步骤：

1. 保持 legacy D1 只读，运行一次性 export/import 工具，生成带 hash 的 JSON 和导入报告；重复执行必须幂等。
2. 关闭旧 Cloudflare scheduler 和旧项目 mutation 入口，并撤销旧系统使用的 Trade API Key；共享账户其他应用的独立 Key 不受影响。
3. 取消并确认旧系统自己遗留的 pending/algo orders，并由人工核对旧系统 managed 持仓和相关借款已经处置干净；共享账户其他策略的余额、负债、订单和仓位不在清理范围内。
4. 清理核对通过后，Azure 以空交易 ledger 启动，从 `managed_fill_start_time` 之后的 SYSTEM/ACCOUNT fills 开始管理；旧终态 fills 和共享账户既有资产不进入新 ledger。
5. 生产配置启用后，Azure 自动获取 advisory lock、完成本系统 attempts 的 RECOVERING 并进入 READY；不做 D1 双写、运行时连接或回退。
