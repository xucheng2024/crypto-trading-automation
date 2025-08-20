import { NextRequest, NextResponse } from 'next/server';
import { OKXClient } from '@/lib/okx';
import { TradingStrategyService, TradingCondition } from '@/lib/trading-strategy';

// Initialize OKX client
const okxClient = new OKXClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
  isTestnet: process.env.OKX_TESTNET === 'true',
});

const strategyService = new TradingStrategyService(okxClient);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, conditions, strategy } = body;

    console.log('Strategy API called:', { action, conditions, strategy });

    // Verify API key for security (optional but recommended)
    const apiKey = request.headers.get('x-api-key');
    if (apiKey !== process.env.STRATEGY_API_KEY) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    switch (action) {
      case 'execute_strategy':
        return await executeStrategy(conditions);
      
      case 'check_conditions':
        return await checkConditions(conditions);
      
      case 'get_market_data':
        return await getMarketData(body.symbols);
      
      case 'run_dca_strategy':
        return await runDCAStrategy(body.config);
      
      case 'run_grid_strategy':
        return await runGridStrategy(body.config);
      
      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Strategy API error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function executeStrategy(conditions: TradingCondition[]) {
  try {
    if (!conditions || !Array.isArray(conditions)) {
      return NextResponse.json(
        { error: 'Invalid conditions format' },
        { status: 400 }
      );
    }

    console.log('Executing strategy with conditions:', conditions);

    const results = await strategyService.executeStrategy(conditions);
    
    // Log results for monitoring
    console.log('Strategy execution results:', results);
    
    return NextResponse.json({
      success: true,
      results,
      timestamp: new Date().toISOString(),
      message: `Executed ${results.length} trading conditions`,
    });
  } catch (error) {
    console.error('Failed to execute strategy:', error);
    return NextResponse.json(
      { 
        error: 'Failed to execute strategy',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function checkConditions(conditions: TradingCondition[]) {
  try {
    if (!conditions || !Array.isArray(conditions)) {
      return NextResponse.json(
        { error: 'Invalid conditions format' },
        { status: 400 }
      );
    }

    const results = [];
    
    for (const condition of conditions) {
      try {
        const shouldExecute = await strategyService['checkCondition'](condition);
        const hasBalance = await strategyService.checkBalance(
          condition.symbol, 
          condition.amount, 
          condition.action
        );
        
        results.push({
          symbol: condition.symbol,
          condition: condition.condition,
          shouldExecute,
          hasBalance,
          action: condition.action,
          amount: condition.amount,
        });
      } catch (error) {
        results.push({
          symbol: condition.symbol,
          condition: condition.condition,
          shouldExecute: false,
          hasBalance: false,
          action: condition.action,
          amount: condition.amount,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    
    return NextResponse.json({
      success: true,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to check conditions:', error);
    return NextResponse.json(
      { 
        error: 'Failed to check conditions',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function getMarketData(symbols: string[]) {
  try {
    if (!symbols || !Array.isArray(symbols)) {
      return NextResponse.json(
        { error: 'Invalid symbols format' },
        { status: 400 }
      );
    }

    const marketData = [];
    
    for (const symbol of symbols) {
      try {
        const data = await strategyService.getMarketData(symbol);
        marketData.push(data);
      } catch (error) {
        marketData.push({
          symbol,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    }
    
    return NextResponse.json({
      success: true,
      marketData,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to get market data:', error);
    return NextResponse.json(
      { 
        error: 'Failed to get market data',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function runDCAStrategy(config: any) {
  try {
    const { symbol, amount, frequency, priceThreshold } = config;
    
    if (!symbol || !amount) {
      return NextResponse.json(
        { error: 'Missing required DCA parameters' },
        { status: 400 }
      );
    }

    // Get current market price
    const instId = symbol.includes('-') ? symbol : `${symbol}-USDT`;
    const currentPrice = await okxClient.getMarketPrice(instId);
    
    // Check if price is below threshold for DCA
    if (priceThreshold && currentPrice > priceThreshold) {
      return NextResponse.json({
        success: true,
        message: 'Price above threshold, skipping DCA',
        currentPrice,
        threshold: priceThreshold,
        timestamp: new Date().toISOString(),
      });
    }

    // Check balance
    const hasBalance = await strategyService.checkBalance(symbol, amount, 'buy');
    if (!hasBalance) {
      return NextResponse.json({
        success: false,
        message: 'Insufficient balance for DCA',
        currentPrice,
        requiredAmount: amount,
        timestamp: new Date().toISOString(),
      });
    }

    // Execute DCA buy
    const orderParams = {
      instId,
      tdMode: 'cash' as const,
      side: 'buy' as const,
      ordType: 'market' as const,
      sz: amount.toString(),
      clOrdId: `dca_${Date.now()}`,
    };

    const response = await okxClient.placeOrder(orderParams);
    
    if (response.data && response.data.length > 0) {
      const orderData = response.data[0];
      
      return NextResponse.json({
        success: true,
        message: 'DCA buy executed successfully',
        orderId: orderData.ordId,
        symbol,
        amount,
        price: currentPrice,
        timestamp: new Date().toISOString(),
      });
    } else {
      throw new Error('No order data received from OKX');
    }
  } catch (error) {
    console.error('Failed to run DCA strategy:', error);
    return NextResponse.json(
      { 
        error: 'Failed to run DCA strategy',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function runGridStrategy(config: any) {
  try {
    const { symbol, gridLevels, totalAmount, priceRange } = config;
    
    if (!symbol || !gridLevels || !totalAmount || !priceRange) {
      return NextResponse.json(
        { error: 'Missing required grid strategy parameters' },
        { status: 400 }
      );
    }

    const { minPrice, maxPrice } = priceRange;
    const currentPrice = await okxClient.getMarketPrice(
      symbol.includes('-') ? symbol : `${symbol}-USDT`
    );
    
    // Check if current price is within grid range
    if (currentPrice < minPrice || currentPrice > maxPrice) {
      return NextResponse.json({
        success: true,
        message: 'Price outside grid range, skipping grid strategy',
        currentPrice,
        gridRange: priceRange,
        timestamp: new Date().toISOString(),
      });
    }

    // Calculate grid levels
    const priceStep = (maxPrice - minPrice) / (gridLevels - 1);
    const amountPerLevel = totalAmount / gridLevels;
    
    const gridOrders = [];
    
    for (let i = 0; i < gridLevels; i++) {
      const gridPrice = minPrice + (i * priceStep);
      
      if (gridPrice <= currentPrice) {
        // Place buy order below current price
        try {
          const orderParams = {
            instId: symbol.includes('-') ? symbol : `${symbol}-USDT`,
            tdMode: 'cash' as const,
            side: 'buy' as const,
            ordType: 'limit' as const,
            sz: amountPerLevel.toString(),
            px: gridPrice.toString(),
            clOrdId: `grid_buy_${i}_${Date.now()}`,
          };

          const response = await okxClient.placeOrder(orderParams);
          if (response.data && response.data.length > 0) {
            gridOrders.push({
              level: i,
              type: 'buy',
              price: gridPrice,
              amount: amountPerLevel,
              orderId: response.data[0].ordId,
            });
          }
        } catch (error) {
          console.error(`Failed to place grid buy order at level ${i}:`, error);
        }
      } else {
        // Place sell order above current price
        try {
          const orderParams = {
            instId: symbol.includes('-') ? symbol : `${symbol}-USDT`,
            tdMode: 'cash' as const,
            side: 'sell' as const,
            ordType: 'limit' as const,
            sz: amountPerLevel.toString(),
            px: gridPrice.toString(),
            clOrdId: `grid_sell_${i}_${Date.now()}`,
          };

          const response = await okxClient.placeOrder(orderParams);
          if (response.data && response.data.length > 0) {
            gridOrders.push({
              level: i,
              type: 'sell',
              price: gridPrice,
              amount: amountPerLevel,
              orderId: response.data[0].ordId,
            });
          }
        } catch (error) {
          console.error(`Failed to place grid sell order at level ${i}:`, error);
        }
      }
      
      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return NextResponse.json({
      success: true,
      message: 'Grid strategy executed successfully',
      gridOrders,
      totalOrders: gridOrders.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to run grid strategy:', error);
    return NextResponse.json(
      { 
        error: 'Failed to run grid strategy',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
