# Codex P1 执行指令

在当前仓库持续完成 `docs/design/07-implementation-plan.md` 的 P1“交易基础设施”，仅包含 T1–T3。按 P1-A 至 P1-D 顺序执行，阶段验收全部通过后立即停止；不要开始 P2，不实现运行时交易队列、Order Coordinator 或真实 BUY/SELL/DELIST。

## 必读与边界

开始前完整阅读根目录 `AGENTS.md`（若存在）、`CODEX_AZURE_REFACTOR_PROMPT.md`、`AZURE_WS_TRADING_DESIGN.md`、`docs/design/01-architecture-runtime.md` 至 `07-implementation-plan.md`，以及 P0 的 `docs/audit/P0_BASELINE.md` 和 `src/azure/`。

- 先检查 `git status --short`；现有修改和未跟踪文件均视为用户工作，不清理、不回退、不覆盖无关内容。
- 先复跑 P0 基线：`npm test`、`npm run check`、`python3.11 -m pytest tests`、`git diff --check`。若失败，先定位并报告，不带着未知回归继续。
- 全程不连接真实 OKX、不使用 OKX 模拟盘、不部署 Cloudflare/Azure、不修改远端数据库或账户、不创建 commit/push/PR。
- 新 Azure 路径始终保持 `TRADING_MODE=OFF`。所有 REST/WS 测试使用 fake transport/fake socket 或录制并脱敏的 fixture。
- 可以增加完成 P1 所需的最小运行依赖和测试脚本并更新 lockfile；禁止引入框架、ORM、Service Bus、Redis、generic repository、第二套 Decimal 或 D1 runtime adapter。
- P1 可以定义并测试 mutation transport，但不能把它接到真实凭证、P0 `AzureMutationPort` 或任何生产入口。

## P1-A：T1 纯领域规则

建立文档 07 规定的 `src/domain/` 边界，复用现有 `src/decimal.js`，不要重新实现金额类型。提取并统一：

1. Decimal、价格/数量 step rounding，所有关键金额禁止 JavaScript Number；
2. instrument normalization：`instId/base/quote/tickSz/lotSz/minSz/state/expTime`；
3. order contract：仅允许 `PREPARED|SUBMITTED|UNKNOWN|NOT_CREATED|SETTLED`，生成不超过 32 位字母数字的版本化 clOrdId，canonical tuple 使用至少 128-bit SHA-256 截断 Base32，并生成 payload hash；
4. daily limit、capital/leverage、BUY、逐 fill SELL 和 DELIST 的纯函数；输入必须显式包含 Clock 时间、市场/账户/instrument/config 版本，不读环境、网络或数据库；
5. `best_duration` 只接受 schema 明确的 `nH/nD` 或由源 schema 明确声明单位的旧值，输出正数 `hold_hours`，禁止猜单位。

补 deterministic 单元/性质边界测试，覆盖 Decimal、tick/lot/min、+10% 边界、UTC+8 strategy day、2.95/3.0 风险边界、回升/ask 过滤、SELL 保护价和 DELIST 数量上限。重构 legacy 重复实现时保持现有行为和测试不变，不改变任何 legacy mutation 语义。

P1-A 验收：domain 不导入 OKX、Azure、Cloudflare、数据库、环境变量或系统时间；不存在第二套金额/订单状态实现；全部相关单元测试通过。

## P1-B：T2 PostgreSQL、owner 与离线迁移

### Schema

新增版本化 PostgreSQL migrations，严格实现文档 05 的最小表：

- `daily_limit_cache`；
- `filled_orders`；
- `instrument_protection`；
- `order_attempts`；
- `sync_watermarks`。

实现文档列出的 enum/check/唯一与 partial unique 约束，包括：fill tradeId 幂等、clOrdId 唯一、BUY generation 唯一、同 instId 单一 active BUY、source fill generation 唯一、同 source/base 单一 active SELL/DELIST、BUY/退出 reservation 字段互斥、disposed/allocated 范围。禁止增加 `system_control`、`crypto_limits`、`buy_cycles`、managed position、sell group/items、activeAttemptId、持久化 remaining、fee/interest/debt 或运行时配置表。

### Repository 与事务

- 只实现 `TradingStateRepository` 和 `OrderRepository` 两个运行时 repository；application 持有 transaction，repository 不自行 commit、不调用网络。
- 使用参数化 SQL、Decimal/numeric 字符串、CAS 和短事务。
- 提供 account-scoped 与 account/base transaction advisory lock 原语，用真实 PostgreSQL 并发测试证明 reservation/active attempt 约束。
- 实现专用连接持有的 PostgreSQL session advisory owner，并接入 P0 `OwnerGuard` 契约；连接丢失立即表现为 owner not held。P1 不实现 RECOVERING baseline 或自动进入 READY。

### 集成测试环境

本机已有 PostgreSQL 14 的 `postgres/psql/initdb/pg_ctl` 和 Docker。优先用 `mktemp -d` 创建临时本地 cluster、随机可用端口，测试结束可靠停止并删除临时目录；也可使用显式测试容器。不得启动或修改用户的持久 PostgreSQL 服务，不使用宽泛删除命令。提供可重复的一条测试命令。

