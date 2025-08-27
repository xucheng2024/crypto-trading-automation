# Crypto Trading Automation System

A comprehensive automated crypto trading system with OKX exchange integration, featuring modular architecture, algorithmic trading strategies, intelligent delisting protection, automated order management, and high-precision trading algorithms.

## 🚀 Quick Start

```bash
# Install Python dependencies
pip install -r requirements.txt

# Setup environment variables
cp .env.example .env.local
# Fill in your OKX API credentials

# Test the system
python create_algo_triggers.py
python monitor_delist.py
```

## 🏗️ Modular Architecture

### Core Trading System ⭐
- **`monitor_delist.py`** - Intelligent delisting protection with automated response (277 lines)
- **`create_algo_triggers.py`** - Automated trigger order creation with high-precision Decimal arithmetic
- **`cancel_pending_triggers.py`** - Automated trigger order cancellation (all directions)
- **`cancel_pending_limits.py`** - Automated limit order management
- **`fetch_filled_orders.py`** - Automated filled order tracking with sell_time calculation
- **`auto_sell_orders.py`** - Automated market sell orders based on sell_time

### Modular Components (New!) 🆕
- **`config_manager.py`** - Configuration file management and backup (184 lines)
- **`crypto_matcher.py`** - Smart cryptocurrency matching and detection (119 lines)
- **`okx_client.py`** - Universal OKX API client for all scripts (210 lines) ⭐
- **`protection_manager.py`** - Automated protection operations orchestration (232 lines)

### Database & Utilities
- **`lib/database.py`** - SQLite database integration for order tracking
- **`database.db`** - Main trading database
- **`filled_orders.db`** - SQLite database for order tracking with sell_time and sold_status
- **`backups/`** - Automatic configuration backups

## 🤖 Automated Trading System ⭐

### Core Automation Features
1. **Intelligent Delisting Protection** - 24/7 monitoring with automated response system
2. **Trigger Order Management** - Automated creation and cancellation of trigger orders with multiple trigger points
3. **Limit Order Management** - Smart cancellation of pending limit orders
4. **Filled Order Tracking** - Real-time monitoring of completed orders with sell_time calculation (ts + 20 hours)
5. **Auto Sell Orders** - Automated market sell orders when sell_time is reached
6. **Modular Architecture** - Clean, maintainable, and extensible component design

### Recent System Improvements ✅
- **🔄 Major Refactoring** - Modular architecture with 5 specialized components (683 → 277 lines for main script)
- **🛡️ Enhanced Protection** - Intelligent delisting detection with automatic order cancellation and balance liquidation
- **⚙️ Configuration Management** - Automated backup and cleanup of trading configurations
- **🔧 Universal OKX Client** - Single OKX API client shared across all scripts, eliminating code duplication
- **📊 Better Maintainability** - 59% code reduction in main script, improved testability and debugging

### Cron Job Schedule
```bash
# Daily at 11:00 PM - Restart monitoring service
0 23 * * * cd /Users/mac/Downloads/projects/crypto && ./restart_monitor.sh >> /Users/mac/Downloads/projects/crypto/cron_restart.log 2>&1

# Daily at 11:55 PM - Cancel pending trigger orders
55 23 * * * cd /Users/mac/Downloads/projects/crypto && /Users/mac/miniconda3/bin/python cancel_pending_triggers.py >> /Users/mac/Downloads/projects/crypto/cron_cancel.log 2>&1

# Daily at 12:05 AM - Create new trigger orders
5 0 * * * cd /Users/mac/Downloads/projects/crypto && /Users/mac/miniconda3/bin/python create_algo_triggers.py >> /Users/mac/Downloads/projects/crypto/cron_create.log 2>&1

# Every 5 minutes - Cancel pending buy limit orders
*/5 * * * * cd /Users/mac/Downloads/projects/crypto && /Users/mac/miniconda3/bin/python cancel_pending_limits.py --side buy >> /Users/mac/Downloads/projects/crypto/cron_cancel_limits.log 2>&1

# Every 15 minutes - Fetch and track filled orders
*/15 * * * * cd /Users/mac/Downloads/projects/crypto && /Users/mac/miniconda3/bin/python fetch_filled_orders.py >> /Users/mac/Downloads/projects/crypto/cron_fetch_orders.log 2>&1

# Every 5 minutes - Execute auto sell orders based on sell_time
*/5 * * * * cd /Users/mac/Downloads/projects/crypto && /Users/mac/miniconda3/bin/python auto_sell_orders.py >> /Users/mac/Downloads/projects/crypto/cron_auto_sell.log 2>&1
```

