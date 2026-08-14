# 02 资金、杠杆与买入

## 资金口径

计划资金来自最新内存 AccountCapitalSnapshot：

~~~text
unlevered_net_asset_value_usd = OKX totalEq
adjusted_net_equity_usd = min(totalEq, adjEq)
~~~

`totalEq` 是 OKX 已按 USD 汇总且已反映负债的账户净权益。例：130 USDT + 价值 20 USDT 且没有对应借款的 crypto，`totalEq=150`；借 100 USDT 再买入价值 100 USDT 的币不会把净权益虚增为 250。

要求：

- 不使用固定 OKX_ORDER_SIZE=100 作为整轮买入资金。
- 快照由 account/balance WS 增量更新，以 `totalEq/adjEq` 为共享账户净资产事实值；应用不保存或拆算币种级手续费、借款本金和利息。本策略 exposure 使用全部 managed BUY fills（SYSTEM 及管理起点后的 ACCOUNT）未卖完部分和新鲜 `bidPx` 做保守估值。
- 只在启动、相关 Private WS 重连、过期或矛盾时用 REST 恢复账户数据；Public/Business 重连不触发无关的全账户查询。
- 不再自行执行“资产减负债”或手续费/利息累计公式，避免与 OKX `totalEq/adjEq` 重复计算。
- 0.1 USDT 以下尘埃仍参与净资产和风险计算。
- 首次满足 BUY 信号并创建 generation 0 时冻结本轮目标资金；同一 `instId + strategy_day` 的后续 IOC generation 只消耗剩余目标，风险预算下降时可缩单，不能扩大目标。

每个新币种本轮的冻结目标资金默认直接等于进入首次风险评估时 OKX `totalEq` 的可信正值（例如 130 USDT + 价值 20 USDT crypto = 150 USDT），再按 execution_limit_price/lotSz 换算 base size；`totalEq<=0` 或无效时不创建轮次。不设置持仓币种数量上限；本次 max-avail 或剩余 BUY 准入空间更小时必须缩单。

## 三倍硬限制

~~~text
AUTO_LOAN_REQUIRED=true
TRADE_FEE_RATE=0.0005
MAX_CONFIGURED_LEVERAGE=3
MAX_STRATEGY_EFFECTIVE_LEVERAGE=3
BUY_ADMISSION_LEVERAGE=2.95
MIN_MARGIN_RATIO=1
~~~

`MAX_STRATEGY_EFFECTIVE_LEVERAGE=3` 是本策略运行时硬停止线；`BUY_ADMISSION_LEVERAGE=2.95` 是订单准入线，用于吸收手续费、取整和快照到提交之间的小幅变化。它不代表共享账户总杠杆；账户级安全继续依赖 OKX 的新鲜 `mgnRatio`、`adjEq` 和订单时点 `max-avail-size`。

`TRADE_FEE_RATE=0.0005` 是代码常量而非可调运行配置，不从 OKX fee tier 动态同步，也不按 feeCcy 分摊。BUY 资金规划使用 `estimated_order_cost = order_notional * (1 + TRADE_FEE_RATE)`；SELL 只用相同费率估算成本，不影响 base 下单数量。实际账户变化继续以 OKX `totalEq/adjEq` 和余额为准。借款利息不单独计算或预测。

首版固定 `ACCOUNT_MODE=MULTI_CURRENCY`。启动读取 `GET /api/v5/account/config` 并严格要求 `acctLv=3`；不匹配则保持 NOT_READY，不自动切换账户模式，也不实现 Portfolio Margin 分支。

通过 `GET /api/v5/account/leverage-info?ccy=USDT&mgnMode=cross` 读取币种级配置杠杆并要求 `lever <= 3`；本策略 effective leverage 作为独立门控。

~~~text
strategy_committed_exposure_usd
  = managed_fill_remaining_exposure_usd
  + system_unfilled_or_reserved_buy_exposure_usd

strategy_effective_leverage
  = strategy_committed_exposure_usd / adjusted_net_equity_usd

remaining_leverage_capacity
  = BUY_ADMISSION_LEVERAGE * adjusted_net_equity_usd
  - strategy_committed_exposure_usd
~~~

adjusted_net_equity_usd 直接取 OKX `totalEq` 与 `adjEq` 的较小可信值；二者差异超过配置容差时先恢复快照并 BUY HALT，不能选择更乐观的一方。

`managed_fill_remaining_exposure_usd` 统计管理起点之后配置交易对的所有 cross/cash SPOT/MARGIN BUY fills，其 remaining 为 `fill_size-disposed_size`，按新鲜 `bidPx` 保守估值，包括尘埃。SYSTEM/ACCOUNT SELL 都增加同一个 `disposed_size`。切换前余额和 FUTURES/SWAP/OPTION fills 不进入本策略 exposure；不接受 isolated fill。

