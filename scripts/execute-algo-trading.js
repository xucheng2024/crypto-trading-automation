#!/usr/bin/env node

/**
 * Execute Algorithmic Trading Orders
 * WARNING: This will place REAL orders on OKX exchange
 * Run with: npm run execute:algo
 */

require('dotenv').config({ path: '.env.local' });

const https = require('https');

async function executeAlgoTrading() {
  console.log('🚀 Executing Algorithmic Trading Orders...\n');
  console.log('⚠️  WARNING: This will place REAL orders on OKX exchange!\n');

  try {
    // Check environment variables
    console.log('🔑 Environment variables check:');
    console.log(`   Strategy API Key: ${process.env.STRATEGY_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`   OKX API Key: ${process.env.OKX_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`   Testnet mode: ${process.env.OKX_TESTNET === 'true' ? 'ON' : 'OFF'}\n`);

    if (!process.env.STRATEGY_API_KEY) {
      console.log('❌ Missing STRATEGY_API_KEY');
      return;
    }

    if (!process.env.OKX_API_KEY) {
      console.log('❌ Missing OKX API credentials');
      return;
    }

    // Confirm execution
    console.log('📋 Strategy Summary:');
    console.log('   - Will place trigger orders for ALL 29 cryptocurrencies');
    console.log('   - Each order uses FULL available balance');
    console.log('   - Orders are LIMIT orders at calculated trigger prices');
    console.log('   - Orders execute when price drops to trigger level\n');

    // Ask for confirmation
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise((resolve) => {
      rl.question('❓ Are you sure you want to execute? Type "YES" to confirm: ', resolve);
    });
    rl.close();

    if (answer !== 'YES') {
      console.log('❌ Execution cancelled');
      return;
    }

    console.log('\n🎯 Executing algorithmic trading strategy...');

    // Call the API endpoint
    const response = await makeRequest('/api/algo-trading', 'POST', {
      'x-api-key': process.env.STRATEGY_API_KEY
    });

    if (response.success) {
      console.log('✅ Algorithmic trading executed successfully!');
      console.log('\n📊 Execution Summary:');
      console.log(`   Total Orders: ${response.summary.totalOrders}`);
      console.log(`   Successful: ${response.summary.successfulOrders}`);
      console.log(`   Failed: ${response.summary.failedOrders}`);
      console.log(`   Total Value: $${response.summary.totalValue.toFixed(2)}`);
      console.log(`   Execution Time: ${response.summary.executionTime}`);
      
      if (response.summary.orders.length > 0) {
        console.log('\n📝 Order Details:');
        response.summary.orders.forEach((order, index) => {
          const status = order.success ? '✅' : '❌';
          console.log(`   ${index + 1}. ${order.symbol}: ${status} ${order.message}`);
          if (order.success) {
            console.log(`      Order ID: ${order.orderId}`);
            console.log(`      Trigger Price: $${order.triggerPrice.toFixed(4)}`);
            console.log(`      Amount: ${order.amount.toFixed(8)}`);
          }
        });
      }
    } else {
      console.log('❌ Algorithmic trading failed:', response.error);
    }

  } catch (error) {
    console.error('\n💥 Execution failed:', error.message);
    console.error('\nMake sure you have:');
    console.error('1. Valid STRATEGY_API_KEY');
    console.error('2. Valid OKX API credentials');
    console.error('3. Development server running (npm run dev)');
    console.error('4. Sufficient balance in your OKX account');
  }
}

function makeRequest(endpoint, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
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

// Run the execution
executeAlgoTrading();