### Automation Scripts

#### `monitor_delist.py` 🆕
- **Purpose**: Intelligent delisting protection with automated response
- **Architecture**: Modular design with specialized components
- **Features**: 
  - **Smart Detection**: Only monitors cryptocurrencies from your configuration
  - **Automated Protection**: 3-step response (cancel orders → sell balances → update config)
  - **Configuration Cleanup**: Automatically removes delisted cryptos from limits.json
  - **Balance Liquidation**: Market sell any holdings of affected cryptocurrencies
  - **Trigger Reconstruction**: Recreates algo triggers with updated configuration
  - **Comprehensive Logging**: Detailed audit trail of all protection actions

#### `create_algo_triggers.py` ⭐
- **Purpose**: Create automated trigger orders for trading strategies
- **Features**:
  - **Multiple Trigger Points**: Creates 2 trigger orders per crypto pair (99.9%, 100.1% of base price)
  - **High-Precision Arithmetic**: Uses Python Decimal type for accurate price calculations
  - **Dynamic Precision**: Automatically determines price precision based on coin value
  - **Grid-based Strategy**: Configurable parameters via `limits.json`
  - **Smart Order Placement**: Intelligent order placement logic with retry mechanisms
  - **Database Integration**: Order tracking and management

#### `cancel_pending_triggers.py` ⭐
- **Purpose**: Cancel expired or unnecessary trigger orders
- **Features**:
  - **Direction Agnostic**: Cancels trigger orders regardless of buy/sell direction
  - **Automatic Cleanup**: Removes old trigger orders efficiently
  - **Smart Cancellation**: Order status verification before cancellation
  - **Comprehensive Logging**: Detailed logging and monitoring
  - **Rate Limiting**: Respects OKX API limits (5 requests/2 seconds)

#### `cancel_pending_limits.py`
- **Purpose**: Manage pending limit orders
- **Features**:
  - Side-specific order cancellation (buy/sell)
  - Configurable cancellation intervals
  - Order status checking
  - Efficient order management

#### `fetch_filled_orders.py` ⭐
- **Purpose**: Track completed orders and calculate sell times
- **Features**:
  - **Sell Time Calculation**: Automatically calculates sell_time as ts + 20 hours
  - **Real-time Monitoring**: Continuous order status monitoring
  - **Database Storage**: SQLite database for order history
  - **Configurable Intervals**: Adjustable monitoring frequency
  - **Order Statistics**: Comprehensive order analytics and reporting

#### `auto_sell_orders.py` ⭐
- **Purpose**: Automatically execute market sell orders based on sell_time
- **Features**:
  - **Time-based Selling**: Executes sells when sell_time < current_time and > (current_time - 15 minutes)
  - **Audio Notifications**: 10-second continuous beep sound for successful sells
  - **Duplicate Prevention**: Tracks sold_status to avoid re-processing
  - **Market Order Execution**: Uses market orders for immediate execution
  - **Comprehensive Logging**: Detailed transaction logging and error handling

### New Modular Components 🆕

#### `config_manager.py`
- **Purpose**: Configuration file management and backup operations
- **Features**:
  - **Smart Loading**: Reads and validates `limits.json` configuration
  - **Automatic Backup**: Creates timestamped backups before modifications
  - **Safe Cleanup**: Removes delisted cryptocurrencies from configuration
  - **Error Handling**: Validates JSON structure and handles file operations

#### `crypto_matcher.py`
- **Purpose**: Intelligent cryptocurrency detection in announcements
- **Features**:
  - **Spot Trading Filter**: Only processes spot trading related announcements
  - **Smart Matching**: Extracts crypto symbols from configured pairs (e.g., BTC from BTC-USDT)
  - **Case Insensitive**: Robust text matching regardless of case
  - **Validation**: Ensures only configured cryptocurrencies trigger actions

#### `okx_client.py` ⭐
- **Purpose**: Universal OKX API client shared across all trading scripts
- **Features**:
  - **Multi-API Support**: Funding, Trade, and Market APIs in one client
  - **Universal Interface**: `get_funding_api()`, `get_trade_api()`, `get_market_api()`
  - **Smart Availability**: `is_available()` for authenticated APIs, `is_market_available()` for public data
  - **Unified Error Handling**: Consistent error management across all scripts
  - **Environment Integration**: Automatic credential loading from environment variables
  - **Code Deduplication**: Eliminates 50+ lines of repeated API initialization across 6 scripts

