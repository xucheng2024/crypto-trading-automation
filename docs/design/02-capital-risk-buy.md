# 02 资金与买入

> 历史版本曾维护一套内部杠杆/权益准入模型（`totalEq/adjEq` 冻结目标、`BUY_ADMISSION_LEVERAGE=2.95`、`MAX_STRATEGY_EFFECTIVE_LEVERAGE=3` 等）。提交 `c854fe8`「Use OKX capacity for buy admission」已将其整体移除；下述内容描述当前实现。

## 账户快照：仅作为新鲜度门控

`AccountCapitalSnapshot`（`src/application/trading-engine.js`）仍订阅 account/balance WS 并保留 `totalEq/adjEq`，但只用于两件事：

- 校验快照本身有效（`totalEq>0 且 adjEq>0` 才接受更新，否则整条更新被丢弃）；
- 提供 `account.fresh(ACCOUNT_MAX_AGE_MS)`（默认 5000ms）给 READY 门控和每次 `_buyGuard` 使用。

`totalEq/adjEq` 的具体数值不再参与任何资金规划、杠杆计算或订单 sizing；应用不维护 `managed_fill_remaining_exposure_usd`、`strategy_effective_leverage`、冻结目标资金等概念，也不再区分 SYSTEM/ACCOUNT managed fill 的 exposure 归属。只在启动、相关 Private WS 重连、过期或矛盾时用 REST 恢复账户数据；Public/Business 重连不触发无关的全账户查询。

## 买入容量：OKX max-avail-size 是唯一权威来源

不设杠杆上限、不设账户级 exposure 预算、不设持仓币种数量上限、不设每轮冻结目标资金。每一批候选 BUY intent 在 `OrderCoordinator.prepareBuys()`（`src/application/order-coordinator.js`）中：

1. 按 `executionMode`（固定为 `cross`）与 `capacityCcy`（路由的报价币种，通常为 USDT）分组；
2. 对每一组调用一次 `GET /api/v5/account/max-avail-size`（margin 路由带 `ccy`），取回 `availBuy`；
3. `availBuy<=0` 的 instId 记录 `intent.waitForRiskVersion = 当前 account.version`，暂缓提交，直到账户风险快照产生新版本号才重新尝试（`INSUFFICIENT_FUNDS_WAIT_RISK_VERSION`）；
4. `availBuy>0` 的 instId 带着这个数值进入 `submitBuys()`。

`submitBuys()` 中按此计算下单量（`TRADE_FEE_RATE=0.0005` 仍是代码常量，作为手续费缓冲；不从 OKX fee tier 动态同步，也不按 feeCcy 分摊）：

~~~text
executionPrice = roundToStep(dailyLimitPrice, tickSz, down)
maxNotional = availBuy
size = roundToStep(maxNotional / (executionPrice * (1 + TRADE_FEE_RATE)), lotSz, down)
~~~

`size < minSz` 时该 intent 以 `MINIMUM_SIZE` 拒绝，不重试更小路由。Margin 路由的 `availBuy` 已反映自有 USDT、自动借贷额度和 OKX 风控；Spot-only 路由只反映自有资金；两者不互相兜底。

启动和 BUY 前必须确认：

- API 域名和账户注册实体匹配；
- Cross Margin/account level 可用，`autoLoan=true`（`GET /api/v5/account/config` 确认；系统不自动修改账户设置）；
- account/risk/instrument/quote 快照新鲜；
- instrument 为 live，系统无交易维护；
- 订单时点 `max-avail-size.availBuy` 足以覆盖 minSz 对应的最小下单成本；不维护独立借贷流动性状态；
- 开启新 BUY 轮次前，当前 instId 没有本策略非尘埃 managed fill、活动 BUY generation 或未释放 BUY reservation（见 §BUY_WATCH）。

任何必要字段缺失、快照不新鲜或 `max-avail-size` 请求失败（`MAX_AVAIL_FAILED`）时该批候选直接跳过，不猜测容量。SELL 和 DELIST 不受 BUY 容量检查影响，且在同一 drain 周期中优先于 BUY（见 §BUY_WATCH 命中条件 2）。

系统不调用、缓存或对账 `GET /api/v5/account/max-loan`：它不参与 BUY 准入，也不能替代订单时点的 `max-avail-size.availBuy`、风险快照和原子 reservation。

## Daily limit

