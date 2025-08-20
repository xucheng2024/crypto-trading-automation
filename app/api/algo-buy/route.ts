import { NextRequest, NextResponse } from 'next/server';
import { OKXClient } from '@/lib/okx';
import { AlgoTradingService } from '@/services/trading/algo-buy.service';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Algo Trading API endpoint called');
    
    // Check API key for security
    const apiKey = request.headers.get('x-api-key');
    const expectedApiKey = process.env.STRATEGY_API_KEY;
    
    console.log('🔑 API Key Debug:');
    console.log('   Received API key:', apiKey ? `${apiKey.substring(0, 20)}...` : 'NOT PROVIDED');
    console.log('   Expected API key:', expectedApiKey ? `${expectedApiKey.substring(0, 20)}...` : 'NOT SET');
    console.log('   Environment check:', {
      NODE_ENV: process.env.NODE_ENV,
      STRATEGY_API_KEY_EXISTS: !!process.env.STRATEGY_API_KEY,
      STRATEGY_API_KEY_LENGTH: process.env.STRATEGY_API_KEY?.length
    });
    
    if (!expectedApiKey || apiKey !== expectedApiKey) {
      console.log('❌ Invalid or missing API key');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Load trading configuration
    const configPath = path.join(process.cwd(), 'trading_config.json');
    const tradingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    console.log('📋 Trading configuration loaded successfully');

    // Initialize OKX client
    const okxClient = new OKXClient({
      apiKey: process.env.DEMO_OKX_API_KEY || process.env.OKX_API_KEY!,
      secretKey: process.env.DEMO_OKX_SECRET_KEY || process.env.OKX_SECRET_KEY!,
      passphrase: process.env.DEMO_OKX_PASSPHRASE || process.env.OKX_PASSPHRASE!,
      isTestnet: process.env.OKX_TESTNET === 'true',
    });

    // Test connection
    console.log('🔗 Testing OKX connection...');
    try {
      const isConnected = await okxClient.testConnection();
      console.log('✅ OKX connection test result:', isConnected);
      if (!isConnected) {
        throw new Error('Failed to connect to OKX API');
      }
    } catch (error) {
      console.error('❌ OKX connection test failed:', error);
      throw new Error(`OKX connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    console.log('✅ OKX connection established');

    // Initialize algorithmic trading service
    const algoService = new AlgoTradingService(okxClient, tradingConfig);
    
    // Execute algorithmic buy orders
    console.log('🎯 Executing algorithmic buy orders...');
    const results = await algoService.executeAlgoBuyOrders();
    
    // Calculate summary
    const successfulOrders = results.filter(r => r.success);
    const failedOrders = results.filter(r => !r.success);
    const totalValue = successfulOrders.reduce((sum, order) => sum + (order.amount * order.triggerPrice), 0);
    
    const summary = {
      totalOrders: results.length,
      successfulOrders: successfulOrders.length,
      failedOrders: failedOrders.length,
      totalValue: totalValue,
      executionTime: new Date().toISOString(),
      orders: results,
    };
    
    console.log('✅ Algorithmic trading execution completed');
    console.log(`📊 Summary: ${successfulOrders.length}/${results.length} orders successful`);
    console.log(`💰 Total value: $${totalValue.toFixed(2)}`);
    
    return NextResponse.json({
      success: true,
      message: 'Algorithmic trading orders executed successfully',
      summary,
    });

  } catch (error) {
    console.error('💥 Algo trading API error:', error);
    
    return NextResponse.json(
      { 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}


