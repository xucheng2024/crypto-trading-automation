# Crypto Trading Automation

A comprehensive automated crypto trading system with OKX exchange integration, featuring algorithmic trading strategies, announcements monitoring, automated order management, and modern API architecture.

## 🚀 Quick Start

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# Setup environment variables
cp env.example .env.local
# Fill in your OKX API credentials

# Start Flask API server
cd api && python okx_flask.py

# Run Next.js development server (in another terminal)
npm run dev
```

## 🏗️ Architecture

### Frontend (Next.js)
- **`app/page.tsx`** - Main dashboard with OKX API testing interface
- **`components/Dashboard.tsx`** - Main dashboard component
- **`components/PortfolioOverview.tsx`** - Portfolio display
- **`components/TradingInterface.tsx`** - Trading interface
- **`components/TradeHistory.tsx`** - Trade history display

### Backend (Flask Python)
- **`api/okx_flask.py`** - Flask application with OKX trading API and announcements endpoints
- **`requirements.txt`** - Python dependencies

### Automation System ⭐
- **`monitor_delist.py`** - Automated delisting announcements monitoring
- **`create_algo_triggers.py`** - Automated trigger order creation
- **`cancel_pending_triggers.py`** - Automated trigger order cancellation
- **`cancel_pending_limits.py`** - Automated limit order management
- **`fetch_filled_orders.py`** - Automated filled order tracking with audio alerts
- **`restart_monitor.sh`** - Monitor service restart script

### Core API Endpoints

#### Trading Operations
- **`/api/okx/place-order`** - Place trading orders (POST)
- **`/api/okx/cancel-order`** - Cancel existing orders (POST)
- **`/api/okx/sell`** - Execute sell orders (POST)
- **`/api/okx/health`** - API health check (GET)

#### Announcements & Market Data ⭐
- **`/api/okx/announcements`** - Get OKX announcements with private endpoint authentication (GET)
  - **Parameters:**
    - `annType` - Announcement type (e.g., `announcements-delistings`, `announcements-latest-announcements`)
    - `page` - Page number for pagination (default: 1)
  - **Features:**
    - Full private endpoint authentication using OKX SDK
    - HMAC-SHA256 signature generation
    - Support for all announcement types
    - Real-time market updates and delistings

## 🤖 Automated Trading System ⭐

### Core Automation Features
1. **Delisting Monitoring** - 24/7 monitoring of OKX delisting announcements
2. **Trigger Order Management** - Automated creation and cancellation of trigger orders
3. **Limit Order Management** - Smart cancellation of pending limit orders
4. **Filled Order Tracking** - Real-time monitoring of completed orders with audio alerts
5. **Service Management** - Automated monitoring service restart

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
```

### Automation Scripts

#### `monitor_delist.py`
- **Purpose**: Monitor OKX delisting announcements 24/7
- **Features**: 
  - Real-time delisting detection
  - Automatic service restart on failure
  - Comprehensive logging
  - Error handling and recovery

#### `create_algo_triggers.py`
- **Purpose**: Create automated trigger orders for trading strategies
- **Features**:
  - Grid-based trigger order creation
  - Configurable parameters via `trading_config.json`
  - Smart order placement logic
  - Database integration for order tracking

#### `cancel_pending_triggers.py`
- **Purpose**: Cancel expired or unnecessary trigger orders
- **Features**:
  - Automatic cleanup of old trigger orders
  - Smart cancellation logic
  - Order status verification
  - Logging and monitoring

#### `cancel_pending_limits.py`
- **Purpose**: Manage pending limit orders
- **Features**:
  - Side-specific order cancellation (buy/sell)
  - Configurable cancellation intervals
  - Order status checking
  - Efficient order management

#### `fetch_filled_orders.py`
- **Purpose**: Track completed orders and provide alerts
- **Features**:
  - Real-time order status monitoring
  - Audio alerts for filled orders (10-second beep)
  - Database storage of order history
  - Configurable monitoring intervals

### Configuration Files
- **`trading_config.json`** - Trading strategy configuration
- **`limits.json`** - Limit order management settings
- **`database.db`** - SQLite database for order tracking

### Log Files
- **`cron_restart.log`** - Monitor restart logs
- **`cron_cancel.log`** - Trigger order cancellation logs
- **`cron_create.log`** - Trigger order creation logs
- **`cron_cancel_limits.log`** - Limit order management logs
- **`cron_fetch_orders.log`** - Filled order tracking logs
- **`monitor_20250826.log`** - Daily monitoring logs

## 🔧 Environment Variables

```env
# OKX Production API (required for private endpoints)
OKX_API_KEY=your_production_api_key
OKX_SECRET_KEY=your_production_secret_key
OKX_PASSPHRASE=your_production_passphrase

# OKX Demo Trading API (optional, for testing)
DEMO_OKX_API_KEY=your_demo_api_key
DEMO_OKX_SECRET_KEY=your_demo_secret_key
DEMO_OKX_PASSPHRASE=your_demo_passphrase
```