#### `protection_manager.py`
- **Purpose**: Orchestrates complete protection workflow
- **Features**:
  - **3-Step Protection**: Cancel orders → Check/Sell balances → Update configuration
  - **Script Execution**: Safely executes cancellation scripts with error handling
  - **Balance Management**: Checks account balances and executes market sells
  - **Workflow Orchestration**: Coordinates all protection operations with detailed logging

### Configuration Files
- **`limits.json`** - Trading limits and trigger price coefficients for 29 crypto pairs
- **`filled_orders.db`** - SQLite database for order tracking with sell_time and sold_status
- **`database.db`** - Main trading database
- **`backups/limits_*.json`** - Automatic configuration backups with timestamps

### Log Files
- **`cron_restart.log`** - Monitor restart logs
- **`cron_cancel.log`** - Trigger order cancellation logs
- **`cron_create.log`** - Trigger order creation logs
- **`cron_cancel_limits.log`** - Limit order management logs
- **`cron_fetch_orders.log`** - Filled order tracking logs
- **`cron_auto_sell.log`** - Auto sell order execution logs
- **`monitor_*.log`** - Daily monitoring logs
- **`algo_triggers_*.log`** - Trigger order creation logs

## 🔧 Environment Variables

```env
# OKX Production API (required for private endpoints)
OKX_API_KEY=your_production_api_key
OKX_SECRET_KEY=your_production_secret_key
OKX_PASSPHRASE=your_production_passphrase

# OKX Trading Environment (false for live, true for demo)
OKX_TESTNET=false
```

## 🤖 Trading Strategy

### Core Functions
1. **Automated Monitoring** - 24/7 system monitoring and management
2. **Smart Order Management** - Intelligent order creation and cancellation
3. **High-Precision Trading** - Decimal arithmetic for accurate price calculations
4. **Time-based Execution** - Automated selling based on calculated sell times
5. **Risk Management** - Configurable limits and coefficients per crypto pair

### Trading Strategy Details ⭐
- **Trigger Order Strategy**: Creates 3 trigger points per crypto pair to maximize execution probability
- **Price Precision**: Uses Decimal type with 28-digit precision for accurate calculations
- **Sell Time Management**: Automatically calculates and tracks sell times (ts + 20 hours)
- **Risk Management**: Configurable limits and coefficients per crypto pair
- **Market Adaptation**: Dynamic precision adjustment based on coin value

## 📢 Announcements Features

### Supported Announcement Types
- **`announcements-delistings`** - Token/coin delistings
- **`announcements-latest-announcements`** - General updates
- **`announcements-trading-updates`** - Trading rule changes
- **`announcements-web3`** - Web3 ecosystem updates
- **`announcements-new-listings`** - New token listings

### Authentication & Security
- **Private Endpoint Access** - Full OKX API authentication
- **HMAC-SHA256 Signatures** - Secure request signing
- **ISO 8601 Timestamps** - Precise time synchronization
- **Rate Limiting** - Respects OKX API limits (5 requests/2 seconds)

## 🚀 Deployment

### Local Development
```bash
# Test automation scripts
python monitor_delist.py
python create_algo_triggers.py
python fetch_filled_orders.py
python auto_sell_orders.py
```

### Automation Setup
```bash
# Install crontab for automated trading
crontab -e

# Add the cron jobs (see Cron Job Schedule section above)

# Check crontab status
crontab -l

# Monitor automation logs
tail -f cron_fetch_orders.log
tail -f cron_create.log
tail -f cron_cancel.log
tail -f cron_auto_sell.log
```

## 🔒 Security Features

- OKX API authentication with HMAC-SHA256 signatures
- Environment variable protection
- Private endpoint authentication for sensitive data
- Input validation and comprehensive error handling
- Secure timestamp generation and signature verification
- Automated system monitoring and recovery

## 🛠️ Development

```bash
# Install dependencies
pip install -r requirements.txt

# Test automation scripts
python monitor_delist.py
python create_algo_triggers.py
python fetch_filled_orders.py
python auto_sell_orders.py

# Initialize database
python lib/database.py
```

## 📊 Modular Project Structure

