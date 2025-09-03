# Crypto Trading Automation System

A comprehensive automated crypto trading system with OKX exchange integration, featuring modular architecture, algorithmic trading strategies, intelligent delisting protection, automated order management, and high-precision trading algorithms. **Now deployed on Cloudflare Workers + GitHub Actions with PostgreSQL database and enhanced security.**

## 🚀 Quick Start

```bash
# Install Python dependencies (includes python-okx==0.4.0)
pip install -r requirements.txt

# Setup environment variables (locally you can use .env, CI uses GitHub Secrets)
cp .env.example .env.local
# Fill in your OKX API credentials and DATABASE_URL

# Test the system
python create_algo_triggers.py
python monitor_delist.py
```

## 🏗️ Modern Cloud Architecture

### Cloud Deployment ⭐
- **Cloudflare Workers Cron** - Precise minute-level scheduling with 99.9% uptime
- **GitHub Actions** - Automated script execution triggered by Cloudflare Workers
- **PostgreSQL Database** - Cloud-hosted database (Neon) for scalability
- **Environment Secrets** - Secure credential management via GitHub Secrets
- **Automated Logging** - Centralized log collection and retention
- **🔒 Enhanced Security** - No hardcoded secrets, all sensitive data via environment variables

### Core Trading System ⭐
- **`monitor_delist.py`** - Intelligent delisting protection with automated response (277 lines)
- **`create_algo_triggers.py`** - Automated trigger order creation with high-precision Decimal arithmetic
- **`cancel_pending_triggers.py`** - Automated trigger order cancellation (all directions)
- **`cancel_pending_limits.py`** - Automated limit order management
- **`fetch_filled_orders.py`** - Automated filled order tracking with sell_time calculation
- **`auto_sell_orders.py`** - Automated market sell orders based on sell_time

### Modular Components 🆕
- **`config_manager.py`** - Configuration file management and backup (184 lines)
- **`crypto_matcher.py`** - Smart cryptocurrency matching and detection (119 lines)
- **`okx_client.py`** - Universal OKX API client for all scripts (210 lines) ⭐
- **`protection_manager.py`** - Automated protection operations orchestration (232 lines)

### Database & Utilities
- **`lib/database.py`** - PostgreSQL database integration with unified connection management
- **`.github/workflows/trading.yml`** - GitHub Actions workflow for automated execution
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
- **☁️ Cloud Migration** - Migrated from local SQLite to PostgreSQL with GitHub Actions automation
- **⏰ Precise Scheduling** - Replaced GitHub Actions cron with Cloudflare Workers for minute-level accuracy
- **📦 SDK Update** - Switched to `python-okx==0.4.0` with new submodule imports (`okx.Trade`, `okx.Funding`, etc.)
- **🗄️ DB Migration Guard** - Auto-create `sold_status` column in `filled_orders` on startup (PostgreSQL)
- **🧪 CI Compatibility** - `cancel_pending_triggers.py` runs without `.env` in Actions (uses Secrets)
- **🕛 Workflow Control** - Nightly cancel/create steps also runnable via manual workflow dispatch
- **🕐 Timezone Fix** - Fixed UTC/local time issues in `fetch_filled_orders.py` and `auto_sell_orders.py`
- **⚡ Cron Optimization** - Staggered 7-minute schedule to eliminate double execution at minute 0
- **🔧 Multi-Fill Order Fix** - Fixed `accFillSz` handling for orders with multiple fills (2025-09-02)
- **📊 Smart Update Strategy** - Added intelligent order update detection and data discrepancy resolution
- **🛡️ Data Integrity** - Enhanced database update logic to preserve critical status fields during updates
- **🎯 TradeId-Centric Processing** - Complete refactor to use `tradeId` as primary key for individual transactions (2025-09-03)
- **🔄 API Interface Optimization** - Switched from `get_orders_history` to `get_fills` for granular trade details
- **📈 Incremental Data Fetching** - Smart watermarking using last `tradeId` timestamp for efficient data retrieval
- **🔒 Enhanced Deduplication** - `tradeId`-based unique constraints prevent duplicate processing of same transaction
- **⚡ Partial Fill Support** - Each transaction (tradeId) processed individually, supporting complex order scenarios
- **🛠️ Database Schema Evolution** - `tradeId` as business primary key, `ordId` as audit trail, `sold_status` as VARCHAR
- **🔧 Method Signature Optimization** - Removed unused parameters and simplified API calls
- **⏰ 24-Hour Rolling Window** - Changed monitor from daily to 24-hour rolling window for better fault tolerance (2025-09-03)
- **🎯 Enhanced Crypto Matching** - Improved regex with negative lookahead/lookbehind to prevent false matches (2025-09-03)
- **🔄 Alias Support** - Added trading pair format support (BTC-USDT, BTC/USDT, BTCUSDT) for comprehensive matching (2025-09-03)
- **🛡️ False Positive Prevention** - Prevents BTC matching WBTC, ETH matching ETHW, AR matching ARB (2025-09-03)

