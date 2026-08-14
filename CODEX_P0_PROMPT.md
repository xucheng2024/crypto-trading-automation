# Codex P0 执行指令

在当前仓库只执行 `docs/design/07-implementation-plan.md` 的 P0/T0“基线与安全封口”。完成 P0 验收后立即停止，不开始 P1，不实现 BUY/SELL/DELIST 新逻辑。

## 必读

依次完整阅读：

1. 根目录 `AGENTS.md`（若存在）；
2. `AZURE_WS_TRADING_DESIGN.md`；
3. `docs/design/01-architecture-runtime.md`；
4. `docs/design/05-persistence-recovery.md`；
5. `docs/design/07-implementation-plan.md` 的 P0、T0、验证方式和完成交付；
6. `CODEX_AZURE_REFACTOR_PROMPT.md`；
7. 当前 `src/`、`migrations/`、`tests-worker/`、`tests/`、`package.json`、`wrangler.toml` 和 `.github/workflows/`（若存在）。

## 开始前

1. 查看 `git status --short`，把现有修改和未跟踪文件视为用户工作，不覆盖、不清理、不回退；尤其不要修改与 P0 无关的 README、JSON 数据或设计内容。
2. 记录 Node/npm/Python 版本和当前可用测试命令。
3. 运行现有基线：至少 `npm test`、`npm run check`；若 Python 测试依赖可用，再运行 `python -m pytest tests`。失败时先判断是既有失败、缺依赖还是本次回归，保存原始命令和结论。
4. 不使用真实 Trade API、不部署 Cloudflare/Azure、不修改远端资源或账户，不创建 commit/push/PR。

## P0 工作

### 1. 建立 mutation 基线清单

搜索 JS、Python、workflow、cron 和配置中的所有 OKX 写操作，包括但不限于 place/amend/cancel order、algo/trigger、repay/borrow、account setting。生成 `docs/audit/P0_BASELINE.md`，每个入口记录：

- 文件和函数；
- REST/WS 方法与 endpoint；
- BUY/SELL/DELIST/维护分类；
- 触发来源（HTTP、cron、queue、启动恢复等）；
- 当前重试/超时/幂等方式；
- 使用的 API key/config；
- 后续归入 Order Coordinator、仅用于切换清理或应删除。

同时记录现有测试命令、结果和已知失败。该文件只保存审计事实，不复制策略需求。

### 2. 增加最小安全契约

只为新的 Azure 路径增加：

- runtime-validated `TRADING_MODE=OFF|EXIT_ONLY|FULL`，缺省必须为 `OFF`，非法值启动失败；
- 可注入 Clock，业务代码不得直接依赖不可控当前时间；
- `OwnerGuard` 与内存 `RECOVERING|READY` 状态契约；P0 默认 OwnerGuard 不持有 owner，不能假装 PostgreSQL lock 成功；
- 一个统一、纯本地的 mutation authorization guard：
  - `OFF` 拒绝全部新 mutation；
  - `EXIT_ONLY` 只允许 SELL/DELIST；
  - `FULL` 仍要求 owner held、READY=true 和对应依赖满足；
- guard 返回稳定 reason code，调用者不能绕过。

不要在 P0 接 PostgreSQL、实现 advisory lock SQL、创建 schema、实现 WS、Order Coordinator、batch order 或新策略。不要改变 legacy Cloudflare 当前生产路径；新安全契约应能被后续 Azure entrypoint 使用。

### 3. 测试

增加最小单元/架构测试，至少证明：

- 缺省模式是 OFF；
- 非法模式 fail fast；
- OFF 拒绝 BUY/SELL/DELIST；
- EXIT_ONLY 拒绝 BUY，允许满足 owner/READY 条件的 SELL/DELIST；
- FULL 在 owner 缺失或 READY=false 时仍拒绝；
- 没有模块能通过新增 Azure mutation port 绕过 guard；
- legacy 基线测试没有因 P0 改动而改变。

测试不得发网络请求。

## P0 验收与停止条件

结束前运行全部适用测试和 dry-run，检查 `git diff --check`。只有同时满足以下条件才报告 P0 已通过：

- mutation 清单有代码证据且无已知遗漏；
- legacy 基线无本次回归；
- 新 Azure 路径默认不能发送真实订单；
- config/Clock/OwnerGuard/READY/authorization guard 测试通过；
- 没有进入 P1 范围，没有真实外部写操作。

最终只报告：P0 状态（已通过或阻塞）、修改文件、测试命令与结果、发现的 mutation 入口摘要、未验证项、P1 风险。不要继续实施 P1。
