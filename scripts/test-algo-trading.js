#!/usr/bin/env node

/**
 * Test script for Algorithmic Trading Service
 * Run with: npm run test:algo
 */

require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');

async function testAlgoTrading() {
  console.log('🧪 Testing Algorithmic Trading Service...\n');

  try {
    // Load trading configuration
    const configPath = path.join(__dirname, '..', 'trading_config.json');
    const tradingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    console.log('📋 Trading configuration loaded:');
    console.log(`   Total cryptocurrencies: ${Object.keys(tradingConfig.cryptocurrencies).length}`);
    console.log(`   Strategy type: ${tradingConfig.strategy_type}`);
    console.log(`   Timeframe: ${tradingConfig.timeframe}\n`);

    // Check environment variables
    console.log('🔑 Environment variables check:');
    console.log(`   OKX API Key: ${process.env.OKX_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`   OKX Secret Key: ${process.env.OKX_SECRET_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`   OKX Passphrase: ${process.env.OKX_PASSPHRASE ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Testnet mode: ${process.env.OKX_TESTNET === 'true' ? 'ON' : 'OFF'}\n`);

    if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
      console.log('❌ Missing required OKX credentials');
      return;
    }

    // Show crypto configuration summary
    console.log('📊 Cryptocurrency Configuration Summary:');
    const cryptos = Object.entries(tradingConfig.cryptocurrencies);
    
    // Sort by expected return (highest first)
    cryptos.sort(([,a], [,b]) => b.expected_return - a.expected_return);
    
    cryptos.slice(0, 10).forEach(([symbol, config]) => {
      console.log(`   ${symbol.padEnd(12)} | Limit: ${config.limit.padStart(2)}% | Return: ${config.expected_return.toFixed(2)}x | Duration: ${config.duration.padStart(2)}d`);
    });
    
    if (cryptos.length > 10) {
      console.log(`   ... and ${cryptos.length - 10} more cryptocurrencies`);
    }

    console.log('\n🎯 Strategy Logic:');
    console.log('   For each cryptocurrency:');
    console.log('   1. Get current market price (as day open)');
    console.log('   2. Calculate trigger price = current price × (limit/100)');
    console.log('   3. Place limit buy order at trigger price');
    console.log('   4. Use FULL balance amount for each crypto');
    console.log('   5. Order will execute when price drops to trigger level');

    console.log('\n⚠️  IMPORTANT NOTES:');
    console.log('   - This will place orders for ALL cryptocurrencies in the config');
    console.log('   - Each order uses the FULL available balance');
    console.log('   - Orders are LIMIT orders (not market orders)');
    console.log('   - Orders will only execute when price reaches trigger level');
    console.log('   - This is a DRY RUN - no actual orders will be placed');

    console.log('\n🚀 Ready to execute algorithmic trading strategy!');
    console.log('   To actually place orders, you would call:');
    console.log('   const algoService = new AlgoTradingService(okxClient, tradingConfig);');
    console.log('   const results = await algoService.executeAlgoBuyOrders();');

  } catch (error) {
    console.error('\n💥 Test failed:', error.message);
    console.error('\nMake sure you have:');
    console.error('1. Valid trading_config.json file');
    console.error('2. All required environment variables set');
    console.error('3. Proper OKX API permissions');
  }
}

// Run the test
testAlgoTrading();
