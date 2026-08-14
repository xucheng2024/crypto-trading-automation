# 04 Instrument Protection 与退市

本模块只处理配置的 `BASE-USDT` 买入资格和 managed BUY fills 的退出；managed BUY 同时包含系统和管理起点后的 ACCOUNT cross BUY。共享账户其他余额、订单和衍生品仓位不属于本模块；固定 `acctLv=3` 的首版不实现 `cash`/isolated 分支。

## 信号优先级

1. `GET /api/v5/support/announcements?annType=announcements-delistings&page=<n>`：每 5 分钟从 page 1 顺序分页，直到响应为空或最旧 `pTime` 早于最近 24 小时；最多读取 20 页，达到上限仍未越过窗口则告警并在下一轮重试。只处理最近 24 小时且标题包含 spot 的公告，并以边界安全的币种/交易对标题匹配确定影响范围。响应读取 `data[0].details[]` 的 `title/url/pTime`，继续以 `title+pTime` 幂等；公告命中后立即持久化黑名单，再处理 managed fills 退出，不增加 watermark 表。
2. Public instruments WS：`channel=instruments, instType=SPOT` 的 `state != live` 立即冻结该交易对 BUY；`expTime` 新增或提前也可确认逐交易对退市。单独的 `suspend/preopen/test` 不能被误判为已确认退市并强制平仓。
3. Public status WS：`channel=status` 只表示系统维护/中断。匹配生产环境、统一账户和相关 trading service 时，`ongoing/pre_open` 立即全局 BUY HALT；`scheduled` 仅在 `begin` 前配置的 drain window 内停买。不得据此给某个币写退市黑名单或强制平仓。

公告与 `expTime` 任一可信信号都可确认退市并进入 EXITING；instrument `state != live` 只先冻结受影响交易对，status 信号只冻结全局 BUY。公告拉取失败必须告警并重试，不能当作“没有新公告”。

## 处理顺序

对每个确认退市的 `BASE-USDT`：

1. 在内存立即从 BUY 候选索引移除，并将该 instId 已存在但尚未提交 IOC 的 `BUY_WATCH` 终止为 `CANCELLED_DELIST`。
2. PostgreSQL 原子更新唯一 `instrument_protection` 行：`state=EXITING`、reason、expTime、公告元数据和 version；EXITING 天然禁止 BUY。公告幂等沿用现有 `title+pTime` 语义，不依赖接口未提供的公告 ID。
3. 拒绝新的 BUY generation；已排队的 BUY 在创建 PREPARED attempt 前重新检查 protection version，命中时直接丢弃内存意图；PREPARED 创建后、调用 OKX IOC 前再次检查，命中时将 attempt 置为 NOT_CREATED 并释放其 reservation。
4. 停止领取新的普通 SELL，并先对账本系统同 base 的非终态 SELL/DELIST attempt；不取消、不抢占已创建订单。
5. 当前 attempt 终态后，把该 instId 每条未完成 managed fill 直接推进 DELIST 退出，复用逐 fill SELL attempt、reservation、UNKNOWN 和 partial 恢复，不建立全余额清仓模型。
6. 每张 DELIST 单数量为 `min(fill remaining, confirmed available base after system reservations, cross reduce-only availSell)`，按 lotSz 向下取整；共享账户额外 BASE 永不进入计划数量。创建新 attempt 前先处理 watermark 已安全覆盖的 PENDING ACCOUNT SELL；仍未安全覆盖的 PENDING 会阻止该 base 新 DELIST 并触发高优先级回补/告警。
7. 只有 `BASE-USDT` 当前可交易且计划数量大于零时，才通过统一 Order Coordinator 提交 `tdMode=cross, reduceOnly=true` 的 market sell；不寻找备用币对。订单使用 base `sz`，且不发送 `tgtCcy/slippagePct`。`reduceOnly` 不能隔离共享账户现货，数量安全只依赖 managed remaining、确认可售量和原子 reservation。
8. 各 fill 保存真实订单/fills并独立收敛；只有全部 managed remaining 经真实 SYSTEM/ACCOUNT SELL fills 归零后才为 `EXITED`，仅剩低于 0.1 USDT/minSz 的 managed remaining 时为 `DELIST_DUST`。可售余额暂时为零时保持 `EXITING` 并低频复核，不能仅凭余额把任务视为完成。共享账户仍持有未纳管 BASE 不影响终态。不计算借款利息，也不主动还款。
9. 异步补充公告元数据和清理策略配置。

最小单状态：