`system_unfilled_or_reserved_buy_exposure_usd` 只统计本系统尚未转成 managed fill 的 BUY 未成交/reservation。BUY fill 到账时，同量 reservation 转入 managed fill exposure，任何时刻同一数量只计一次。

如果 adjusted_net_equity_usd <= 0，或任一必要估值无法确定，直接 BUY HALT，不能计算或放行杠杆。

候选新增订单成本取以下最小值，反推 order_notional 和 base `sz`：

- 本轮剩余计划资金；
- 本次订单专用 max-avail-size；
- remaining_leverage_capacity；
- instrument/lot/min 规则允许值。

启动和 BUY 前必须确认：

- API 域名和账户注册实体匹配；
- Cross Margin/account level 可用；
- autoLoan=true；
- 相关 scope 配置杠杆不超过 3；
- 订单时点 `max-avail-size.availBuy` 足以覆盖可用资金与可借额度；不维护独立借贷流动性状态；
- account/risk/instrument/quote 快照新鲜；
- instrument 为 live，系统无交易维护；
- `mmr=0` 时允许 `mgnRatio` 为空；`mmr>0` 时必须 `mgnRatio>1`。首版不再增加未定义的业务缓冲值。
- 开启新 BUY 轮次前，当前 instId 没有本策略非尘埃 managed fill、活动 BUY generation 或未释放 BUY reservation；同一轮已产生的 SYSTEM managed fills 不阻止该轮继续消耗冻结目标，但其他轮次或 ACCOUNT managed fill 会停止后续 IOC。共享账户同币种其他未纳管余额不参与该判断。

任何必要字段缺失、借款失败、账户风险不安全、本策略杠杆达到 3 或候选预计杠杆超过 BUY 准入线时停止本次 BUY。SELL 和 DELIST 不受 BUY HALT 阻止。

本策略 managed fills 使用新鲜 bidPx 估值；尘埃 fill 同样进入本策略 exposure，不存在持仓名额判断。

3 倍是本策略运行时硬停止线，2.95 是默认订单准入不变量。共享账户其他活动不归本策略管理；若它们降低 `adjEq/mgnRatio/max-avail-size`，本系统自然停止或缩小 BUY。

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

daily_limit_price 当天固定，不因 5m K 线、当前价格或 IOC 结果改变。

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

BUY_WATCH 是纯内存状态，重启后由最新 ticker、candle 和 daily limit 重新计算；当天未完成 BUY 轮次的冻结目标从已有 BUY attempts 恢复并按真实 fills 重算剩余量，不建立独立 buy_cycles 表。attempt 生命周期只存在于统一订单账本。

Ticker 规则：

1. last <= daily_limit_price：进入或保持 BUY_WATCH。
2. last > daily_limit_price：立即退出；该 ticker 不得买入。
3. 读取最近一根 confirm=1 的 5m candle open。
4. 只有 last > previous_closed_open 才满足回升条件。
5. 同一新鲜 quote 必须满足 askPx <= execution_limit_price。
6. 不满足第 5 条时不得调用 max-avail-size，也不得提交必然零成交的 IOC。

进入或保持 `BUY_WATCH` 的前提是 instId 仍为 `live` 且不存在 active protection（BLACKLISTED/EXITING/EXITED/DELIST_DUST）。该条件在 watch 事件处理、创建 exposure reservation 前和最终提交 IOC 前均检查；任一点失效都终止本次 BUY。已经提交的 IOC 不在此路径撤销，只按实际结果对账。

命中条件后：

1. 校验 AccountCapitalSnapshot 和 instrument version，把不含数量的 BUY 意图放入内存优先级队列；排队阶段不请求或缓存 max-avail。
2. Order Coordinator 按 `(generation, eligible_since, instId)` 立即选当前最多 5 个不同 instId；不等待凑批。这个只读准备阶段不占不可抢占的 mutation submit slot，并逐项重新校验 READY、quote、account risk freshness、instrument/protection 和业务状态。
3. 对仍合格项按 `execution_mode` 分组，并行调用最多一次 cross 和一次 cash `GET /api/v5/account/max-avail-size`；Multi-currency cross MARGIN 不传 `ccy`。每项响应的 `availBuy` 是 quote currency（本策略为 USDT），先与计划资金和剩余杠杆空间取最小值，再除以 `1.0005 * execution_limit_price` 得到 base `sz`；不能把 `availBuy` 直接当 base 数量。
4. max-avail 返回后才申请 mutation submit slot；若此时出现 DELIST/SELL，BUY 释放申请并回队列，不能挡住退出。取得 slot 后在同一短事务内取得 account-scoped transaction advisory lock，重新汇总 active BUY reservations，并按上述确定顺序逐项扣减剩余杠杆容量、创建最多 5 个唯一 BUY `PREPARED` attempt。容量不足的后续项不创建 attempt，保持 RISK_HALTED 等待账户状态变化。每个 attempt 写入 exposure reservation、本轮 `strategy_day`、generation、首次 generation 冻结的目标资金、`decision_quote_ts`、规范化 quote payload hash、`decision_candle_ts/candle_hash`、instrument version/execution_limit_price、hold_hours/config hash 和本次准入使用的 equity/exposure/version 摘要。后续 generation 继承同一冻结目标。
5. 事务结束后重新校验 TRADING_MODE=FULL、owner lock、READY、当前最新的新鲜 quote/account risk 和 instrument/protection；quote version 变新本身不导致失败，只要 last/askPx/5m 条件仍成立即可立即提交。若已不安全或 instrument/config 被移除，将 PREPARED 置为 NOT_CREATED 并原子释放 reservation。