## 🤖 Trading Strategy

### Core Functions
1. **Place Order** - Execute buy/sell orders with OKX
2. **Cancel Order** - Cancel unfilled or pending orders
3. **Sell Strategy** - Automated selling based on conditions
4. **Automated Monitoring** - 24/7 system monitoring and management
5. **Smart Order Management** - Intelligent order creation and cancellation

### API Usage Examples

#### Place Order
```bash
curl -X POST http://localhost:5000/api/okx/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "instId": "BTC-USDT",
    "tdMode": "cash",
    "side": "buy",
    "ordType": "market",
    "sz": "0.001"
  }'
```

#### Cancel Order
```bash
curl -X POST http://localhost:5000/api/okx/cancel-order \
  -H "Content-Type: application/json" \
  -d '{
    "instId": "BTC-USDT",
    "ordId": "order_id_here"
  }'
```

#### Sell
```bash
curl -X POST http://localhost:5000/api/okx/sell \
  -H "Content-Type: application/json" \
  -d '{
    "instId": "BTC-USDT",
    "amount": "0.001"
  }'
```

#### Get Announcements ⭐
```bash
# Get latest announcements
curl "http://localhost:5000/api/okx/announcements?page=1"

# Get delist announcements
curl "http://localhost:5000/api/okx/announcements?annType=announcements-delistings&page=1"

# Get trading updates
curl "http://localhost:5000/api/okx/announcements?annType=announcements-trading-updates&page=1"
```

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

### Data Format
```json
{
  "success": true,
  "data": {
    "code": "0",
    "data": [{
      "details": [
        {
          "annType": "announcements-delistings",
          "pTime": "1756119600000",
          "title": "OKX to delist perpetual futures for JST crypto",
          "url": "https://www.okx.com/help/..."
        }
      ],
      "totalPage": "90"
    }]
  }
}
```

## 🚀 Deployment

### Local Development
```bash
# Terminal 1: Start Flask API
cd api && python okx_flask.py

# Terminal 2: Start Next.js frontend
npm run dev
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
```

### Vercel Deployment
```bash
# Build and deploy
npm run build
vercel --prod
```

### Vercel Configuration
The `vercel.json` file automatically configures:
- Python 3.9 runtime for Flask API
- API routing for `/api/okx/*` endpoints
- Next.js frontend deployment

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
npm install
pip install -r requirements.txt

# Start Flask API server
cd api && python okx_flask.py

# Test API endpoints
curl "http://localhost:5000/api/okx/health"
curl "http://localhost:5000/api/okx/announcements?page=1"

# Test automation scripts
python monitor_delist.py
python create_algo_triggers.py
python fetch_filled_orders.py

# Run Next.js development server (in another terminal)
npm run dev

# Type checking
npm run type-check

# Build for production
npm run build
```

## 📊 Project Structure

```
crypto/
├── app/                    # Next.js frontend
│   ├── page.tsx           # Main page with API testing
│   ├── layout.tsx         # App layout
│   └── globals.css        # Global styles
├── components/             # React components
│   ├── Dashboard.tsx      # Dashboard component
│   ├── TradingInterface.tsx # Trading interface
│   └── TradeHistory.tsx   # Trade history
├── api/                    # Flask Python API
│   └── okx_flask.py       # OKX trading & announcements API
├── lib/                    # Utility libraries
│   └── database.py        # SQLite database integration
├── requirements.txt        # Python dependencies
├── vercel.json            # Vercel configuration
├── package.json           # Node.js dependencies
├── trading_config.json    # Trading strategy configuration
├── limits.json            # Limit order settings
├── database.db            # SQLite database
├── monitor_delist.py      # Automated delisting monitor
├── create_algo_triggers.py # Automated trigger order creation
├── cancel_pending_triggers.py # Automated trigger order cancellation
├── cancel_pending_limits.py # Automated limit order management
├── fetch_filled_orders.py # Automated filled order tracking
├── restart_monitor.sh     # Monitor restart script
└── cron_*.log            # Automation logs
```

## 🔄 Migration Notes

This project has been migrated from a pure TypeScript/Next.js architecture to a hybrid Next.js + Flask Python approach with comprehensive automation:

- **Removed**: TypeScript OKX client (`lib/okx.ts`)
- **Removed**: Next.js API routes (`app/api/*`)
- **Removed**: Supabase integration (`lib/supabase.ts`)
- **Removed**: Vercel deployment configuration
- **Added**: Flask Python API (`api/okx_flask.py`) with full OKX integration
- **Added**: Python dependencies (`requirements.txt`)
- **Added**: Announcements monitoring with private endpoint authentication
- **Added**: ⭐ Complete monitoring and automation system
- **Added**: SQLite database for local data storage
- **Added**: Automated trading scripts with cron jobs
- **Added**: Real-time order tracking with audio alerts
- **Simplified**: Local development and deployment only

## 📝 License

This project is for educational and personal use. Please ensure compliance with OKX API terms and local trading regulations.
