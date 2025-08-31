# OKX Algo Trigger Order Creator

This script reads the `limits.json` file to get all cryptocurrency pairs and their optimal limit coefficients, then creates OKX algo trigger orders (2 trigger points per cryptocurrency).

## Features

- 📊 Read all cryptocurrency configurations from `limits.json`
- 🎯 Get daily opening price for each cryptocurrency
- ⚡ Calculate trigger price: `opening price * limit coefficient / 100`
- 📝 Create OKX algo trigger orders

## Usage

### 1. Set Environment Variables

Create a `.env` file and fill in your OKX API credentials:

```bash
# OKX Production API (required for trading)
OKX_API_KEY=your_production_api_key_here
OKX_SECRET_KEY=your_production_secret_key_here
OKX_PASSPHRASE=your_production_passphrase_here
```

### 2. Install Dependencies

```bash
pip install requests python-dotenv
```

### 3. Run Script

```bash
python create_algo_triggers.py
```

## Script Logic

1. **Read Configuration**: Read all cryptocurrency pairs and `best_limit` values from `limits.json`
2. **Get Opening Price**: Call OKX API to get daily opening price for each cryptocurrency
3. **Calculate Trigger Price**: `Trigger Price = Opening Price × Limit Coefficient ÷ 100`
4. **Create Orders**: Create algo trigger orders for each cryptocurrency

## Order Parameters

- **Order Type**: `conditional` (conditional order)
- **Trading Mode**: `cash` (spot)
- **Direction**: `buy` (buy)
- **Quantity**: `0.001` (default, adjustable)
- **Trigger Price**: Calculated based on limit coefficient
- **Take Profit Mode**: `partial` (partial take profit)
- **Take Profit Ratio**: `50%`

## Important Notes

⚠️ **Important Reminder**:
- This is a live trading script, please ensure API credentials are correct
- The script will create orders for each cryptocurrency in limits.json
- Default order quantity is 0.001, please adjust based on your capital
- It's recommended to verify in test environment first

## Output Example

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

## Error Handling

The script includes complete error handling:
- API credential validation
- Network request retry
- Order creation status check
- Detailed log output

## Customization

You can modify the following parameters in the script:
- Order quantity (`sz`)
- Take profit ratio (`tpSlVal`)
- Request interval time (rate limiting)
- Order type and parameters
