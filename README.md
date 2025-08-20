# Crypto Trading Dashboard

A Next.js application for crypto trading with OKX exchange integration, portfolio management, and automated trading strategies.

## Quick Start

```bash
npm install
cp env.example .env.local
# Fill in your environment variables
npm run dev
```

## Project Structure

### Core Files
- **`app/page.tsx`** - Main dashboard page
- **`components/Dashboard.tsx`** - Main dashboard component with portfolio, trading interface, and trade history
- **`components/PortfolioOverview.tsx`** - Portfolio display and management
- **`components/TradingInterface.tsx`** - Buy/sell order interface
- **`components/TradeHistory.tsx`** - Trade history display

### API Routes
- **`app/api/okx-trading/route.ts`** - OKX trading operations (place/cancel orders, get balance, market data)
- **`app/api/portfolio/route.ts`** - Portfolio data management
- **`app/api/trading/route.ts`** - Trade history and management
- **`app/api/strategy/route.ts`** - Automated trading strategy execution
- **`app/api/algo-buy/route.ts`** - Algorithmic buying endpoints

### Core Libraries
- **`lib/okx.ts`** - OKX API client with HMAC-SHA256 authentication
- **`lib/trading-strategy.ts`** - Trading strategy service (DCA, grid trading)
- **`lib/algo-buy.ts`** - Algorithmic buying logic
- **`lib/supabase.ts`** - Supabase database client

### Types
- **`types/trading.ts`** - TypeScript interfaces for trades, portfolio, and trading data

### Testing
- **`scripts/test-okx.js`** - Test OKX API connection and functionality
- **`scripts/test-okx-connection.js`** - Basic OKX connection test

## Environment Variables

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

# OKX API (Production)
OKX_API_KEY=your_okx_api_key
OKX_SECRET_KEY=your_okx_secret_key
OKX_PASSPHRASE=your_okx_passphrase
OKX_TESTNET=false

# OKX API (Demo Environment)
DEMO_OKX_API_KEY=your_demo_okx_api_key
DEMO_OKX_SECRET_KEY=your_demo_okx_secret_key
DEMO_OKX_PASSPHRASE=your_demo_okx_passphrase
OKX_TESTNET=true

# Strategy API
STRATEGY_API_KEY=your_strategy_api_key

# Optional: Vercel Analytics
NEXT_PUBLIC_VERCEL_ANALYTICS_ID=your_vercel_analytics_id
```

**Note**: The app automatically uses demo credentials when `DEMO_OKX_*` variables are set, falling back to production credentials if demo variables are not available.

## Database Schema

### Trades Table
```sql
CREATE TABLE trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  amount DECIMAL NOT NULL,
  price DECIMAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Portfolio Table
```sql
CREATE TABLE portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  amount DECIMAL NOT NULL,
  avg_price DECIMAL NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Key Features

- **Portfolio Management** - Real-time holdings and value tracking
- **Trading Interface** - Buy/sell orders with validation
- **OKX Integration** - Direct API access with secure authentication
- **Automated Strategies** - DCA and grid trading strategies
- **Real-time Updates** - Live portfolio and trade data

## Available Scripts

- `npm run dev` - Development server
- `npm run build` - Production build
- `npm run start` - Production server
- `npm run test:okx` - Test OKX API integration
- `npm run type-check` - TypeScript type checking

## Development Workflow

1. **Setup** - Install dependencies and configure environment variables
2. **Database** - Create required tables in Supabase
3. **OKX API** - Generate API keys and test connection
4. **Development** - Use `npm run dev` for local development
5. **Testing** - Test OKX integration with `npm run test:okx`

## Tech Stack

- **Frontend**: Next.js 15.5.0, React 18.3.0, TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **Exchange**: OKX API (custom implementation)
- **State**: Zustand, SWR
- **Forms**: React Hook Form + Zod
- **Charts**: Recharts
