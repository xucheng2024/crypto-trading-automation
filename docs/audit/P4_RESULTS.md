# P4 results

## Status

**通过（2026-08-14）**。经 operator 明确授权，Azure Bicep build、resource-group validate、what-if 与真实账户 GET-only preflight 均已通过。P5 仍未授权，未部署 Container Apps、PostgreSQL、ACR、NAT 或交易 mutation。

外部验收证据：

- Azure CLI 2.89.1 / Bicep 0.46.1 warning-free build；Azure validate 返回 `Succeeded`。
- 初始 what-if 为 37 个 `Create`、无修改/删除；P4 Key Vault 创建后为 36 个 `Create` + 1 个既有 Vault `Deploy`、无删除。
- D1 只读查询确认 26 个 active blacklist；153 个 limit 配置排除 7 个重合项后启用 146 个交易对，配置 hash 为 `cacb9fcac8928a2230374fc0cee0228c12f1cef2f9b9a6d14e5d42b5ad390a8c`。
- `crp4e24c-kv` 启用 RBAC、purge protection 与 90 天 soft delete；真实 preflight 从 Vault 取值，依次通过 public time、account config、SPOT/MARGIN instruments、BTC-USDT cross leverage 与 system status。
- Operator 明确接受现有 OKX Key 具有 Trade、无 Withdraw 权限的例外；本次 runner 仍由代码强制为 GET-only，未调用任何 mutation。该例外不得被描述为凭据本身只读。

## Delivered

- OFF 不再跳过运行时：仍执行 migration gate、owner/recovery、认证只读 REST baseline 与三路 WS 观察；所有 mutation 继续被模式门禁拒绝。Baseline 校验 server time/status、账户 profile、SPOT/MARGIN 资格、leverage、balance、ticker 与全部标的；失败会释放 owner，且不会留下半启动 WS。
- Azure SDK 依赖已安装。单个 `ManagedIdentityCredential` 是 Key Vault 与 Entra PostgreSQL 的身份来源；拒绝内联 OKX/PostgreSQL secret 与含密码的 PostgreSQL URL。
- Bounded Engine work loop 串行消费关键事件与唯一 Coordinator。退出数量以 managed remaining 和实时 reduce-only `availSell` 双重封顶；ACCOUNT fill 以显式 `managedFillStartMs` 和版本化 strategy artifact 纳管，缺少币种 hold 配置时 fail closed。
- Engine-only announcement、常规 reconcile、weekly reconcile timers 串行、防重入并在 shutdown 时先停止；无凭据 Maintenance Job 保持隔离。
- Maintenance 有真实 Entra adapter。临时 PostgreSQL 证明其角色只能执行有界 `SECURITY DEFINER` retention function，不能直接写订单表。
- Node 22、non-root、不可变 digest 候选镜像排除用户 JSON、`.env`、Git 与 D1 legacy runtime；未 push。
- 模块化 Bicep 包含 VNet/NAT、Container Apps、Job、ACR、Key Vault、Entra-only PostgreSQL database、RBAC、预算、Application Insights daily cap、70/90% ingestion alerts 与业务告警。Engine/Maintenance 使用不同 identity 和最小输入。
- 离线 D1 converter/importer 支持 schema/content hash、事务、回滚、重放与临时 PostgreSQL restart；只导入 active protection，用户源 JSON 未修改。
- Replay matrix 已移除 trivial in-memory registry。每行指向 `test:p4-replay` 实际执行的测试；最强路径在同一临时 PostgreSQL 内运行 production composition、三路 fake OKX WS、fake REST baseline/max-avail/submit、真实五单 Coordinator transaction、50 标的 coalescing、exit preemption 与 SLO 断言。
- Runbook 覆盖 identity bootstrap、immutable digest、OFF rollout、strategy/managed-start 输入、回退与 P5 授权门。

## Verification

本地候选原始结果：`npm test` 130 passed；`npm run test:postgres` 24 passed；`python3.11 -m pytest tests` 29 passed；`npm run test:p4` 22 passed；`npm run test:p4-replay` 76 passed；`npm run test:p4-slo` 3 passed。外部验收修复后再次确认 `npm test` 130 passed、`npm run test:p4` 22 passed、GET 参数回归 31 passed、Bicep warning-free build、Azure validate/what-if 与 `git diff --check` 全部通过。

未执行 Docker push、Container Apps/PostgreSQL/ACR/NAT 部署或任何 OKX mutation。唯一创建的 Azure workload resource 是 P4 凭据落点 Key Vault；provider registration、RBAC 和 GET-only preflight 已完成。

## External gate and P5 risk

P4 已通过。P5 仍需要新的显式授权，才能 push 镜像、部署 OFF、处理旧调度器/API key/pending ownership、启用 `FULL` 或进行真实 mutation。
