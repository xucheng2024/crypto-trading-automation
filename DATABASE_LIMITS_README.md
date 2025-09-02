# Database Limits Configuration

## Overview

The trading system has been migrated from using `limits.json` file to storing limits configuration in PostgreSQL database. This provides better scalability, version control, and centralized configuration management.

## Migration Status ✅

- ✅ Database tables created (`limits_config` and `crypto_limits`)
- ✅ Migration script created (`migrate_limits_to_db.py`)
- ✅ Config manager updated to use database
- ✅ All trading scripts updated to use database configuration
- ✅ `limits.json` added to `.gitignore`
- ✅ All tests passing

## Usage

### 1. Initial Migration

If you have an existing `limits.json` file, run the migration script:

```bash
python migrate_limits_to_db.py
```

### 2. Using Database Configuration

All scripts now automatically use database configuration:

```bash
# Create algo triggers (uses database)
python create_algo_triggers.py

# Auto sell orders (uses database)
python auto_sell_orders.py

# Monitor delist (uses database)
python monitor_delist.py
```

### 3. Configuration Management

Use the ConfigManager class to interact with database configuration:

```python
from config_manager import ConfigManager

# Initialize config manager
config_manager = ConfigManager()

# Load configured cryptocurrencies
cryptos = config_manager.load_configured_cryptos()

# Load full configuration
full_config = config_manager.load_full_config()

# Get specific crypto configuration
btc_config = config_manager.get_crypto_config('BTC-USDT')

# Get configuration statistics
stats = config_manager.get_config_stats()
```

### 4. Database Operations

Direct database operations are available through the Database class:

```python
from lib.database import Database

db = Database()
db.connect()

# Get all configured crypto pairs
cryptos = db.get_configured_cryptos()

# Get specific crypto configuration
config = db.get_crypto_config('BTC-USDT')

# Load full configuration
full_config = db.load_limits_config()

db.disconnect()
```

## Database Schema

### limits_config table
- `id` - Primary key
- `generated_at` - Configuration generation timestamp
- `strategy_name` - Strategy name
- `description` - Strategy description
- `strategy_type` - Strategy type
- `duration` - Duration setting
- `limit_range_min/max` - Limit range parameters
- `min_trades` - Minimum trades parameter
- `min_avg_earn` - Minimum average earnings
- `buy_fee/sell_fee` - Trading fees
- `created_at/updated_at` - Timestamps

### crypto_limits table
- `id` - Primary key
- `inst_id` - Instrument ID (e.g., 'BTC-USDT')
- `best_limit` - Best limit value
- `best_duration` - Best duration value
- `max_returns` - Maximum returns
- `trade_count` - Trade count
- `trades_per_month` - Trades per month
- `avg_return_per_trade` - Average return per trade
- `created_at/updated_at` - Timestamps

## Benefits

1. **Centralized Configuration**: All limits stored in one database
2. **Version Control**: No more `limits.json` in git repository
3. **Scalability**: Easy to add new crypto pairs and configurations
4. **Backup**: Database backups include configuration
5. **Consistency**: All scripts use the same configuration source
6. **Security**: Configuration not exposed in repository

## Testing

Run the test suite to verify everything is working:

```bash
python test_database_limits.py
```

## Migration Notes

- Original `limits.json` is preserved as backup
- All existing functionality maintained
- No breaking changes to trading scripts
- Database connection required for all operations
