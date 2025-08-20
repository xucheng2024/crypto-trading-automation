# Crypto Trading Automation

A Next.js + Flask Python application for automated crypto trading with OKX exchange integration, featuring algorithmic trading strategies and modern API architecture.

## 🚀 Quick Start

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# Setup environment variables
cp env.example .env.local
# Fill in your OKX API credentials

# Run development server
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
- **`api/okx_flask.py`** - Flask application with OKX trading API endpoints
- **`requirements.txt`** - Python dependencies

### Core API Endpoints
- **`/api/okx/place-order`** - Place trading orders (POST)
- **`/api/okx/cancel-order`** - Cancel existing orders (POST)
- **`/api/okx/sell`** - Execute sell orders (POST)
- **`/api/okx/health`** - API health check (GET)

## 🔧 Environment Variables

```env
# OKX Demo Trading API (for testing)
DEMO_OKX_API_KEY=your_demo_api_key
DEMO_OKX_SECRET_KEY=your_demo_secret_key
DEMO_OKX_PASSPHRASE=your_demo_passphrase

# OKX Production API (for live trading)
OKX_API_KEY=your_production_api_key
OKX_SECRET_KEY=your_production_secret_key
OKX_PASSPHRASE=your_production_passphrase
```

## 🤖 Trading Strategy

### Core Functions
1. **Place Order** - Execute buy/sell orders with OKX
2. **Cancel Order** - Cancel unfilled or pending orders
3. **Sell Strategy** - Automated selling based on conditions

### API Usage Examples

#### Place Order
```bash
curl -X POST /api/okx/place-order \
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
curl -X POST /api/okx/cancel-order \
  -H "Content-Type: application/json" \
  -d '{
    "instId": "BTC-USDT",
    "ordId": "order_id_here"
  }'
```

#### Sell
```bash
curl -X POST /api/okx/sell \
  -H "Content-Type: application/json" \
  -d '{
    "instId": "BTC-USDT",
    "tdMode": "cash",
    "sz": "0.001"
  }'
```

## 🚀 Deployment

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
- Demo trading mode support (`x-simulated-trading` header)
- Input validation and error handling

## 🛠️ Development

```bash
# Install dependencies
npm install
pip install -r requirements.txt

# Run development server
npm run dev

# Test Flask API locally
cd api
python okx_flask.py

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
│   └── okx_flask.py       # OKX trading API
├── requirements.txt        # Python dependencies
├── vercel.json            # Vercel configuration
└── package.json           # Node.js dependencies
```

## 🔄 Migration Notes

This project has been migrated from a pure TypeScript/Next.js architecture to a hybrid Next.js + Flask Python approach:

- **Removed**: TypeScript OKX client (`lib/okx.ts`)
- **Removed**: Next.js API routes (`app/api/*`)
- **Added**: Flask Python API (`api/okx_flask.py`)
- **Added**: Python dependencies (`requirements.txt`)
- **Updated**: Vercel configuration for Python support

## 📝 License

This project is for educational and personal use. Please ensure compliance with OKX API terms and local trading regulations.
