# 03 卖出状态机

## 一条 BUY fill 就是一条卖出任务

每个 managed BUY fill 都按 `instId + tradeId` 幂等保存并直接承载自己的卖出状态、实际 `execution_mode` 与语义 `execution_route`。managed BUY 包括本系统 BUY，以及管理起点之后配置交易对上的 ACCOUNT SPOT/MARGIN BUY fill；不纳管 isolated fill：

~~~text
sell_time = fill_ts + hold_hours * 3,600,000 ms
remaining_size = fill_size - disposed_size
~~~

保存 OKX 返回的实际 fill price、fee 和 feeCcy 供事后审计，但不把实际手续费分摊进 base 数量或风险公式。资金规划仍统一使用 `estimated_fee = fill_notional * 0.0005`；实际下单始终受账户当前可售 base 限制，因此不会为手续费差异借入 base。

不创建 `managed_position`、`sell_group`、`sell_group_items` 或固定金额批次，也不把多个 fills 聚合成一张卖单。一个 BUY order 若产生三条 tradeId，就产生三条独立卖出任务。

每条 BUY fill 至少保存：

~~~text
inst_id / trade_id / buy_ord_id / source
fill_size / disposed_size
fill_ts / hold_hours / sell_time / strategy_config_hash
protection_price / sell_state / version
~~~

SYSTEM BUY fill 必须继承其 BUY attempt 在提交前冻结的 `hold_hours/strategy_config_hash`，避免跨日、重启或配置发布后的迟到 fill 使用新配置；ACCOUNT BUY fill 在首次纳管时冻结当时有效配置。以后发布新配置不能重算旧 fill 的 sell_time。`remaining_size = fill_size - disposed_size` 只在读取时用 Decimal 计算，不持久化。`disposed_size` 不区分系统卖出还是人工卖出；来源只保留在对应 SELL fill 上用于审计。下一代 generation 在锁定源 fill 后由 Order Coordinator 根据既有 `order_attempts` 原子分配，只保存在订单表。`breach_latched` 仅是进程内防重复入队标记；持久化后的 `SELL_TRIGGERED` 已表达同一事实。

同一 instId 可以有多个等待中的 fill；共享同一 base 余额的交易对按 `(accountId, baseCcy)` 互斥，任意时刻只允许一张 SELL/DELIST order 在途。所有 mutation HTTP 请求串行，同批最多并列 5 个不同 base 的订单。

## 尘埃

~~~text
POSITION_DUST_THRESHOLD_USDT=0.1
fill_remaining_value_usdt=remaining_size * fresh_bid_px
~~~

- 提交前按最新 instrument rules 把 `remaining_size` 依 `lotSz` 向下取整。
- 可下单数量小于 `minSz`，或 fill 剩余价值小于 0.1 USDT 时，标记该 fill 为 `DUST_PENDING`，不聚合其他 fills，也不重复生成任务或日志。
- 本系统尘埃 fill 仍计入本策略 exposure；共享账户净资产继续由 OKX `totalEq/adjEq` 体现。
- 余额或价格变化后每日低频复核；单条 fill 恢复到可交易条件时直接回到 `SELL_TRIGGERED` 并继续退出，不重新等待保护价。`DUST_PENDING` 不是已结算终态。

## SELL_WATCH

每条 fill 到达 `sell_time` 后读取最近一根 `confirm=1` 的 OKX 原生 3m K 线：

~~~text
protection_price=last_closed_candle.low * 0.997
~~~

每根新的确认 K 线都以其 `low * 0.997` 替换该 fill 的阈值，阈值可以上移或下移；完全相同的重复 candle 忽略，同 instId+ts 但 OHLC payload 不同的修正也以修正后的 low 为准。更新后立即用该 instId 最新且仍新鲜的已接收 ticker 检查一次 breach；这样 ticker 先到、candle 后到时不会漏判。ticker 已过期则等待下一条实际 ticker。倒序或 `confirm=0` 不修改状态。

每次收到该 instId 的新鲜 ticker，遍历内存中该币种已到期的 SELL_WATCH fills：

~~~text
last < protection_price
~~~

相等不触发。观察到严格跌破时，Market Projection 必须先原子设置该 fill 的 `breach_latched=true`，再将高优先级 SELL_BREACH 事件放入关键队列。ticker callback 不等待数据库。

锁存不可逆：后续价格反弹不能回到 SELL_WATCH。消费者先持久化 `SELL_TRIGGERED` 并排入高优先级内存队列；取得 mutation slot 后重新校验并在短事务内创建 PREPARED attempt 与 reservation，随后立即提交 market sell。提交失败、部分成交或 UNKNOWN 只进入订单对账/恢复，不重新等待价格，也不要求下一条 ticker 再次命中。