本轮已消费资金只按该轮 SYSTEM BUY fills 计算：`sum(fillSz * fillPx * 1.0005)`；剩余目标为首次冻结目标减去该值，活动 attempt 的 reservation 另行占用，不能重复使用。后续 SYSTEM/ACCOUNT SELL 只改变 managed remaining，不返还或重新打开本轮 BUY 预算，避免买卖循环。跨日后才回补到的 SYSTEM BUY fill 仍按其 BUY attempt 的旧 strategy_day、冻结目标和配置归属，不能计入新一天。

`decision_market_key = hash(quote.ts,last,askPx,bidPx,previous_closed_candle_ts,closed_candle_hash)`。同一 instId 最多一条 pending BUY 意图，只保留最新市场投影。除首次 generation 外，新 attempt 必须满足 quote/candle 时间不倒退且 decision_market_key 与上一 generation 不同；因此同毫秒但价格不同的 ticker、新 ticker、新 closed 5m candle或同 ts 的 candle 修正都可触发重新判断，完全重复/倒序事件不能重发。closed candle 到达或被修正时也用最新新鲜 quote 重评，避免 ticker 先到、candle 后到造成漏判。IOC 在途或集中限频器等待期间到达的事件全部合并，attempt 原子结算后直接用最新且已变化的 market key 重新判断。只要仍是同一 strategy_day、信号与全部准入条件成立且剩余目标不低于最小下单量，就可串行创建下一 generation；不设置额外 cooldown，也不并发提交。

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

通过 REST `POST /api/v5/trade/batch-orders` 下单，每批 1 至 5 项且有 1 项也立即发送；`expTime=<短有效期的毫秒时间戳>` 放在 HTTP request header，不放进 JSON body。SPOT/MARGIN 不发送 `posSide`；本账户 profile 也不发送仅适用于 Futures mode cross MARGIN 的订单字段 `ccy`。`sz` 对 SPOT/MARGIN limit/IOC 买单始终是 base currency。启动时分别使用 `GET /api/v5/account/instruments?instType=SPOT` 和 `instType=MARGIN` 交叉校验每个交易对对当前账户/实体可做 cross MARGIN，并读取 `tradeQuoteCcyList`：列表包含 USDT 时固定发送 `tradeQuoteCcy=USDT`；列表为空时省略；列表非空但不含 USDT 时保持 NOT_READY。`clOrdId` 必须是不超过 32 字符的大小写字母/数字组合，`tag` 不超过 16 字符且同样只用字母数字；二者用于共享账户中的策略所有权，不是 telemetry correlation ID。

autoLoan 是账户级配置，不是普通下单字段。启动和后台刷新通过 account config 确认 autoLoan=true；系统不自动修改账户设置。OKX Auto Borrow 会先使用现有 USDT，不足部分自动借入，不能强制“有 USDT 也先借”。

系统不调用、缓存或对账 `GET /api/v5/account/max-loan`：它不参与 BUY 准入，也不能替代订单时点的 `max-avail-size.availBuy`、风险快照和原子 reservation。

## IOC 结果

- 全部或部分成交：保存每个 tradeId，按实际成交额扣减本轮目标；仍有可下单剩余量时，上一 attempt 原子结算后由非重复且不倒退的合格 `decision_market_key` 创建下一 generation。
- 零成交：该 generation 原子结算并释放 reservation；只有非重复且不倒退的新 `decision_market_key` 合格时才能创建下一 generation。
- 结果未知：保留 reservation，按 clOrdId/ordId 查询。
- NOT_CREATED：原子释放 reservation；只有 decision_market_key 或导致失败的 account/instrument/config/protection version 已变化时才允许新 generation。相同 payload hash、相同依赖版本和相同 OKX sCode/reason 不得循环重试。
- 信号、行情新鲜度、额度或风险暂时失效：暂停提交并回到观察；同一 strategy_day 内后续更新恢复合格时继续原轮次。
- 本轮剩余目标低于交易所最小值、strategy_day 结束、交易对从部署配置移除、进入 instrument protection 或出现其他轮次/非尘埃 ACCOUNT managed fill：结束本轮；已产生的 managed fills 仍保留 SELL/DELIST 管理。