~~~text
no row -> BLACKLISTED
no row | BLACKLISTED -> EXITING -> EXITED | DELIST_DUST
EXITED | DELIST_DUST -- 新增 managed fill --> EXITING
~~~

`state != live` 不进入该状态机，只存在于 Market Projection；重启通过 instruments REST baseline 重建。D1 active blacklist 导入 BLACKLISTED；首次收到可信 expTime/公告时可以直接从无记录进入 EXITING，不创建无意义的中间 BLACKLISTED 状态。

进入 `EXITING` 前必须先持久化 `instrument_protection`；实际下单前按源 BUY tradeId 原子创建 `order_attempts(intent=DELIST)`，其 base reservation 保存在订单行。Protection 不保存 event/generation 或订单反向引用；活动 DELIST attempt 按 instId/source_buy_trade_id 查询，完整 attempt 生命周期只存在于统一订单账本。

退市不得绕过 Order Coordinator 创建第二套 mutation client。

已确认退市但 `BASE-USDT` 处于 `suspend/preopen/test` 或已下线时保持 EXITING，不循环提交必然失败的订单，也不改走其他币对；监听 instruments 更新，恢复 `live` 后立即继续退出。临近/超过 `expTime` 仍不可交易时持续高优先级告警并保留可恢复状态，不把失败尝试当作已清仓。

## 幂等与恢复

退市业务状态直接保存在 `instrument_protection`，订单生命周期统一使用 `order_attempts`，且不从 D1 导入旧 attempt 记录：

- `(source_buy_trade_id, intent, generation)` 在 DELIST attempts 中唯一；generation 只存在于订单表；
- 每个 attempt 使用 `stableHash("DELIST", instId, sourceBuyTradeId, generation)`；
- attempt 仅持久化 PREPARED、SUBMITTED、UNKNOWN、NOT_CREATED、SETTLED；交易所 filled/partially_filled/canceled/rejected 只作为结果字段；
- UNKNOWN 先查询；
- 重启先恢复非终态 attempt；
- 只有明确未创建、源 fill 仍有 remaining 且仍有可售余额时才进入新 generation。

同一账户和 base 资产只允许一张非终态 SELL/DELIST attempt；该规则由数据库部分唯一约束保证。Reconciliation 只查询并分类结果，所有 attempt 状态转换仍由 Order Coordinator 执行。

## 唯一保护聚合

不再分别维护 blacklist 和 delist event。每个 instId 只有一行 `instrument_protection`：

~~~text
inst_id / base_ccy
state = BLACKLISTED | EXITING | EXITED | DELIST_DUST
reason / instrument_state / exp_time
announcement_title / announcement_p_time / announcement_url
version
first_seen_at / updated_at
~~~

`state != live` 只更新 Market Projection；只有 active blacklist 写 BLACKLISTED，expTime 或公告确认才写 EXITING。D1 active blacklist 导入 BLACKLISTED，除非同时具有可信退市证据。该聚合必须进入内存投影；数据库不可用但内存已收到 instrument freeze 时仍立即停止新 BUY，重启后由 REST baseline 恢复。

## 尘埃

本系统退市 managed remaining 的实际价值小于 0.1 USDT 或低于交易所最小可交易量时：

- 记录一次 DELIST_DUST；
- 不重复提交失败卖单；
- 仍保留黑名单；
- 仍计入本策略 exposure；账户净资产继续使用 OKX `totalEq/adjEq`；
- 若本系统 remaining 与可售量恢复到可交易条件，重新进入退出流程。

## 必测不变量

- instrument state 信号先冻结对应 BUY；公告或 expTime 确认后才强制退出。
- 退市后不能创建新的 BUY_WATCH；已有 BUY_WATCH 和已排队但未提交的 BUY 必须终止，IOC 最终提交前的检查必须拦截旧回调。若 IOC 已先提交，则只对账真实成交并纳入退市退出，不能盲目补单。
- status 维护事件只做全局 BUY HALT，不误建币种黑名单或触发清仓。
- 重复公告/WS 事件不会重复推进 protection version 或创建清仓 attempt。
- 普通 sell attempt 与退市清仓不会重叠数量。
- 共享账户其他普通/algo 挂单和仓位被忽略，退市流程既不接管也不撤销。
- UNKNOWN 退市订单不会盲重发。
- 数据库短暂不可用时内存 BUY freeze 仍生效。
- 尘埃退市持仓不会持续制造日志和订单噪音。
- 已确认退市但不可交易时不会循环提交 market order，恢复 live 后继续退出。
- 共享账户总余额不决定终态；只按 managed remaining、实际成交和可售上限收敛。