数据库不可用时锁存和关键事件留在当前进程并持续重试；PREPARED attempt 和 base 数量 reservation 未持久化前不得下单。若数据库故障期间容器也永久丢失，纯内存锁存可能丢失；这是首版不使用交易所 trigger、第二持久化日志或多副本的明确可用性取舍。

## 单 mutation 通道

默认配置：

~~~text
MUTATION_SUBMIT_CONCURRENCY=1
MUTATION_BATCH_MAX_ORDERS=5
AUTO_REPAY=false
~~~

三项在首版均为固定安全不变量，不作为可动态调高/开启的运行时参数。

调度规则：

- Order Coordinator 内置 `DELIST > SELL > BUY` 优先级队列；不建立独立 Intent Scheduler。
- 同一时刻最多执行一个 OKX mutation HTTP 请求；该请求可带 1 至 5 个同类、不同 base 的订单，有 1 个就立即发，不设置凑批延迟。行情、只读检查和 reconciliation 不受该限制。业务意图只在内存队列等待，取得 mutation slot 后才创建 PREPARED attempt。
- DELIST、SELL、BUY 不混在同一批；批次间仍严格 `DELIST > SELL > BUY`。退出批次按 canonical base 顺序取事务锁并逐项重验，避免多 base 死锁。
- 请求明确返回或超时后释放提交通道；UNKNOWN 继续占用自己的 reservation，但不阻塞其他资产提交。
- 同一 `(accountId, baseCcy)` 严格按 `sell_time, fill_ts, trade_id` 顺序领取，一个 attempt 终态前不领取下一条 fill。
- 数据库使用 CAS/SKIP LOCKED 领取；`order_attempts` 的部分唯一约束保证同一 base 资产不会存在第二张非终态 SELL/DELIST。
- 每个 fill 对应的 `order_attempts.generation` 单调递增，`clOrdId=stableHash(instId,tradeId,generation)`；generation 不复制到 filled_orders。
- 同一 generation 的 planned_size 创建后不可修改；UNKNOWN 未解决前不得创建下一 generation。

每次 attempt 的数量：

~~~text
planned_size = roundToStep(
  min(fill.remaining_size, confirmed_available_base, reduce_only_avail_sell),
  lotSz,
  down
)
~~~

所有 managed BUY 均按其持久化路由退出；两类新单都使用 `tdMode=cross`，Margin 路由使用 `reduceOnly=true`，Spot-only 路由不发送 `reduceOnly`：

~~~text
instId=<fill instrument>
side=sell
ordType=market
tdMode=<fill.execution_mode；新单固定 cross>
reduceOnly=<仅 execution_route=margin 为 true；spot 省略>
sz=<planned base currency quantity>
clOrdId=<版本前缀 + 稳定哈希，不超过 32 位字母数字>
tag=<固定 STRATEGY_TAG>
~~~

market sell 不发送 `posSide`、Futures-mode-only `ccy`、`tgtCcy` 或 `slippagePct`。`sz` 始终是 base 数量。REST `expTime` 只放 HTTP header。外部 isolated MARGIN BUY 不纳入首版管理，避免引入独立保证金分支。

正常 attempt 使用内存 instrument/account projection，不逐 fill 请求 balance 或 rules。只读准备阶段对最多 5 个不同 instId 的 SELL/DELIST 只调用一次 `GET /api/v5/account/max-avail-size?instId=<逗号分隔instId>&tdMode=cross`，不占 mutation submit slot，并逐项以 base 单位 `availSell` 封顶；该读取不传 `reduceOnly`，因为部分 cross-margin 账户会返回 code 3 `Operation not supported`。实际 margin SELL 仍传 `reduceOnly=true`，它只防止建立反向保证金仓位；官方语义允许债务还清后的剩余数量继续作为 SPOT 成交，因此它不是共享账户资产隔离手段。系统必须始终以 managed remaining、确认可售量和原子 base reservation 限量。查询失败或快照过期时对应项 fail closed 并重试；价格不再参与是否继续卖出的判断。随后按 DELIST>SELL 优先级取得 submit slot、重验 version/remaining 并创建 PREPARED，最多 5 项通过 `POST /api/v5/trade/batch-orders` 一次提交。响应按 clOrdId 逐项转换；单项拒绝或缺失不影响已确认的兄弟项。

## 共享账户外部交易

