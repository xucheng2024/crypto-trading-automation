# P4 results

## Status

**阻塞**。本地候选已收敛，但 P4 验收门尚未通过：缺少经授权的 Azure Bicep build/validate/what-if 与真实 OKX 账户只读 preflight。P5 未进入，也没有访问外部服务。

仅存 blocker：

- 本机没有 Azure CLI/Bicep CLI；静态检查不能替代 provider schema 编译与 Azure validate/what-if。
- 未获得真实 Azure subscription/resource group、Entra principal、Key Vault/PostgreSQL 与真实 OKX 只读授权；没有运行真实账户 preflight。

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

最终结果：`npm test` 130 passed；`npm run test:postgres` 24 passed；`python3.11 -m pytest tests` 29 passed；`npm run test:p4` 22 passed；`npm run test:p4-replay` 76 passed；`npm run test:p4-slo` 3 passed。`npm run check` dry-run、container static、migration/import rehearsal、offline read-only preflight、`npm audit --omit=dev`（0 vulnerabilities）与 `git diff --check` 全部通过。

`test:iac` 必须明确输出 `BICEP_CLI_UNAVAILABLE`，不能被记录为已编译。未执行 Docker push、部署、真实 Azure/Key Vault/OKX/远端 PostgreSQL 请求。

## External gate and P5 risk

P4 只能在获得单独授权后运行 Azure build/validate/what-if 与真实 OKX GET-only preflight；两者通过前保持“阻塞”，不能标记“已通过”。P5 还需要新的显式授权，才能部署、处理旧调度器/API key/pending ownership、启用 `FULL` 或进行真实 mutation。