### Cloudflare Workers Cron Schedule ⭐
```yaml
# Every 7 minutes (staggered to avoid overlap) - Monitoring and protection
- cron: '2,9,16,23,30,37,44,51,58 * * * *'

# Every 15 minutes - Fetch filled orders + Auto sell orders
- cron: '0,15,30,45 * * * *'

# Daily at 23:55 - Cancel pending trigger orders
- cron: '55 23 * * *'

# Daily at 00:05 - Create new algo triggers
- cron: '5 0 * * *'
```

### Execution Strategy
- **7-Minute Tasks (Staggered)**: `monitor_delist.py` + `cancel_pending_limits.py`
- **15-Minute Tasks**: `fetch_filled_orders.py` + `auto_sell_orders.py`
- **Daily Tasks**: `cancel_pending_triggers.py` (23:55) + `create_algo_triggers.py` (00:05)

### Automation Scripts

#### `monitor_delist.py` 🆕
- **Purpose**: Intelligent delisting protection with automated response
- **Architecture**: Modular design with specialized components
- **Features**: 
  - **24-Hour Rolling Window**: Monitors past 24 hours instead of daily for better fault tolerance
  - **Smart Detection**: Only monitors cryptocurrencies from your database configuration
  - **Enhanced Matching**: Improved regex prevents false matches (BTC vs WBTC, ETH vs ETHW)
  - **Trading Pair Support**: Recognizes BTC-USDT, BTC/USDT, BTCUSDT formats
  - **Automated Protection**: 3-step response (cancel orders → sell balances → update config)
  - **Database Integration**: Automatically removes delisted cryptos from database configuration
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
- **Purpose**: Cancel expired or unnecessary buy trigger orders
- **Features**:
  - **Buy Orders Only**: Cancels only buy trigger orders, preserves sell orders
  - **Automatic Cleanup**: Removes old buy trigger orders efficiently
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
- **Purpose**: Track completed orders and calculate sell times with tradeId-centric processing
- **Features**:
  - **TradeId-Centric Processing**: Uses `tradeId` as primary key for individual transactions
  - **API Interface Optimization**: Switched from `get_orders_history` to `get_fills` for granular trade details
  - **Incremental Data Fetching**: Smart watermarking using last `tradeId` timestamp for efficient retrieval
  - **Enhanced Deduplication**: `tradeId`-based unique constraints prevent duplicate processing
  - **Partial Fill Support**: Each transaction processed individually, supporting complex order scenarios
  - **Sell Time Calculation**: Automatically calculates sell_time as ts + 20 hours (UTC-based)
  - **Timezone Consistency**: All time calculations use UTC to match OKX API timestamps
  - **Real-time Monitoring**: Continuous order status monitoring with incremental updates
  - **Database Storage**: PostgreSQL database with optimized schema for trade tracking
  - **Buy-only Storage**: Client-side filtering for side='buy' trades
  - **Smart Update Strategy**: Uses ON CONFLICT (tradeId) DO UPDATE to handle updates correctly
  - **Data Integrity**: Preserves sell_time and sold_status during updates

