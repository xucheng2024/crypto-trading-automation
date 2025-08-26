# Crypto Trading Automation

A Next.js + Flask Python application for automated crypto trading with OKX exchange integration, featuring algorithmic trading strategies, announcements monitoring, and modern API architecture.

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
│   └── supabase.ts        # Database integration
├── requirements.txt        # Python dependencies
├── vercel.json            # Vercel configuration
└── package.json           # Node.js dependencies
```

## 🔄 Migration Notes

This project has been migrated from a pure TypeScript/Next.js architecture to a hybrid Next.js + Flask Python approach:

- **Removed**: TypeScript OKX client (`lib/okx.ts`)
- **Removed**: Next.js API routes (`app/api/*`)
- **Removed**: Supabase integration (`lib/supabase.ts`)
- **Removed**: Vercel deployment configuration
- **Added**: Flask Python API (`api/okx_flask.py`) with full OKX integration
- **Added**: Python dependencies (`requirements.txt`)
- **Added**: Announcements monitoring with private endpoint authentication
- **Added**: ⭐ Complete monitoring and automation system
- **Added**: SQLite database for local data storage
- **Simplified**: Local development and deployment only

## 📝 License

This project is for educational and personal use. Please ensure compliance with OKX API terms and local trading regulations.
