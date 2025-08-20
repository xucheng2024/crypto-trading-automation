/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 15 no longer needs experimental.appDir
  env: {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    OKX_API_KEY: process.env.OKX_API_KEY,
    OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
    OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
    OKX_TESTNET: process.env.OKX_TESTNET,
    STRATEGY_API_KEY: process.env.STRATEGY_API_KEY,
  },
}

module.exports = nextConfig