```
crypto/
├── lib/                    # Utility libraries
│   └── database.py        # SQLite database integration
├── backups/               # Automatic configuration backups 🆕
│   └── limits_*.json     # Timestamped configuration backups
├── logs/                  # Detailed operation logs
│   └── *.log             # Daily monitoring and operation logs
├── requirements.txt        # Python dependencies
├── limits.json            # Trading limits for 29 crypto pairs
├── filled_orders.db       # SQLite database for order tracking
├── database.db            # Main SQLite database
│
├── # Core Trading System
├── monitor_delist.py      # Main delisting protection (277 lines) ⭐
├── create_algo_triggers.py # Automated trigger order creation ⭐
├── cancel_pending_triggers.py # Automated trigger order cancellation ⭐
├── cancel_pending_limits.py # Automated limit order management
├── fetch_filled_orders.py # Automated filled order tracking ⭐
├── auto_sell_orders.py    # Automated market sell orders ⭐
│
├── # Modular Components (New!) 🆕
├── config_manager.py      # Configuration management (184 lines)
├── crypto_matcher.py      # Smart crypto detection (119 lines)
├── okx_client.py          # Universal OKX API client (210 lines) ⭐
├── protection_manager.py  # Protection workflow (232 lines)
│
├── # Documentation & Scripts
├── restart_monitor.sh     # Monitor restart script
├── ALGO_TRIGGER_README.md # Detailed algo trigger documentation
├── MONITOR_README.md      # Detailed monitoring documentation
└── cron_*.log            # Automation logs
```

## 🎯 System Status ✅

### Current Performance
- **Modular Architecture**: 59% code reduction in main script (683 → 277 lines)
- **Protection System**: Intelligent delisting detection with automated response
- **Trigger Order Creation**: 29/29 crypto pairs successful (100%)
- **API Environment**: Correctly configured for live trading with proper market sell parameters
- **Price Precision**: High-precision Decimal arithmetic working perfectly
- **Configuration Management**: Automatic backup and cleanup functionality
- **Error Resolution**: All previous API issues resolved with enhanced error handling

### Architecture Benefits
- **Maintainability**: Clean separation of concerns across 5 specialized modules
- **Code Reusability**: Universal OKX client eliminates duplication across 6 scripts
- **Testability**: Individual components can be tested independently
- **Extensibility**: Easy to add new protection features or API integrations
- **Reliability**: Robust error handling and logging throughout all modules
- **Performance**: Optimized API calls and efficient resource management

### Supported Crypto Pairs
All 29 pairs in `limits.json` are fully supported:
- **Major Coins**: BTC-USDT, ETH-USDT, BNB-USDT, XRP-USDT
- **High-Precision Coins**: PEPE-USDT, SHIB-USDT (9 decimal places)
- **All Other Pairs**: CRO-USDT, WBTC-USDT, LEO-USDT, and 20 more

## 🚀 Quick Usage Guide

### Testing the Modular System
```bash
# Test individual components
python -c "from config_manager import ConfigManager; cm = ConfigManager(); print(cm.load_configured_cryptos())"
python -c "from crypto_matcher import CryptoMatcher; cm = CryptoMatcher(); print(cm.is_spot_related('OKX to delist BTC spot trading'))"
python -c "from okx_client import OKXClient; oc = OKXClient(); print('OKX client initialized successfully')"

# Test the complete system
python monitor_delist.py
```

### Module Integration Example
```python
from config_manager import ConfigManager
from crypto_matcher import CryptoMatcher
from protection_manager import ProtectionManager
from okx_client import OKXClient

# Initialize components
config_mgr = ConfigManager()
crypto_matcher = CryptoMatcher()
protection_mgr = ProtectionManager()
okx_client = OKXClient()

# Universal OKX API access
if okx_client.is_available():
    trade_api = okx_client.get_trade_api()
    funding_api = okx_client.get_funding_api()
    print("✅ Authenticated APIs ready")

if okx_client.is_market_available():
    market_api = okx_client.get_market_api()
    print("✅ Public data API ready")

# Load configuration
cryptos = config_mgr.load_configured_cryptos()
print(f"Monitoring {len(cryptos)} cryptocurrencies")

# Check for affected cryptos in announcement
announcement = "OKX to delist BTC, ETH spot trading pairs"
affected = crypto_matcher.find_affected_cryptos(announcement, cryptos)
if affected:
    protection_mgr.execute_full_protection_flow(affected)
```

## 📝 License

This project is for educational and personal use. Please ensure compliance with OKX API terms and local trading regulations.

---
**System Architecture**: Modular • **Total Lines**: 1,120+ (5 modules) • **Main Script**: 277 lines • **Code Reduction**: 59% • **API Unification**: 6 scripts share 1 OKX client • **Last Updated**: 2025-01-27
