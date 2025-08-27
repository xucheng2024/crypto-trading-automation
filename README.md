# Crypto Trading Automation System

A comprehensive automated crypto trading system with OKX exchange integration, featuring algorithmic trading strategies, delisting announcements monitoring, automated order management, and high-precision trading algorithms.

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

## 🏗️ Architecture

### Core Automation System ⭐
- **`monitor_delist.py`** - Automated delisting announcements monitoring
- **`create_algo_triggers.py`** - Automated trigger order creation with high-precision Decimal arithmetic
- **`cancel_pending_triggers.py`** - Automated trigger order cancellation (all directions)
- **`cancel_pending_limits.py`** - Automated limit order management
- **`fetch_filled_orders.py`** - Automated filled order tracking with sell_time calculation
- **`auto_sell_orders.py`** - Automated market sell orders based on sell_time
- **`restart_monitor.sh`** - Monitor service restart script

### Database & Utilities
- **`lib/database.py`** - SQLite database integration for order tracking
- **`database.db`** - Main trading database
- **`filled_orders.db`** - SQLite database for order tracking with sell_time and sold_status

## 🤖 Automated Trading System ⭐

### Core Automation Features
1. **Delisting Monitoring** - 24/7 monitoring of OKX delisting announcements
2. **Trigger Order Management** - Automated creation and cancellation of trigger orders with multiple trigger points
3. **Limit Order Management** - Smart cancellation of pending limit orders
4. **Filled Order Tracking** - Real-time monitoring of completed orders with sell_time calculation (ts + 20 hours)
5. **Auto Sell Orders** - Automated market sell orders when sell_time is reached
6. **Service Management** - Automated monitoring service restart

### Recent System Improvements ✅
- **Fixed API Environment Issues** - Resolved hardcoded API flags and variable scope problems
- **High-Precision Price Handling** - Implemented Decimal arithmetic for accurate price calculations
- **Multiple Trigger Points** - Each crypto pair now creates 3 trigger orders (99.9%, 100%, 100.1% of base price)
- **Complete API Integration** - All 29 crypto pairs successfully create trigger orders
- **Enhanced Error Handling** - Improved retry mechanisms and logging

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

#### `monitor_delist.py`
- **Purpose**: Monitor OKX delisting announcements 24/7
- **Features**: 
  - Real-time delisting detection
  - Automatic service restart on failure
  - Comprehensive logging
  - Error handling and recovery

#### `create_algo_triggers.py` ⭐
- **Purpose**: Create automated trigger orders for trading strategies
- **Features**:
  - **Multiple Trigger Points**: Creates 3 trigger orders per crypto pair (99.9%, 100%, 100.1% of base price)
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

### Configuration Files
- **`limits.json`** - Trading limits and trigger price coefficients for 29 crypto pairs
- **`filled_orders.db`** - SQLite database for order tracking with sell_time and sold_status
- **`database.db`** - Main trading database

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

## 📊 Project Structure

```
crypto/
├── lib/                    # Utility libraries
│   └── database.py        # SQLite database integration
├── requirements.txt        # Python dependencies
├── limits.json            # Trading limits for 29 crypto pairs
├── filled_orders.db       # SQLite database for order tracking
├── database.db            # Main SQLite database
├── monitor_delist.py      # Automated delisting monitor
├── create_algo_triggers.py # Automated trigger order creation ⭐
├── cancel_pending_triggers.py # Automated trigger order cancellation ⭐
├── cancel_pending_limits.py # Automated limit order management
├── fetch_filled_orders.py # Automated filled order tracking ⭐
├── auto_sell_orders.py    # Automated market sell orders ⭐
├── restart_monitor.sh     # Monitor restart script
├── ALGO_TRIGGER_README.md # Detailed algo trigger documentation
├── MONITOR_README.md      # Detailed monitoring documentation
└── cron_*.log            # Automation logs
```

## 🎯 System Status ✅

### Current Performance
- **Trigger Order Creation**: 29/29 crypto pairs successful (100%)
- **API Environment**: Correctly configured for live trading
- **Price Precision**: High-precision Decimal arithmetic working perfectly
- **Error Resolution**: All previous API issues resolved
- **Automation**: All cron jobs and scripts functioning correctly

### Supported Crypto Pairs
All 29 pairs in `limits.json` are fully supported:
- **Major Coins**: BTC-USDT, ETH-USDT, BNB-USDT, XRP-USDT
- **High-Precision Coins**: PEPE-USDT, SHIB-USDT (9 decimal places)
- **All Other Pairs**: CRO-USDT, WBTC-USDT, LEO-USDT, and 20 more

## 📝 License

This project is for educational and personal use. Please ensure compliance with OKX API terms and local trading regulations.