- `FUTURES/SWAP/OPTION` 订单和 fills 全部忽略，不创建任务、不平仓；其风险只通过账户级 `totalEq/adjEq/mgnRatio/max-avail-size` 影响后续 BUY。
- 管理起点之后，配置交易对上已确认的 SPOT/MARGIN BUY fills 都按 `(inst_id,trade_id)` 进入同一种 managed BUY 模型；只用 `source=SYSTEM|ACCOUNT` 区分来源。SYSTEM fill 从 attempt 继承冻结的路由，ACCOUNT fill 根据其已确认订单/instType 分类。使用真实 `fillTime + 该币种 hold_hours` 和 fillSz。ACCOUNT BUY 不创建伪造的 BUY `order_attempt`，也不倒推日限价或准入结果；isolated 或无法确认的 fill fail closed、告警并忽略。
- 外部 BUY 一经纳管会立即计入本策略 exposure；若使本策略达到 3 倍硬线，只触发 BUY HALT/告警，不自动提前卖出。外部 isolated MARGIN、FUTURES/SWAP/OPTION BUY 仍忽略。
- 配置交易对上的 ACCOUNT SELL fill 按 `(inst_id,trade_id)` 先统一保存为 PENDING，不因“当前还没看到 managed BUY”立即判为多余。系统先完成覆盖该 sell `fillTime` 的连续 REST fills 重叠回补，并要求相关 SPOT/MARGIN fills watermarks 的较小值已越过该时间；这样更早发生但更晚到达的 ACCOUNT BUY 会先入账，且不能用一个 instType 的水位代替另一个。若同 base 存在 PREPARED/SUBMITTED/UNKNOWN 系统退出 attempt，继续保持 PENDING。
- 定义 `fill_order_key=(fillTime, numeric billId, tradeId)`。watermark 安全且没有活动系统退出 attempt 后，在同一 account/base 短事务锁内按 ACCOUNT SELL 的 fill_order_key 顺序处理，只向 `BUY fill_order_key <= ACCOUNT SELL fill_order_key` 的最早 managed BUY fills 分配 `min(fillSz, managed remaining)`，增加 `disposed_size`，再把 SELL fill 标记 APPLIED并保存 allocated_size；同毫秒成交不能只比较 fillTime。billId 缺失或非法时保持 PENDING、回补并告警，禁止猜顺序。只有到达连续 watermark 后仍超出 managed remaining 的部分才一次性忽略。任一 PENDING ACCOUNT SELL 会阻止同 base 创建新的 SYSTEM SELL/DELIST attempt，先触发回补和分配，避免外部卖出已经发生却又重复退出；watermark 长时间不健康必须告警。
- ACCOUNT SELL 分配与 `disposed_size/SELL state/version` 在同一事务更新。任何尚未提交的 SELL_WATCH、已锁存 SELL_TRIGGERED 或批次候选在创建 PREPARED 前都必须重读 version 和 remaining：人工已全卖则直接丢弃，不创建 attempt；只卖一部分则仅卖最新 remaining。PREPARED 后、HTTP 发送前再做一次无网络等待的本地/PENDING version guard；期间出现 ACCOUNT SELL 时把受影响 attempt 置 NOT_CREATED 并释放 reservation。若系统订单已经越过 HTTP 发送边界，则不能撤回假定，只按两边真实 fills 对账。
- orders WS 与 REST fills 重叠回看复用 `(inst_id,trade_id)` 去重；若 orders 终态没有 tradeId/fillSz，则等待 REST fill，不按订单 `sz` 或累计 `accFillSz` 推断单笔成交。ACCOUNT SELL 不创建 `order_attempts`、SELL_WATCH 或外部订单状态机。
- 该模型能避免账本重复扣减，但无法阻止“系统订单已经提交到 OKX 后，人工又同时下卖单”在交易所双双成交；共享账户没有资产所有权或跨客户端原子互斥。系统用单 base 在途约束、短 `expTime`、新鲜可售量和 reduce-only `availSell` 缩小窗口，但不能宣称完全消除。若要求绝对隔离，只能使用独立子账户；当前需求接受保守归属和这一极短竞态窗口。

## 结果与恢复

SELL 业务状态只保存 WAITING/SELL_TRIGGERED/SOLD/DUST_PENDING。活动 attempt 通过 `order_attempts.source_buy_trade_id` 查询，不保存反向 `active_attempt_id`；attempt 的 PREPARED/SUBMITTED/UNKNOWN/NOT_CREATED/SETTLED 只存在于统一 `order_attempts`。