#### `auto_sell_orders.py` ⭐
- **Purpose**: Automatically execute market sell orders based on sell_time with tradeId-centric processing
- **Features**:
  - **TradeId-Centric Processing**: Processes individual transactions (tradeId) instead of entire orders
  - **Individual Transaction Selling**: Each tradeId sold separately with its specific fillSz
  - **Enhanced Status Management**: Supports NULL/PROCESSING/SOLD states with VARCHAR field type
  - **Processing Lock**: Marks trades as PROCESSING before sell to prevent overlaps
  - **UTC Time Comparison**: Uses UTC timestamps to match sell_time calculation consistency
  - **Time-based Selling**: Executes sells when sell_time < current_time (UTC-based)
  - **Audio Notifications**: 10-second continuous beep sound for successful sells
  - **Duplicate Prevention**: Tracks sold_status to avoid re-processing same tradeId
  - **Strict Selection**: Only processes rows where sold_status IS NULL; sell_time cast to Integer
  - **Detailed Logging**: Includes tradeId and ordId in logs for complete auditability
  - **Market Order Execution**: Uses market orders for immediate execution
  - **Timezone Display**: Shows sell times with "UTC" label for clarity
  - **Precise Quantity Control**: Uses fillSz for exact transaction quantity (not accumulated)
  - **Partial Fill Support**: Correctly handles orders with multiple partial fills as separate transactions

### New Modular Components 🆕

#### `config_manager.py`
- **Purpose**: Database configuration management and backup operations
- **Features**:
  - **Database Integration**: Reads and manages configuration from PostgreSQL database
  - **Smart Loading**: Extracts base cryptocurrencies from trading pairs (BTC from BTC-USDT)
  - **Automatic Backup**: Creates timestamped JSON backups before modifications
  - **Safe Cleanup**: Removes delisted cryptocurrencies from database configuration
  - **Error Handling**: Validates database structure and handles connection issues

#### `crypto_matcher.py`
- **Purpose**: Intelligent cryptocurrency detection in announcements with enhanced matching
- **Features**:
  - **Spot Trading Filter**: Only processes spot trading related announcements
  - **Enhanced Regex Matching**: Uses negative lookahead/lookbehind to prevent false matches
  - **Trading Pair Alias Support**: Recognizes BTC-USDT, BTC/USDT, BTCUSDT formats
  - **False Positive Prevention**: Prevents BTC matching WBTC, ETH matching ETHW, AR matching ARB
  - **Case Insensitive**: Robust text matching regardless of case
  - **Database Integration**: Loads configured cryptocurrencies from database
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
- **`.env`** - Environment variables including DATABASE_URL for PostgreSQL
- **`backups/limits_*.json`** - Automatic configuration backups with timestamps

### Log Files
- **GitHub Actions Logs** - Centralized logging via GitHub Actions artifacts
- **`logs/`** - Local log files (if running locally)
- **`*.log`** - Various operation logs

## 🔧 Environment Variables

```env
# PostgreSQL Database (required)
DATABASE_URL=your_database_connection_string

# OKX Production API (required for private endpoints)
OKX_API_KEY=your_api_key
OKX_SECRET_KEY=your_secret_key
OKX_PASSPHRASE=your_passphrase

# OKX Trading Environment (false for live, true for demo)
OKX_TESTNET=false
```

## 🤖 Trading Strategy

### Core Functions
1. **Automated Monitoring** - 24/7 system monitoring and management via GitHub Actions
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

### TradeId-Centric Processing Architecture 🆕
- **Individual Transaction Processing**: Each `tradeId` represents a unique transaction, processed independently
- **Partial Fill Support**: One order can have multiple `tradeId`s (partial fills), each sold separately
- **Enhanced Deduplication**: `tradeId`-based unique constraints prevent duplicate processing
- **Precise Quantity Control**: Uses `fillSz` (single transaction size) instead of `accFillSz` (accumulated size)
- **Database Schema Optimization**: `tradeId` as business primary key, `ordId` as audit trail
- **Status Management**: VARCHAR `sold_status` supports NULL/PROCESSING/SOLD states
- **API Interface**: Switched from `get_orders_history` to `get_fills` for granular trade details
- **Incremental Fetching**: Smart watermarking using last `tradeId` timestamp for efficiency