集成测试至少覆盖：

- migrations 从空库成功且重复执行策略明确；
- 两个并发 BUY 不能复用同一 exposure 容量；
- 同 instId 不能有两个 active BUY；
- 同 base 不能有重叠 SELL/DELIST；
- tradeId、clOrdId、generation 幂等；
- CAS 失败不覆盖新版本；
- reservation 与 attempt 同事务提交/回滚；
- session owner lock 互斥并在连接终止后释放；
- 数据库不可用时不能产生“已授权提交 mutation”的结果。

### 一次性离线转换

实现离线 JSON 工具和 fixtures：active blacklist 转为 `instrument_protection=BLACKLISTED` 导入数据；旧 limit 转为只含版本化部署所需的 `best_limit/hold_hours` 配置。工具必须 schema 校验、生成内容 hash、幂等、拒绝未知 duration 单位；不迁移 daily cache、orders/fills，不连接 D1，不进入生产 runtime。

P1-B 验收：真实临时 PostgreSQL 集成测试全部通过；schema 与禁止字段有自动检查；两个 repository 边界清楚；真实 owner guard fail-closed；离线转换测试通过。

## P1-C：T3 OKX transport 与三类 WebSocket

### REST transport

在 `src/infrastructure/okx/` 建立唯一 transport：

- 实体域名 profile、server time/clock skew、签名、request timeout、`expTime` header、集中限频和 `Retry-After`；
- 只读 GET 可按规则重试；任何 mutation 越过发送边界后禁止通用重试，异常返回 UNKNOWN observation；
- 同时检查顶层 `code` 和逐项 `sCode`，batch 响应按 clOrdId 分类，不能因单项失败回滚兄弟项；
- 实现设计中所需的只读 endpoint、单次 batch mutation contract 和按 clOrdId/ordId 查询 contract，但不连接真实凭证或 runtime；
- account instruments 校验、`tradeQuoteCcyList`、`acctLv=3`、autoLoan、cross profile、fills 缺少 tdMode 时按 ordId 联查的解析/分类必须有纯 fixture 测试；不扫描 positions/pending algo，不实现 cash/isolated/Portfolio 分支。

P0 的“Azure 模块无 mutation bypass”架构测试需要随结构升级：只允许指定 OKX infrastructure transport 包含 endpoint/签名/HTTP/socket 代码，domain/application/entrypoint 仍不得直接出现 OKX mutation 或绕过 P0 authorization guard。不要简单删除该测试。

### WebSocket

实现 Public、Private、Business 三类 client 及共享的最小 connection primitives：

- login/subscribe ack、ping/pong、idle detection、带抖动退避、64008 主动重连；
- connection generation、connected/baseline/freshness；同 generation 时间不倒退，旧 generation 丢弃；
- Public：tickers/instruments/status；Private：account/balance_and_position/orders(ANY)；Business：启用和退出相关交易对的 candle5m，仅 `confirm=1`；
- client 只输出规范化 observation/event，不拥有 READY、订单状态转换或交易策略；socket callback 不等待数据库/REST/日志。

使用 fake socket 与录制脱敏 fixtures 覆盖登录失败、订阅确认、断线、乱序、同时间修正、旧 generation、64008、重连和 stale。测试不得访问公网。

P1-C 验收：所有 HTTP/WS 测试完全离线；GET retry 与 mutation no-retry 有明确断言；三类 WS 恢复范围和 generation 行为正确；没有真实 mutation wiring。

## P1-D：阶段集成与验收

1. 运行全部 JS、Python、PostgreSQL integration、fake REST/WS、migration、offline converter 测试；运行 `npm run check` 和 `git diff --check`。
2. 增加 `docs/audit/P1_RESULTS.md`，只记录实现文件、测试命令/结果、schema/transport/WS 覆盖证据、未验证项和 P2 风险，不复制需求正文。
3. 反查依赖边界：domain 纯净；Azure runtime 不导入 legacy `src/db.js`；生产代码不包含 D1 runtime；只有 OKX infrastructure 能发 HTTP/WS；P0 guard 仍全部通过。
4. 确认没有真实网络写、部署、账户修改或 P2 实现。

只有以下全部满足才能报告 P1“已通过”：

- P0 全部测试继续通过；
- domain deterministic tests 通过且无外部依赖；
- PostgreSQL 真实并发/owner/migration 测试通过；
- fake OKX REST/WS 的超时、限频、乱序、断线和 UNKNOWN 测试通过；
- D1 离线转换可重复且没有 runtime D1 依赖；
- 新 Azure 路径仍默认 OFF，未接入真实 mutation；
- 没有进入 P2。

最终仅报告：P1 状态（已通过或阻塞）、各子阶段交付、修改文件、全部测试命令与结果、未验证项、P2 风险。达到验收门后立即停止，不继续实现 P2。
