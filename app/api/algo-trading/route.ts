import { NextRequest, NextResponse } from 'next/server';
import { OKXClient } from '@/lib/okx';
import { AlgoTradingService } from '@/lib/algo-trading';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Algo Trading API endpoint called');
    
    // Check API key for security
    const apiKey = request.headers.get('x-api-key');
    const expectedApiKey = process.env.STRATEGY_API_KEY;
    
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
      apiKey: process.env.OKX_API_KEY!,
      secretKey: process.env.OKX_SECRET_KEY!,
      passphrase: process.env.OKX_PASSPHRASE!,
      isTestnet: process.env.OKX_TESTNET === 'true',
    });

    // Test connection
    const isConnected = await okxClient.testConnection();
    if (!isConnected) {
      throw new Error('Failed to connect to OKX API');
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

export async function GET() {
  try {
    // Load trading configuration for info
    const configPath = path.join(process.cwd(), 'trading_config.json');
    const tradingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    const cryptos = Object.entries(tradingConfig.cryptocurrencies);
    
    // Sort by expected return (highest first)
    cryptos.sort(([,a], [,b]) => b.expected_return - a.expected_return);
    
    return NextResponse.json({
      success: true,
      config: {
        totalCryptocurrencies: cryptos.length,
        strategyType: tradingConfig.strategy_type,
        timeframe: tradingConfig.timeframe,
        topOpportunities: cryptos.slice(0, 10).map(([symbol, config]) => ({
          symbol,
          limit: config.limit,
          expectedReturn: config.expected_return,
          duration: config.duration,
        })),
      },
    });
    
  } catch (error) {
    console.error('💥 Failed to get algo trading info:', error);
    
    return NextResponse.json(
      { 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
