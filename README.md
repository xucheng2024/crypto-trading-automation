# Crypto Trading Dashboard

A Next.js application for managing crypto trades, monitoring portfolio performance, and automating trading strategies using the OKX exchange.

## Features

- **Portfolio Overview**: Real-time display of holdings and total value
- **Trading Interface**: Buy/sell orders with form validation
- **Trade History**: Complete record of all trading activities
- **Automated Trading**: GitHub Actions cron jobs for strategy execution
- **OKX Integration**: Direct integration with OKX exchange API
- **Supabase Integration**: Secure data storage and real-time updates

## Tech Stack

- **Frontend**: Next.js 15.5.0, React 18.3.0, TypeScript
- **Styling**: Tailwind CSS with custom components
- **Database**: Supabase (PostgreSQL)
- **Exchange**: OKX API (custom implementation with HMAC-SHA256)
- **Deployment**: Vercel
- **Automation**: GitHub Actions
- **Forms**: React Hook Form with Zod validation
- **Icons**: Lucide React
- **Notifications**: React Hot Toast
- **State Management**: Zustand, SWR
- **Charts**: Recharts

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Supabase account
- OKX account with API access
- Vercel account (for deployment)

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd crypto-trading-app
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp env.example .env.local
```

Fill in your environment variables:
```env
# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# OKX API Configuration
OKX_API_KEY=your_okx_api_key
OKX_SECRET_KEY=your_okx_secret_key
OKX_PASSPHRASE=your_okx_passphrase
OKX_TESTNET=false

# Strategy API Security
STRATEGY_API_KEY=your_strategy_api_key
```

4. Run the development server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

### OKX API Setup

1. **Create OKX Account**: Sign up at [okx.com](https://www.okx.com)

2. **Generate API Keys**:
   - Go to Account → API Management
   - Create new API key
   - Enable trading permissions
   - Set IP restrictions for security
   - Save your API key, secret key, and passphrase

3. **Test API Connection**:
```bash
npm run test:okx
```

4. **API Permissions Required**:
   - Read account information
   - Place/cancel orders
   - View trading history
   - Access market data

**Important Note**: If your passphrase contains special characters (like `！`), you may encounter header validation issues. The current implementation handles this automatically.

### Database Setup

Create the following tables in Supabase:

#### Trades Table
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

#### Portfolio Table
```sql
CREATE TABLE portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  amount DECIMAL NOT NULL,
  avg_price DECIMAL NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Deployment

1. Push your code to GitHub
2. Connect your repository to Vercel
3. Set environment variables in Vercel dashboard
4. Deploy automatically on push

### GitHub Actions Setup

1. Add the following secrets to your GitHub repository:
   - `OKX_API_KEY`
   - `OKX_SECRET_KEY`
   - `OKX_PASSPHRASE`
   - `OKX_TESTNET`
   - `STRATEGY_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `API_ENDPOINT` (your deployed API URL)

2. The workflow will run automatically every 15 minutes during market hours

## API Endpoints

### OKX Trading API (`/api/okx-trading`)
- `POST`: Place orders, cancel orders, sell assets
- Supports market and limit orders
- Automatic portfolio updates
- HMAC-SHA256 signature authentication

### Strategy API (`/api/strategy`)
- `POST`: Execute automated trading strategies
- DCA (Dollar Cost Averaging) strategy
- Grid trading strategy
- Custom condition-based strategies
- API key authentication required

### Portfolio API (`/api/portfolio`)
- `GET`: Get current portfolio holdings
- `POST`: Update portfolio after trades

## Trading Strategies

### DCA Strategy
Automatically buy crypto when price drops below a threshold:
```json
{
  "action": "run_dca_strategy",
  "config": {
    "symbol": "BTC",
    "amount": 0.001,
    "priceThreshold": 45000
  }
}
```

### Grid Strategy
Place multiple buy/sell orders at different price levels:
```json
{
  "action": "run_grid_strategy",
  "config": {
    "symbol": "BTC",
    "gridLevels": 5,
    "totalAmount": 0.005,
    "priceRange": {
      "minPrice": 40000,
      "maxPrice": 50000
    }
  }
}
```

## Project Structure

```
├── app/                    # Next.js app directory
│   ├── api/               # API routes
│   │   ├── okx-trading/   # OKX trading endpoints
│   │   └── strategy/      # Strategy execution
│   ├── globals.css        # Global styles
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Home page
├── components/             # React components
│   ├── Dashboard.tsx      # Main dashboard
│   ├── PortfolioOverview.tsx
│   ├── TradingInterface.tsx
│   └── TradeHistory.tsx
├── lib/                    # Utility libraries
│   ├── okx.ts             # Custom OKX API client
│   ├── trading-strategy.ts # Strategy service
│   └── supabase.ts        # Supabase client
├── types/                  # TypeScript types
│   └── trading.ts
├── scripts/                # Utility scripts
│   └── test-okx.js        # OKX API test script
├── .github/workflows/      # GitHub Actions
└── public/                 # Static assets
```

## Testing

### Test OKX Integration
```bash
npm run test:okx
```

This will:
- Test API connection
- Verify market data access
- Check account balance (if not testnet)
- Validate order book retrieval
- Test HMAC-SHA256 signature generation

### Available Scripts
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run type-check` - Run TypeScript type checking
- `npm run test:okx` - Test OKX API integration

## Troubleshooting

### Common Issues

1. **Build Errors**: Ensure all environment variables are set in `.env.local`
2. **OKX API Errors**: Check API key permissions and IP restrictions
3. **Passphrase Issues**: Special characters in passphrase are handled automatically
4. **Database Connection**: Verify Supabase credentials and table structure

### Debug Mode

Enable detailed logging by setting `NODE_ENV=development` in your environment.

## Security Features

- API key authentication for strategy endpoints
- IP restrictions on OKX API keys
- Environment variable protection
- Rate limiting and error handling
- Comprehensive logging for debugging
- HMAC-SHA256 signature verification
- Server-side API key storage

## Recent Updates

- **Next.js 15.5.0**: Updated to latest stable version
- **React 18.3.0**: Latest React version with improved performance
- **Custom OKX Client**: Replaced external SDKs with reliable custom implementation
- **Enhanced Error Handling**: Better error messages and debugging information
- **Improved Testing**: Dedicated test script for OKX API integration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License.
