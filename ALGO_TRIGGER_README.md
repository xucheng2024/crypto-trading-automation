# OKX Algo Trigger Order Creator

这个脚本会读取 `limits.json` 文件，获取所有加密货币对和它们的最佳限制系数，然后创建 OKX 的 algo trigger 订单。

## 功能

- 📊 读取 `limits.json` 中的所有加密货币配置
- 🎯 获取每个币种的当日开盘价
- ⚡ 计算触发价格：`开盘价 * limit系数 / 100`
- 📝 创建 OKX algo trigger 订单

## 使用方法

### 1. 设置环境变量

创建 `.env` 文件并填入你的 OKX API 凭据：

```bash
# OKX Production API (交易必需)
OKX_API_KEY=your_production_api_key_here
OKX_SECRET_KEY=your_production_secret_key_here
OKX_PASSPHRASE=your_production_passphrase_here
```

### 2. 安装依赖

```bash
pip install requests python-dotenv
```

### 3. 运行脚本

```bash
python create_algo_triggers.py
```

## 脚本逻辑

1. **读取配置**: 从 `limits.json` 读取所有加密货币对和 `best_limit` 值
2. **获取开盘价**: 调用 OKX API 获取每个币种的当日开盘价
3. **计算触发价**: `触发价格 = 开盘价 × limit系数 ÷ 100`
4. **创建订单**: 为每个币种创建 algo trigger 订单

## 订单参数

- **订单类型**: `conditional` (条件订单)
- **交易模式**: `cash` (现货)
- **方向**: `buy` (买入)
- **数量**: `0.001` (默认，可调整)
- **触发价格**: 根据 limit 系数计算
- **止盈模式**: `partial` (部分止盈)
- **止盈比例**: `50%`

## 注意事项

⚠️ **重要提醒**:
- 这是实盘交易脚本，请确保 API 凭据正确
- 脚本会为 limits.json 中的每个币种创建订单
- 默认订单数量为 0.001，请根据你的资金情况调整
- 建议先在测试环境验证

## 输出示例

```
🚀 OKX Algo Trigger Order Creator
============================================================
📋 Found 29 crypto pairs in limits.json
============================================================

🔄 Processing BTC-USDT...
📊 BTC-USDT daily open price: 43250.5
🎯 BTC-USDT trigger price: 40655.47 (limit: 94)
✅ Successfully created algo trigger order for BTC-USDT
   Order ID: 123456789

🔄 Processing ETH-USDT...
📊 ETH-USDT daily open price: 2650.8
🎯 ETH-USDT trigger price: 2385.72 (limit: 90)
✅ Successfully created algo trigger order for ETH-USDT
   Order ID: 123456790

============================================================
📊 Summary: 29/29 orders created successfully
```

## 错误处理

脚本包含完整的错误处理：
- API 凭据验证
- 网络请求重试
- 订单创建状态检查
- 详细的日志输出

## 自定义

你可以修改脚本中的以下参数：
- 订单数量 (`sz`)
- 止盈比例 (`tpSlVal`)
- 请求间隔时间 (rate limiting)
- 订单类型和参数
