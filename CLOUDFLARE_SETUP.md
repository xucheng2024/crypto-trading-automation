# 🚀 Cloudflare Workers Cron 部署指南

## 概述

使用 Cloudflare Workers Cron 替代 GitHub Actions 的 schedule 功能，提供更精确的分钟级定时触发。

## 🎯 优势

- ✅ **分钟级精确**: 比 GitHub Actions 的 schedule 更稳定
- ✅ **免费额度**: 每天 100,000 次调用配额
- ✅ **边缘网络**: 全球边缘节点，延迟极低
- ✅ **简单部署**: 几行代码即可实现
- ✅ **智能分组**: 根据频率执行不同的脚本组合

## 📋 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 GitHub Token

1. 访问 [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. 生成新 token，需要 `repo` 权限
3. 复制 token

### 4. 设置环境变量

```bash
# 设置 GitHub Token
wrangler secret put GITHUB_TOKEN
# 输入你的 GitHub Token

# 设置其他环境变量
wrangler secret put GITHUB_OWNER
wrangler secret put GITHUB_REPO
```

### 5. 部署 Worker

```bash
# 部署到生产环境
wrangler deploy --env production

# 或部署到测试环境
wrangler deploy --env staging
```

## 🔧 配置说明

### Cron 表达式

```toml
[triggers]
crons = [
  # 每5分钟执行: monitor_delist + cancel_pending_limits + fetch_filled_orders
  "*/5 * * * *",
  # 每15分钟执行: auto_sell_orders
  "*/15 * * * *",
  # 每天23:55 - 取消待处理触发器
  "55 23 * * *",
  # 每天00:05 - 创建算法触发器
  "5 0 * * *"
]
```

### 执行策略

| 频率 | 时间 | 脚本组合 | 说明 |
|------|------|----------|------|
| **每5分钟** | 01, 06, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56分 | `monitor_delist.py` + `cancel_pending_limits.py` + `fetch_filled_orders.py` | 实时监控、成交同步和 trigger 保护 |
| **每15分钟** | 00, 15, 30, 45分 | `auto_sell_orders.py` | 自动卖出 |
| **每天夜间** | 23:55 | `cancel_pending_triggers.py` | 取消待处理触发器 |
| **每天早晨** | 00:05 | `create_algo_triggers.py` | 创建算法触发器 |

### 智能分组逻辑

- **5分钟间隔**: 执行监控、成交同步和 trigger 保护相关脚本
- **15分钟间隔**: 执行自动卖出脚本
- **夜间任务**: 系统维护和清理
- **早晨任务**: 系统初始化和重建

## 🧪 测试

### 手动触发

```bash
# POST 请求手动触发
curl -X POST https://your-worker.your-subdomain.workers.dev/

# 或访问网页查看状态
curl https://your-worker.your-subdomain.workers.dev/
```

### 查看日志

```bash
# 查看实时日志
wrangler tail --env production

# 查看特定环境的日志
wrangler tail --env staging
```

## 🔒 安全配置

### 环境变量

- `GITHUB_TOKEN`: GitHub 个人访问令牌
- `GITHUB_OWNER`: GitHub 用户名
- `GITHUB_REPO`: GitHub 仓库名

### 权限要求

GitHub Token 需要以下权限：
- `repo` - 访问私有仓库
- `workflow` - 触发 GitHub Actions

## 📊 监控

### 成功指标

- ✅ HTTP 200 响应
- ✅ GitHub Actions 被成功触发
- ✅ 日志显示成功信息
- ✅ 正确的脚本组合被执行

### 错误处理

- ❌ HTTP 4xx/5xx 响应
- ❌ GitHub API 错误
- ❌ 网络连接失败

## 🚀 迁移步骤

### 1. 部署 Cloudflare Worker

按照上述步骤部署 Worker

### 2. 测试触发

手动测试确保能正确触发 GitHub Actions

### 3. 移除 GitHub Actions Schedule

在 `.github/workflows/trading.yml` 中移除：

```yaml
# 移除这部分
on:
  schedule:
    - cron: '*/5 * * * *'
    - cron: '*/15 * * * *'
    - cron: '55 23 * * *'
    - cron: '5 0 * * *'
```

### 4. 保留手动触发

```yaml
on:
  workflow_dispatch:  # 手动触发
  repository_dispatch: # Cloudflare Worker 触发
    types: [cron]
```

## 💰 成本分析

### 免费计划

- **每日调用**: 100,000 次
- **你的需求**: 
  - 每5分钟 × 24小时 = 288次/天
  - 每15分钟 × 24小时 = 96次/天
  - 夜间任务 × 2 = 2次/天
  - **总计**: 386次/天
- **剩余**: 99,614 次/天 ✅

### 付费计划

如果需要更高配额，可以考虑付费计划。

## 🔍 故障排除

### 常见问题

1. **GitHub Actions 未触发**
   - 检查 GitHub Token 权限
   - 验证仓库名称和所有者

2. **Cron 未执行**
   - 检查 wrangler.toml 配置
   - 验证 cron 表达式格式

3. **网络错误**
   - 检查 Cloudflare Worker 状态
   - 验证网络连接

4. **脚本组合错误**
   - 检查 Worker 日志
   - 验证 cron 频率判断逻辑

### 调试命令

```bash
# 查看 Worker 状态
wrangler whoami

# 查看部署状态
wrangler deployments list

# 查看环境变量
wrangler secret list

# 查看实时日志
wrangler tail --env production
```

## 📞 支持

如果遇到问题，可以：
1. 查看 Cloudflare Workers 文档
2. 检查 GitHub Actions 日志
3. 查看 Worker 执行日志
4. 验证 cron 触发逻辑