#### Example: Partial Fill Scenario
```
Order: BTC-USDT Buy 1.0 BTC
├── tradeId: trade_001 (fillSz: 0.5 BTC) → Sold separately
├── tradeId: trade_002 (fillSz: 0.3 BTC) → Sold separately  
└── tradeId: trade_003 (fillSz: 0.2 BTC) → Sold separately
```
Each transaction is processed individually with its own `sell_time` and `sold_status`.

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

### Cloud Deployment (Recommended) ⭐
```bash
# 1. Fork this repository to your GitHub account
# 2. Set up GitHub Secrets:
#    - DATABASE_URL: Your PostgreSQL connection string
#    - OKX_API_KEY: Your OKX API key
#    - OKX_SECRET_KEY: Your OKX secret key
#    - OKX_PASSPHRASE: Your OKX passphrase

# 3. Deploy Cloudflare Worker:
#    - Install Wrangler CLI: npm install -g wrangler
#    - Login: wrangler login
#    - Deploy: wrangler deploy
#    - Set GITHUB_TOKEN in Cloudflare Dashboard

# 4. Enable GitHub Actions in your repository
# 5. The system will automatically run on precise schedule via Cloudflare Workers
# 6. You can manually trigger nightly steps (cancel/create) via "Run workflow"
```

### Local Development
```bash
# Test automation scripts locally
python monitor_delist.py
python create_algo_triggers.py
python fetch_filled_orders.py
python auto_sell_orders.py
```

### Database Setup
```bash
# Initialize PostgreSQL database
python lib/database.py

# Test database connection
python -c "from lib.database import Database; db = Database(); print('Connected:', db.connect())"
```

## 🔒 Security Features

- OKX API authentication with HMAC-SHA256 signatures
- Environment variable protection via GitHub Secrets
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

## 📊 Modern Project Structure

```
crypto_remote/
├── .github/                 # GitHub Actions workflows
│   └── workflows/
│       └── trading.yml      # Automated trading workflow (triggered by Cloudflare Workers)
├── lib/                     # Utility libraries
│   └── database.py         # PostgreSQL database integration
├── backups/                # Automatic configuration backups
│   └── limits_*.json      # Timestamped configuration backups
├── logs/                   # Detailed operation logs
│   └── *.log              # Daily monitoring and operation logs
├── requirements.txt         # Python dependencies
├── limits.json             # Trading limits for 29 crypto pairs
├── .env                    # Environment variables (local)
├── wrangler.toml           # Cloudflare Worker configuration
├── cloudflare-worker.js    # Cloudflare Worker cron scheduler
│
├── # Core Trading System
├── monitor_delist.py       # Main delisting protection (277 lines) ⭐
├── create_algo_triggers.py # Automated trigger order creation ⭐
├── cancel_pending_triggers.py # Automated trigger order cancellation ⭐
├── cancel_pending_limits.py # Automated limit order management
├── fetch_filled_orders.py  # Automated filled order tracking ⭐
├── auto_sell_orders.py     # Automated market sell orders ⭐
│
├── # Modular Components
├── config_manager.py       # Configuration management (184 lines)
├── crypto_matcher.py       # Smart crypto detection (119 lines)
├── okx_client.py           # Universal OKX API client (210 lines) ⭐
├── protection_manager.py   # Protection workflow (232 lines)
│
├── # Documentation
├── ALGO_TRIGGER_README.md  # Detailed algo trigger documentation
├── MONITOR_README.md       # Detailed monitoring documentation
├── CLOUDFLARE_SETUP.md     # Cloudflare Worker deployment guide
└── SETUP.md                # Setup and configuration guide
```

