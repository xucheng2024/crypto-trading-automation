# Crypto Trading Automation

A Next.js application for automated crypto trading with OKX exchange integration, featuring algorithmic trading strategies and GitHub Actions automation.

## 🚀 Quick Start

```bash
npm install
cp env.example .env.local
# Fill in your environment variables
npm run dev
```

## 📁 Project Structure

### Core Application
- **`app/page.tsx`** - Main dashboard page
- **`components/Dashboard.tsx`** - Main dashboard component
- **`components/PortfolioOverview.tsx`** - Portfolio display
- **`components/TradingInterface.tsx`** - Trading interface
- **`components/TradeHistory.tsx`** - Trade history display

### API Endpoints
- **`app/api/algo-buy/route.ts`** - Algorithmic buying strategy (sets trigger orders)
- **`app/api/cancel-orders/route.ts`** - Cancels unfilled trigger orders
- **`app/api/market-sell/route.ts`** - Automated selling strategy (checks and sells when needed)

### Core Libraries
- **`lib/okx.ts`** - OKX API client with enterprise-grade stability features
- **`services/trading/algo-buy.service.ts`** - Algorithmic buying logic and strategy execution
- **`services/trading/trading-strategy.service.ts`** - Trading strategy service (DCA, grid trading)
- **`lib/supabase.ts`** - Supabase database client

### Automation
- **`.github/workflows/crypto-trading.yml`** - GitHub Actions workflow for automated trading
- **`trading_config.json`** - Trading strategy configuration

### Types
- **`types/trading.ts`** - TypeScript interfaces for trading data
- **`types/opossum.d.ts`** - Type definitions for circuit breaker library

## 🔧 Environment Variables

```env
# OKX API (Production)
OKX_API_KEY=your_okx_api_key
OKX_SECRET_KEY=your_okx_secret_key
OKX_PASSPHRASE=your_okx_passphrase
OKX_TESTNET=false

# Strategy API Key (for GitHub Actions)
STRATEGY_API_KEY=your_strategy_api_key

# Vercel API Endpoint (for GitHub Actions)
VERCEL_API_ENDPOINT=https://your-app.vercel.app

# Supabase (if using database features)
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## 🤖 Automated Trading Strategy

### Daily Schedule
- **🟢 0:03 UTC** - Execute buy strategy (sets trigger orders)
- **🔴 23:57 UTC** - Cancel unfilled trigger orders
- **🟡 Every 5 minutes** - Check and execute sell strategy

### Strategy Logic
1. **Buy Strategy** - Places trigger orders for cryptocurrencies based on configuration
2. **Cancel Strategy** - Removes unfilled orders to free up capital
3. **Sell Strategy** - Monitors positions and sells based on profit/loss thresholds

## 🛡️ Stability Features

### Circuit Breaker Pattern
- Automatic failure detection and recovery
- Prevents system overload during API failures
- Configurable thresholds and timeouts

### Retry Mechanism
- Exponential backoff retry strategy
- Smart retry conditions (network errors + 5xx responses)
- Configurable retry attempts and delays

### Error Handling
- Comprehensive error classification
- Detailed logging and monitoring
- Graceful degradation

## 📊 Trading Configuration

The `trading_config.json` file contains:
- Cryptocurrency symbols and limits
- Expected return percentages
- Trading frequency settings
- Strategy parameters

## 🚀 Deployment

### Vercel Deployment
```bash
npm run build
vercel --prod
```

### GitHub Actions Setup
1. Add repository secrets:
   - `OKX_API_KEY`
   - `OKX_SECRET_KEY` 
   - `OKX_PASSPHRASE`
   - `STRATEGY_API_KEY`
   - `VERCEL_API_ENDPOINT`

2. Workflow automatically runs:
   - Daily at 0:03 UTC (buy strategy)
   - Daily at 23:57 UTC (cancel orders)
   - Every 5 minutes (sell strategy)

## 🔒 Security Features

- API key authentication for all endpoints
- HMAC-SHA256 signature for OKX API calls
- Environment variable protection
- Rate limiting and timeout controls

## 📈 Monitoring

- Comprehensive logging for all operations
- Circuit breaker status monitoring
- Performance metrics and error tracking
- GitHub Actions execution logs

## 🛠️ Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Type checking
npm run type-check

# Build for production
npm run build
```

## 📝 License

This project is for educational and personal use. Please ensure compliance with OKX API terms and local trading regulations.
