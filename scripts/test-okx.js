#!/usr/bin/env node

/**
 * Test script for OKX API integration
 * Run with: npm run test:okx
 */

require('dotenv').config({ path: '.env.local' });

// Since we can't import TypeScript directly, let's test the API endpoints instead
const https = require('https');

async function testOKXIntegration() {
  console.log('🧪 Testing OKX API Integration...\n');

  try {
    // Check environment variables
    console.log('✅ Environment variables loaded');
    console.log(`📊 Testnet mode: ${process.env.OKX_TESTNET === 'true' ? 'ON' : 'OFF'}`);
    console.log(`🔑 API Key: ${process.env.OKX_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`🔐 Secret Key: ${process.env.OKX_SECRET_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`🔓 Passphrase: ${process.env.OKX_PASSPHRASE ? '✅ Set' : '❌ Missing'}`);
    console.log(`🔓 Passphrase value: "${process.env.OKX_PASSPHRASE}"\n`);

    if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
      console.log('❌ Missing required OKX credentials');
      return;
    }

    // Test public market data (no authentication required)
    console.log('📈 Testing public market data...');
    try {
      const marketData = await makePublicRequest('/api/v5/market/ticker?instId=BTC-USDT');
      if (marketData && marketData.data && marketData.data.length > 0) {
        const btcPrice = parseFloat(marketData.data[0].last);
        console.log(`✅ BTC price: $${btcPrice.toLocaleString()}`);
      }
    } catch (error) {
      console.log(`❌ Failed to get market data: ${error.message}`);
    }

    // Test authenticated endpoint with exact passphrase (no encoding)
    console.log('\n💰 Testing authenticated endpoint (exact passphrase)...');
    try {
      const balanceData = await makeAuthenticatedRequest('/api/v5/account/balance');
      if (balanceData && balanceData.code === '0') {
        console.log('✅ Authentication successful!');
        console.log('✅ Balance endpoint accessible');
        showBalanceInfo(balanceData);
      } else {
        console.log(`❌ Authentication failed: ${balanceData.msg || 'Unknown error'} (Code: ${balanceData.code})`);
      }
    } catch (error) {
      console.log(`❌ Authentication test failed: ${error.message}`);
    }

    // Test order book
    console.log('\n📚 Testing order book...');
    try {
      const orderBookData = await makePublicRequest('/api/v5/market/books?instId=BTC-USDT&sz=5');
      if (orderBookData && orderBookData.data && orderBookData.data.length > 0) {
        console.log('✅ Order book retrieved successfully');
        const book = orderBookData.data[0];
        if (book.bids && book.asks) {
          console.log(`   Top 3 bids: ${book.bids.slice(0, 3).map(bid => `$${bid[0]}`).join(', ')}`);
          console.log(`   Top 3 asks: ${book.asks.slice(0, 3).map(ask => `$${ask[0]}`).join(', ')}`);
        }
      }
    } catch (error) {
      console.log(`❌ Failed to get order book: ${error.message}`);
    }

    console.log('\n🎉 OKX API test completed!');

  } catch (error) {
    console.error('\n💥 Test failed:', error.message);
    console.error('\nMake sure you have:');
    console.error('1. Valid OKX API key, secret, and passphrase');
    console.error('2. Proper permissions for your OKX API key');
    console.error('3. Network access to OKX API');
  }
}

function showBalanceInfo(balanceData) {
  if (balanceData.data && balanceData.data.length > 0) {
    console.log('📊 Account balances:');
    balanceData.data.slice(0, 5).forEach(balance => {
      if (parseFloat(balance.availBal) > 0) {
        console.log(`   ${balance.ccy}: ${parseFloat(balance.availBal).toFixed(4)} (Available: ${parseFloat(balance.availBal).toFixed(4)})`);
      }
    });
  } else {
    console.log('📊 No balance data or empty balances (normal for demo accounts)');
  }
}

function makePublicRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.okx.com',
      port: 443,
      path: endpoint,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

function makeAuthenticatedRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString();
    const method = 'GET';
    const requestPath = endpoint;
    
    // Generate signature
    const crypto = require('crypto');
    const message = timestamp + method + requestPath;
    const signature = crypto
      .createHmac('sha256', process.env.OKX_SECRET_KEY)
      .update(message)
      .digest('base64');

    // Use passphrase exactly as-is (no encoding) per OKX documentation
    const passphrase = process.env.OKX_PASSPHRASE;

    const options = {
      hostname: 'www.okx.com',
      port: 443,
      path: endpoint,
      method: method,
      headers: {
        'OK-ACCESS-KEY': process.env.OKX_API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': passphrase,
        'Content-Type': 'application/json'
      }
    };

    // Add demo trading header if testnet
    if (process.env.OKX_TESTNET === 'true') {
      options.headers['x-simulated-trading'] = '1';
    }

    console.log(`🔐 Request headers (for debugging):`);
    console.log(`   OK-ACCESS-KEY: ${options.headers['OK-ACCESS-KEY']}`);
    console.log(`   OK-ACCESS-PASSPHRASE: "${options.headers['OK-ACCESS-PASSPHRASE']}"`);
    console.log(`   x-simulated-trading: ${options.headers['x-simulated-trading'] || 'not set'}`);

    // Remove headers from options to avoid header validation issues
    const requestOptions = {
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: options.method
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    // Set headers after creating request to handle special characters
    req.setHeader('OK-ACCESS-KEY', process.env.OKX_API_KEY);
    req.setHeader('OK-ACCESS-SIGN', signature);
    req.setHeader('OK-ACCESS-TIMESTAMP', timestamp);
    req.setHeader('OK-ACCESS-PASSPHRASE', passphrase);
    req.setHeader('Content-Type', 'application/json');
    
    if (process.env.OKX_TESTNET === 'true') {
      req.setHeader('x-simulated-trading', '1');
    }

    req.end();
  });
}

// Run the test
testOKXIntegration();
