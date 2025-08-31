# 🚀 Cloudflare Workers Cron 部署指南

## 概述

使用 Cloudflare Workers Cron 替代 GitHub Actions 的 schedule 功能，提供更精确的分钟级定时触发。

## 🎯 优势

- ✅ **分钟级精确**: 比 GitHub Actions 的 schedule 更稳定
- ✅ **免费额度**: 每天 100,000 次调用配额
- ✅ **边缘网络**: 全球边缘节点，延迟极低
- ✅ **简单部署**: 几行代码即可实现

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
  # 每5分钟执行一次，避开整点时间
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  # 每天23:54 - 取消待处理触发器
  "54 23 * * *",
  # 每天00:06 - 创建算法触发器
  "6 0 * * *"
]
```

### 时间表

| 频率 | 时间 | 说明 |
|------|------|------|
| **每5分钟** | 02, 07, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57分 | 避开整点，错峰执行 |
| **每天夜间** | 23:54 | 取消待处理触发器 |
| **每天早晨** | 00:06 | 创建算法触发器 |

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
    - cron: '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'
    - cron: '54 23 * * *'
    - cron: '6 0 * * *'
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
- **你的需求**: 每5分钟 × 24小时 × 2个夜间任务 = 290次/天
- **剩余**: 99,710 次/天

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

### 调试命令

```bash
# 查看 Worker 状态
wrangler whoami

# 查看部署状态
wrangler deployments list

# 查看环境变量
wrangler secret list
```

## 📞 支持

如果遇到问题，可以：
1. 查看 Cloudflare Workers 文档
2. 检查 GitHub Actions 日志
3. 查看 Worker 执行日志