## 🚀 Production Deployment Status ✅

### Cloudflare Worker Deployment
- **✅ Worker Name**: `crypto-trading-cron-prod`
- **✅ Access URL**: `https://crypto-trading-cron-prod.eatfreshapple.workers.dev/`
- **✅ KV Namespace**: `DEDUP_KV` (ID configured via environment variable)
- **✅ Environment Variables**: All secrets properly configured
- **✅ Cron Scheduling**: 4 different time intervals active
- **✅ Deduplication**: KV-based minute-level deduplication working
- **✅ GitHub Integration**: Repository dispatch triggers working

### Security Status 🔒
- **✅ No Hardcoded Secrets**: All sensitive data via environment variables
- **✅ GitHub Repository**: Safe for public access
- **✅ API Keys**: Securely stored in Cloudflare Secrets
- **✅ Database Credentials**: Environment variable protected
- **✅ KV Namespace ID**: Environment variable protected

## 🎯 System Status ✅

### Current Performance
- **Modular Architecture**: 59% code reduction in main script (683 → 277 lines)
- **Protection System**: Intelligent delisting detection with automated response
- **Trigger Order Creation**: 29/29 crypto pairs successful (100%)
- **API Environment**: Correctly configured for live trading with proper market sell parameters
- **Price Precision**: High-precision Decimal arithmetic working perfectly
- **Configuration Management**: Automatic backup and cleanup functionality
- **Error Resolution**: All previous API issues resolved with enhanced error handling
- **Cloud Migration**: Successfully migrated to PostgreSQL and GitHub Actions
- **Precise Scheduling**: Cloudflare Workers provide minute-level accuracy (99.9% uptime)
- **TradeId-Centric Processing**: Complete refactor to individual transaction processing (2025-09-03)
- **Enhanced Deduplication**: tradeId-based unique constraints prevent duplicate processing
- **Partial Fill Support**: Each transaction processed individually with precise quantity control
- **Database Schema Optimization**: tradeId as business primary key, enhanced status management
- **API Interface Optimization**: Switched to get_fills for granular trade details
- **Incremental Data Fetching**: Smart watermarking for efficient data retrieval
- **24-Hour Rolling Window**: Monitor changed from daily to rolling window for better fault tolerance
- **Enhanced Crypto Matching**: Improved regex prevents false matches with comprehensive alias support
- **🔒 Security Hardening**: All sensitive data moved to environment variables, no hardcoded secrets
- **✅ Production Deployment**: Successfully deployed to Cloudflare Workers with KV deduplication

### Architecture Benefits
- **Maintainability**: Clean separation of concerns across 5 specialized modules
- **Code Reusability**: Universal OKX client eliminates duplication across 6 scripts
- **Testability**: Individual components can be tested independently
- **Extensibility**: Easy to add new protection features or API integrations
- **Reliability**: Robust error handling and logging throughout all modules
- **Performance**: Optimized API calls and efficient resource management
- **Scalability**: Cloud-based deployment with PostgreSQL database
- **Scheduling Precision**: Cloudflare Workers eliminate GitHub Actions cron inconsistencies

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
**System Architecture**: Modular + Cloud • **Total Lines**: 1,120+ (5 modules) • **Main Script**: 277 lines • **Code Reduction**: 59% • **API Unification**: 6 scripts share 1 OKX client • **Database**: PostgreSQL (Neon) • **Deployment**: Cloudflare Workers + GitHub Actions • **Scheduling**: Precise minute-level cron via Cloudflare Workers • **TradeId-Centric**: Individual transaction processing with enhanced deduplication • **Database Schema**: tradeId as business primary key, VARCHAR sold_status • **24-Hour Rolling**: Monitor with enhanced crypto matching and false positive prevention • **🔒 Security**: Environment variables only, no hardcoded secrets • **✅ Production**: Deployed to crypto-trading-cron-prod.eatfreshapple.workers.dev • **Last Updated**: 2025-09-03
