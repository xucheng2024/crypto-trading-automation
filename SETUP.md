# 环境变量配置指南

## 必需的环境变量

### 1. Neon PostgreSQL 数据库
```bash
export DATABASE_URL="postgresql://neondb_owner:npg_F4epMLXJ8ity@ep-wispy-smoke-a1qg30ip-pooler.ap-southeast-1.aws.neon.tech/crypto_trading?sslmode=require&channel_binding=require"
```

### 2. OKX API 凭证
```bash
export OKX_API_KEY="your_okx_api_key"
export OKX_SECRET_KEY="your_okx_secret_key"
export OKX_PASSPHRASE="your_okx_passphrase"
```

### 3. OKX 交易环境
```bash
export OKX_TESTNET="false"  # false=实盘, true=模拟盘
```

## 本地测试

### 1. 设置环境变量
```bash
# 复制上面的环境变量，替换为你的实际值
export DATABASE_URL="your_neon_connection_string"
export OKX_API_KEY="your_api_key"
export OKX_SECRET_KEY="your_secret_key"
export OKX_PASSPHRASE="your_passphrase"
export OKX_TESTNET="false"
```

### 2. 测试数据库连接
```bash
python -c "from lib.database import Database; db = Database(); db.connect(); db.create_tables(); db.disconnect()"
```

### 3. 测试完整系统
```bash
python monitor_delist.py
python fetch_filled_orders.py
python auto_sell_orders.py
```

## GitHub Actions 配置

在 GitHub 仓库的 Settings > Secrets and variables > Actions 中添加：

- `DATABASE_URL`: 你的 Neon 连接字符串
- `OKX_API_KEY`: 你的 OKX API 密钥
- `OKX_SECRET_KEY`: 你的 OKX 密钥
- `OKX_PASSPHRASE`: 你的 OKX 密码

## 注意事项

1. **不要提交 .env 文件**到 Git
2. **DATABASE_URL 必须**以 `postgresql://` 开头
3. **所有环境变量都是必需的**
4. **本地开发**需要设置环境变量
5. **GitHub Actions**会自动从 Secrets 读取
