# Environment Variables Configuration Guide

## Required Environment Variables

### 1. Neon PostgreSQL Database
```bash
export DATABASE_URL="postgresql://neondb_owner:npg_F4epMLXJ8ity@ep-wispy-smoke-a1qg30ip-pooler.ap-southeast-1.aws.neon.tech/crypto_trading?sslmode=require&channel_binding=require"
```

### 2. OKX API Credentials
```bash
export OKX_API_KEY="your_okx_api_key"
export OKX_SECRET_KEY="your_okx_secret_key"
export OKX_PASSPHRASE="your_okx_passphrase"
```

### 3. OKX Trading Environment
```bash
export OKX_TESTNET="false"  # false=Live trading, true=Demo trading
```

## Local Testing

### 1. Set Environment Variables
```bash
# Copy the environment variables above, replace with your actual values
export DATABASE_URL="your_neon_connection_string"
export OKX_API_KEY="your_api_key"
export OKX_SECRET_KEY="your_secret_key"
export OKX_PASSPHRASE="your_passphrase"
export OKX_TESTNET="false"
```

### 2. Test Database Connection
```bash
python -c "from lib.database import Database; db = Database(); db.connect(); db.create_tables(); db.disconnect()"
```

### 3. Test Complete System
```bash
python monitor_delist.py
python fetch_filled_orders.py
python auto_sell_orders.py
```

## GitHub Actions Configuration

In your GitHub repository's Settings > Secrets and variables > Actions, add:

- `DATABASE_URL`: Your Neon connection string
- `OKX_API_KEY`: Your OKX API key
- `OKX_SECRET_KEY`: Your OKX secret key
- `OKX_PASSPHRASE`: Your OKX passphrase

## Important Notes

1. **Do not commit .env file** to Git
2. **DATABASE_URL must** start with `postgresql://`
3. **All environment variables are required**
4. **Local development** requires setting environment variables
5. **GitHub Actions** will automatically read from Secrets