NOT_CREATED，或 exchange terminal 且 fills 完整后，在原子结算事务中释放未成交 reservation；实际成交数量转入 managed fill exposure。仅观察到交易所终态但 fills 未补齐时不能提前释放。

同 instId 最多一个 IOC 在途。不同币种可以并行完成只读检查，但账户 reservation 必须原子，确保合计预计杠杆不超过 BUY 准入线。

## 大面积下跌与持续下跌

- BTC 和大量币同时触发时，不平均切碎资金，也不突破 2.95 准入线。系统按 `generation -> 首次合格时间 -> instId` 确定顺序，使用原子 reservation 尽可能投入可用容量；资金不足的候选保留观察，待容量或账户状态变化后重评。因为单币冻结目标接近当时权益，2.95 上限通常只容纳约 2 至 3 个完整目标，这是风险上限的必然结果，不伪装成“所有币都能买到”。
- generation 0 永远排在任何 generation 1+ 前，避免某个币的连续 IOC 抢占所有提交机会；这只提供一次公平尝试，不承诺为每个币预留资金。
- 买入后价格继续下跌且 `last <= previous_closed_open` 时，不满足回升条件，暂停该币后续 IOC，不在下跌途中自动摊平。之后出现新的合格回升市场投影时，只能继续首次冻结目标的剩余部分；目标用完后不因再跌而追加。
- 多币下跌使 `adjEq/mgnRatio/max-avail-size` 恶化时，所有新 BUY 立即 fail closed；已成交仓位仍按各自 sell_time/保护价管理，SELL/DELIST 不被 BUY halt 阻塞。
- 若人工先买入系统此前零成交或尚未买到的配置币种，非尘埃 ACCOUNT cross BUY fill 立即纳管并终止该 instId 当前 SYSTEM BUY 轮次；若系统 IOC 已发出则只对账其结果，两边真实 fills 都纳管，但不再创建下一 generation。处于 EXITING/BLACKLISTED 的币则直接进入退出路径，不重新进入正常持有。

## 必测不变量

- 130 + 20 = 150；固定费用只用于 0.05% 留量，借款利息不建模，净值直接采用 OKX `totalEq/adjEq`。
- totalEq 已反映负债时不重复扣减；adjEq 更低时使用更保守分母。
- ticker 等于 limit 时仍需要 last > previous_closed_open。
- askPx 大于 limit 时不调用下单专用 REST。
- 完全重复/倒序 ticker+candle 不产生新 generation；同毫秒但 payload 不同的 ticker或新 closed candle 可以重评。IOC 在途或限频等待时只合并保留最新市场投影，上一 attempt 原子结算后才允许串行创建下一 generation。
- IOC 部分成交累计不超过冻结计划量。
- 同一 BUY 轮次可在同一根 closed 5m candle 内连续 IOC；最新信号/风控失效时暂停，当天恢复后继续，累计不超过冻结目标。
- 两个币种并发候选无法重复使用同一杠杆空间。
- BUY fill 与其未成交 reservation 在转换期间不会对同一数量重复计算 exposure。
- attempt 的 SETTLED、真实 fills、reservation 转换/释放在同一事务完成；崩溃不能暴露“已结算但 fills 尚未计入”的窗口。
- ACCOUNT/SYSTEM SELL 不返还当日 BUY 预算；迟到 fill 始终归原 BUY strategy_day。
- 共享账户可已有余额、负债、订单和仓位；它们不会进入本策略 ledger，也不会阻塞 READY。
- 外部活动降低账户风险或额度时，BUY 由 `adjEq/mgnRatio/max-avail-size` fail closed 或缩单。
- autoLoan 只校验账户配置，不出现在 order payload。
- max-avail `availBuy` 按 quote currency 处理，按固定 0.05% 费用留量后计算 base `sz`。
- REST `expTime` 只在 header；MARGIN IOC 不发送 `posSide` 或 Futures-mode-only `ccy`。
- stale/缺失风险数据 fail closed。
- mutation 超时后不会盲目重发。
- account totalEq/adjEq 缺失或异常时 BUY HALT；应用不使用币种级负债重算净值。
- 并发 BUY 判断通过数据库原子写入，确保同一交易日只产生一个不可变 daily limit。