- SYSTEM SELL 的 exchange_state=filled 且 attempt=SETTLED：按 tradeId 幂等保存并增加源 BUY fill 的 `disposed_size`；remaining 为零则 SOLD。
- ACCOUNT SELL：连续 fills watermark 安全且无活动系统退出 attempt 时一次性增加符合时间顺序的最早 managed BUY fills 的 `disposed_size` 并记录 `allocated_size`；remaining 为零则 SOLD，不生成系统 SELL attempt。未安全分配前保持 PENDING并阻止同 base 新退出 attempt。
- exchange_state=partially_filled/canceled：保存实际成交；attempt=SETTLED 后，对同一源 fill 的剩余量生成下一 generation。
- UNKNOWN：保留该 attempt 行内的数量 reservation，按 clOrdId/ordId 查询 pending、history、fills 和 orders WS；禁止替代订单。
- NOT_CREATED：恢复 account/instrument；仍可交易则自动重试同一 fill 的新 generation，不重新判断保护价。
- 剩余量低于 `minSz` 或 0.1 USDT：进入 `DUST_PENDING`；每日复核恢复可交易后直接回到 `SELL_TRIGGERED`。
- 原 attempt 已终态且确认该 base 的实际可售余额为零：记录 `BALANCE_UNAVAILABLE`，保留 remaining 和 `SELL_TRIGGERED`，由账户/fill 更新及每日低频复核恢复；余额为零本身不能证明该 fill 已卖出。只有真实 SYSTEM/ACCOUNT SELL fill 的幂等分配使 remaining 归零时才标记 SOLD。
- 重启：先恢复 PREPARED/SUBMITTED/UNKNOWN，再领取新的 SELL_TRIGGERED fill。

同一币种各 fill 独立结束；不存在 position slot 的占用或释放。

## 借款处理

应用不计算借款利息，也不维护 `REPAY_PENDING` 状态。`AUTO_REPAY=false`，不调用主动还款接口；后续 BUY 继续只依赖最新 `totalEq/adjEq`、mgnRatio、本策略 exposure 和 max-avail。OKX 强制还款或清算造成的余额减少由实际可售量自然收敛。

## 退市与账户异常

DELIST 与普通 SELL 共用同一 base 资产的非终态订单约束：

1. 停止领取该 instId 新的普通 SELL fill。
2. 对账当前在途/UNKNOWN SELL attempt；不取消、不抢占已经创建的 attempt。
3. 该 attempt 终态后，按每条 managed fill 的确认 remaining 创建 DELIST attempt；数量仍取 remaining 与确认可售 base 的较小值。
4. 各 fill 分别按真实成交更新，remaining 归零或确认可售量耗尽后结束；不触碰共享账户额外 BASE。

共享账户余额只作为卖出上限，不要求与 managed ledger 相等。实际可售量小于任务 remaining 时记 `BALANCE_SHORTFALL` 并缩单；可售量归零时保持可恢复状态，不创建零数量 attempt。切换前余额和未纳管来源的 BASE 忽略。外部 SPOT/MARGIN SELL 只做上述库存消耗，永续及其他外部对象仍全部忽略。

## 必测不变量

- 三条 BUY tradeId 产生三条独立 sell tasks，不创建 managed_position/group/items。
- 管理起点之后配置交易对的外部已确认 SPOT/MARGIN BUY fill 会创建 managed SELL_WATCH；切换前 BUY、isolated BUY、永续和单纯余额变化不会创建任务。
- 所有 managed BUY 最终均以 `tdMode=cross, reduceOnly=true` 卖出；`reduceOnly` 不替代 managed remaining 和 reservation 数量保护。
- 每条 fill 精确使用入账时冻结的 `fill_ts + hold_hours`；配置更新不改变旧 fill。
- 每次 ticker 更新检查该 instId 所有到期 SELL_WATCH fills；重复/倒序事件不重复触发。
- 命中后锁存；价格反弹、提交失败或 partial 都不会回到价格等待。
- 所有 mutation HTTP 请求严格串行；同一 `(accountId, baseCcy)` 的 UNKNOWN/非终态退出还会阻止该 base 创建替代订单。
- 单 fill 小于 minSz/0.1 USDT 时进入 `DUST_PENDING`，不与其他 fills 聚合；恢复可交易后直接继续退出而不重新等待价格。
- market sell 使用 base `sz`，沿用持久化 `execution_mode` 与 `execution_route`；Margin 路由发送 `reduceOnly=true`，Spot-only 路由省略，不发送 `tgtCcy/slippagePct`。
- partial/UNKNOWN/重启不会重复卖出同一数量。
- ACCOUNT SELL 的 WS/REST 重复事件和重启回看不会重复扣减；所有 ACCOUNT SELL 先 PENDING，等待连续 watermarks 和活动系统退出 attempt 终态后再按顺序分配。测试不得把这解释为能够阻止两个已提交订单在 OKX 同时成交。
- 退市优先领取不会与普通 SELL 重叠，也不会卖出 managed remaining 之外的余额。
- 不计算借款利息，也不主动兑换资产还款。