每日按新加坡交易日计算固定 daily_limit_price。Trading Engine 在首个 BUY 判断时 single-flight 获取日 K 线并写入不可变缓存；之后正常 BUY 热路径不再请求日 K 线。

精确定义：

~~~text
strategy_day = date(exchange_time, Asia/Singapore)
skip_for_yesterday_gain = yesterday_close * 10 > yesterday_open * 11
raw_limit_price = today_open * best_limit / 100
daily_limit_price = roundToStep(raw_limit_price, tickSz, down)
~~~

`skip_for_yesterday_gain=true` 时把当日 cache 明确写为 `SKIPPED_YESTERDAY_GAIN`，该 instId 当天不进入 BUY_WATCH、不创建 BUY attempt；严格大于 10% 才跳过，恰好 10% 不跳过，次日重新计算。

`GET /api/v5/market/candles?instId=<instId>&bar=1D` 返回数组 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]` 且通常按时间倒序。按时间戳选择新加坡当日 K 的 `o` 作为 `today_open`，该 K 在日内通常为 `confirm=0`；其前一交易日 K 必须 `confirm=1`，再读取 `o/c`。目标 o/c 必须是正数 Decimal；缺失、零或非法时重试并 BUY HALT，不能靠数组固定下标或沿用前一天 today_open。strategy_day 使用最近一次可信 OKX server-time offset 计算；校时过期、跳变超阈值或新日 cache 尚未生成时 BUY HALT，禁止沿用前一天 limit。`daily_limit_cache(inst_id, strategy_day)` 唯一且 first-writer-wins，同时保存输入 K 线时间、价格、best_limit、tickSz、配置版本、skip 状态和计算哈希；当天已存在的有效记录不得因配置变化或并发补算被覆盖。

daily_limit_price 当天固定，不因 3m K 线、当前价格或 IOC 结果改变。

instrument 的 tickSz 日内可能变化。缓存的 daily_limit_price 不改写；每张新 attempt 使用 `execution_limit_price=roundToStep(daily_limit_price,current_tickSz,down)`，并以该价格执行 askPx 检查、数量计算和 payload；结果必须为正且满足当前规则，否则 BUY HALT。若 PREPARED 后 tickSz/version 改变，旧 attempt 置 NOT_CREATED，再按最新规则和新的市场观察创建 generation；禁止用已经失效的 tickSz 下单。

## BUY_WATCH

状态：

~~~text
OUTSIDE
  -> BUY_WATCH
  -> BUYING
BUYING -> BUY_WATCH | RISK_HALTED | TARGET_FILLED | CANCELLED | ERROR
RISK_HALTED -> BUY_WATCH
~~~

BUY_WATCH 是纯内存状态，重启后由最新 ticker、candle 和 daily limit 重新计算；当天是否已有持仓/进行中的 BUY attempt（用于判定是否允许下一 generation）从已有 BUY attempts 和 managed fills 直接查询恢复，不建立独立 buy_cycles 表，也不缓存任何资金额度。attempt 生命周期只存在于统一订单账本。

Ticker 规则：

1. last <= daily_limit_price：进入或保持 BUY_WATCH。
2. last > daily_limit_price：立即退出；该 ticker 不得买入。
3. 读取最近一根 `confirm=1` 的 OKX 原生 3m candle high。
4. 触发条件为下列两条之一（满足其一即可,`buySignal()`/`src/domain/rules.js`）：
   - **BREAKOUT**：`last > previous_closed_high * 1.003`；严格大于,相等不触发。
   - **DIP**：`last <= daily_limit_price * 0.94`（相对当日限价再跌至少 6%）；**仅允许触发当日首个 BUY generation（`generation === 0`）**——同一 instId 当天一旦进入 generation 1+，只有 BREAKOUT 能继续买入,DIP 不再生效,避免下跌途中反复加仓。两条件同时成立时 BREAKOUT 优先。
5. 同一新鲜 quote 必须满足 askPx <= execution_limit_price。
6. 不满足第 5 条时不得调用 max-avail-size，也不得提交必然零成交的 IOC。
7. DIP 只改变"是否触发买入"，不影响成交价格上限（仍是 `execution_limit_price`）、下单量计算或 `max-avail-size` 风控。

进入或保持 `BUY_WATCH` 的前提是 instId 仍为 `live` 且不存在 active protection（BLACKLISTED/EXITING/EXITED/DELIST_DUST）。该条件在 watch 事件处理、创建 reservation 前和最终提交 IOC 前均检查；任一点失效都终止本次 BUY。已经提交的 IOC 不在此路径撤销，只按实际结果对账。

命中条件后：

1. 校验 quote/candle/daily/instrument/protection 状态，把不含数量的 BUY 意图放入内存优先级队列（`OrderCoordinator.pending.BUY`，按 instId 去重，同一 instId 只保留最新意图）；排队阶段不请求或缓存 max-avail。
2. Order Coordinator 按 `(generation, eligible_since, instId)` 排序，立即选当前最多 5 个候选；不等待凑批。这个只读准备阶段不占不可抢占的 mutation submit slot，并逐项重新校验 TRADING_MODE=FULL、owner lock、READY、account freshness、clock freshness、quote/candle freshness、instrument/protection 和 buySignal（即完整 `_buyGuard`）。
3. 对仍合格项按 `(executionMode, capacityCcy)` 分组，各组调用一次 `GET /api/v5/account/max-avail-size`；调用前冻结每个交易对的 `execution_route`，刷新不能改变当前批次。Margin 路由的 `availBuy` 已反映自有 USDT、自动借贷额度和 OKX 风控，Spot-only 路由只反映自有资金；返回零或下单失败都不会用另一条路由重试，也不会用计划资金或杠杆空间去限制它——`availBuy` 就是当前订单允许消耗的全部报价币种资金。`availBuy<=0` 的 instId 记录当前 `account.version` 并暂缓，直到该版本号前进才重新尝试。每项响应的 `availBuy` 是 quote currency（本策略为 USDT），除以 `(1+TRADE_FEE_RATE) * execution_limit_price` 再按 lotSz 向下取整得到 base `sz`；不能把 `availBuy` 直接当 base 数量。
4. max-avail 返回后才申请 mutation submit slot；若此时出现 DELIST/SELL，BUY 释放申请并回队列，不能挡住退出。取得 slot 后在同一短事务内对每个候选再次执行完整 `_buyGuard`（含 askPx 相对 execution_limit_price 的检查、`MINIMUM_SIZE` 检查），逐个调用 `orders.reserveBuy()`（Postgres advisory lock + 唯一约束）原子创建 BUY `PREPARED` attempt，最多 5 个。被拒绝的候选只记录 block 原因，不重试当前批次；下一轮 drain 时如仍满足信号会重新排队。每个 attempt 写入 `decision_quote_ts/decision_quote_hash`、`decision_candle_ts/decision_candle_hash`、`decision_market_key`、`execution_limit_price`、`instrument_version`、`hold_hours/max_hold_hours`、`strategy_config_hash`、`account_snapshot_version`（数据库层 `order_attempts_buy_decision_evidence_ck` 约束强制这些字段全部非空）。
5. 事务结束后重新校验 TRADING_MODE=FULL、owner lock、READY、当前最新的新鲜 quote/account risk 和 instrument/protection；quote version 变新本身不导致失败，只要 last/askPx/3m 条件仍成立即可立即提交。若已不安全或 instrument/config 被移除，将 PREPARED 置为 NOT_CREATED 并原子释放 reservation。

同一 `instId + strategy_day` 不维护累计消费预算或冻结目标；每个 generation 的下单量都由当时最新的 `max-avail-size.availBuy` 独立决定。后续 SYSTEM/ACCOUNT SELL 不影响下一次 BUY 的容量计算，容量完全交给 OKX 实时判断，避免买卖循环。跨日后才回补到的 SYSTEM BUY fill 仍按其 BUY attempt 的旧 strategy_day 和配置归属，不能计入新一天。

`decision_market_key = hash(quote.ts,last,askPx,bidPx,previous_closed_candle_ts,closed_candle_hash)`。同一 instId 最多一条 pending BUY 意图，只保留最新市场投影。除首次 generation 外，新 attempt 必须满足 quote/candle 时间不倒退且 decision_market_key 与上一 generation 不同；因此同毫秒但价格不同的 ticker、新 ticker、新 closed 3m candle 或同 ts 的 candle 修正都可触发重新判断，完全重复/倒序事件不能重发。closed candle 到达或被修正时也用最新新鲜 quote 重评，避免 ticker 先到、candle 后到造成漏判。IOC 在途或集中限频器等待期间到达的事件全部合并，attempt 原子结算后直接用最新且已变化的 market key 重新判断。只要仍是同一 strategy_day、信号与全部准入条件成立且当时的 `availBuy` 换算出的下单量不低于 minSz，就可串行创建下一 generation；不设置额外 cooldown，也不并发提交。

首版不调用 `order-precheck`。它不能替代实际下单时的新鲜 quote、max-avail、账户风险和最终 OKX 校验，却会引入“每个部署/配置版本首单”的额外状态；相同 payload 契约由 fake transport、只读账户预检和首单正常 UNKNOWN/失败处理覆盖。

订单固定为：

~~~text
instId=<enabled SPOT instrument, e.g. BTC-USDT>
tdMode=cross
side=buy
ordType=ioc
px=execution_limit_price
sz=<按 lotSz 向下取整的 base currency 数量>
clOrdId=<版本前缀 + inst_id/strategy_day/generation 的稳定哈希>
tag=<固定 STRATEGY_TAG>
~~~

通过 REST `POST /api/v5/trade/batch-orders` 下单，每批 1 至 5 项且有 1 项也立即发送；`expTime=<短有效期的毫秒时间戳>` 放在 HTTP request header，不放进 JSON body。SPOT/MARGIN 不发送 `posSide`；本账户 profile 也不发送仅适用于 Futures mode cross MARGIN 的订单字段 `ccy`。`sz` 对 SPOT/MARGIN limit/IOC 买单始终是 base currency。启动时分别使用 `GET /api/v5/account/instruments?instType=SPOT` 和 `instType=MARGIN`：SPOT 必须 live；MARGIN live 且 `tradeQuoteCcyList` 允许 USDT 时分类为 `margin`，否则分类为 `spot`。所有新单仍固定 `tdMode=cross`；Margin 路由在需要时发送 `tradeQuoteCcy=USDT`，Spot-only 路由省略。`clOrdId` 必须是不超过 32 字符的大小写字母/数字组合，`tag` 不超过 16 字符且同样只用字母数字；二者用于共享账户中的策略所有权，不是 telemetry correlation ID。

autoLoan 是账户级配置，不是普通下单字段。启动和后台刷新通过 account config 确认 autoLoan=true；系统不自动修改账户设置。OKX Auto Borrow 会先使用现有 USDT，不足部分自动借入，不能强制“有 USDT 也先借”。

系统不调用、缓存或对账 `GET /api/v5/account/max-loan`：它不参与 BUY 准入，也不能替代订单时点的 `max-avail-size.availBuy`、风险快照和原子 reservation。

## IOC 结果

- 全部或部分成交：保存每个 tradeId 并转入 managed fill；只要当前 `availBuy` 换算出的下单量仍不低于 minSz，上一 attempt 原子结算后由非重复且不倒退的合格 `decision_market_key` 创建下一 generation。
- 零成交：该 generation 原子结算并释放 reservation；只有非重复且不倒退的新 `decision_market_key` 合格时才能创建下一 generation。
- 结果未知：保留 reservation，按 clOrdId/ordId 查询。
- NOT_CREATED：原子释放 reservation；只有 decision_market_key 或导致失败的 account/instrument/config/protection version 已变化时才允许新 generation。相同 payload hash、相同依赖版本和相同 OKX sCode/reason 不得循环重试。
- 信号、行情新鲜度、额度或风险暂时失效：暂停提交并回到观察；同一 strategy_day 内后续更新恢复合格时继续原轮次。
- 本次 `availBuy` 对应下单量低于交易所最小值（`MINIMUM_SIZE`）、strategy_day 结束、交易对从部署配置移除、进入 instrument protection 或出现其他轮次/非尘埃 ACCOUNT managed fill：结束本轮；已产生的 managed fills 仍保留 SELL/DELIST 管理。

NOT_CREATED，或 exchange terminal 且 fills 完整后，在原子结算事务中释放未成交 reservation；实际成交数量转入 managed fill（`insertFill`）。仅观察到交易所终态但 fills 未补齐时不能提前释放。

同 instId 最多一个 IOC 在途（`ACTIVE_BUY_ATTEMPT` 门控）。不同币种可以并行完成只读检查，但账户 reservation 必须通过 `pg_advisory_xact_lock` 原子完成，确保同一 clOrdId/业务键只被创建一次。

## 大面积下跌与持续下跌

- BTC 和大量币同时触发时，不平均切碎资金：`drainOnce()` 每轮固定取当前最多 5 个 BUY 候选（`generation -> eligible_since -> instId` 排序），逐个查询各自路由的 `max-avail-size` 并独立 sizing；不存在共享的账户级 exposure 预算，也不预先按币种分配份额。资金不足的候选记录 `waitForRiskVersion` 并保留观察，待账户风险快照产生新版本号后重新参与。
- generation 0 永远排在任何 generation 1+ 前，避免某个币的连续 IOC 抢占所有提交机会；这只提供一次公平的排队顺序，不承诺为每个币预留资金。
- 买入后价格不再严格高于 `previous_closed_high * 1.003` 时，不满足突破条件，暂停该币后续 IOC，不在下跌途中自动摊平。之后出现新的合格突破市场投影（`decision_market_key` 变化）时可以继续下一 generation；每个 generation 的下单量都由当时最新的 `availBuy` 独立决定，不存在"用完即止"的固定目标。
- 多币下跌使账户可用资金枯竭时，OKX `max-avail-size` 会自然把 `availBuy` 收敛到 0，新 BUY 因而自动 fail closed，不需要本地重算杠杆；已成交仓位仍按各自 sell_time/保护价管理，SELL/DELIST 不被 BUY 容量不足阻塞。
- 若人工先买入系统此前零成交或尚未买到的配置币种，非尘埃 ACCOUNT cross BUY fill 立即纳管并终止该 instId 当前 SYSTEM BUY 轮次（`STRATEGY_POSITION_EXISTS`）；若系统 IOC 已发出则只对账其结果，两边真实 fills 都纳管，但不再创建下一 generation。处于 EXITING/BLACKLISTED 的币则直接进入退出路径，不重新进入正常持有。

## 必测不变量

- ticker 等于 daily limit 时仍必须严格满足 `last > previous_closed_high * 1.003`。
- askPx 大于 limit 时不调用下单专用 REST（`ASK_ABOVE_LIMIT` 在 max-avail 之前已经过滤）。
- 完全重复/倒序 ticker+candle 不产生新 generation；同毫秒但 payload 不同的 ticker 或新 closed candle 可以重评。IOC 在途或限频等待时只合并保留最新市场投影，上一 attempt 原子结算后才允许串行创建下一 generation。
- IOC 部分成交累计不超过该 attempt 的 `plannedSize`（由下单时的 `availBuy` 决定，不是账户级预算的一部分）。
- 同一 BUY 轮次可在同一根 closed 3m candle 内连续 IOC；最新信号/风控失效时暂停，当天恢复后继续，每次都重新查询 `availBuy`。
- 两个币种并发候选各自独立查询 `max-avail-size`，不共享或预留同一份容量数字（是否真的有钱由 OKX 在下单时判定）。
- BUY fill 与其未成交 reservation 在转换期间不会对同一数量重复计入 managed fill。
- attempt 的 SETTLED、真实 fills、reservation 转换/释放在同一事务完成；崩溃不能暴露"已结算但 fills 尚未计入"的窗口。
- 迟到 fill 始终归原 BUY attempt 的 strategy_day，不计入新一天。
- 共享账户可已有余额、负债、订单和仓位；它们不会进入本策略 ledger，也不会阻塞 READY。
- 外部活动降低账户可用资金时，下一次 `max-avail-size` 查询自然反映出更小的 `availBuy`，BUY 随之缩单或 fail closed，无需本地重算。
- autoLoan 只校验账户配置，不出现在 order payload。
- max-avail `availBuy` 按 quote currency 处理，按 `TRADE_FEE_RATE=0.0005` 留量后计算 base `sz`。
- REST `expTime` 只在 header；MARGIN IOC 不发送 `posSide` 或 Futures-mode-only `ccy`。
- stale/缺失风险数据或 `max-avail-size` 请求失败时 fail closed，不猜测容量。
- mutation 超时后不会盲目重发。
- account `totalEq/adjEq` 缺失或异常时该次 account 更新被丢弃，进而使 `account.fresh()` 过期触发 NOT_READY；`totalEq/adjEq` 的数值本身不再参与容量计算。
- 每个 BUY attempt 必须携带完整决策证据字段（quote/candle hash、执行价、hold_hours、config hash、account snapshot version），由 `order_attempts_buy_decision_evidence_ck` 约束强制。
- 并发 BUY 判断通过数据库原子写入，确保同一交易日只产生一个不可变 daily limit。
