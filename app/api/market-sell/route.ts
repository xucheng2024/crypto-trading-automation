import { NextRequest, NextResponse } from 'next/server';
import { OKXClient } from '@/lib/okx';

export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Market Sell API endpoint called');
    
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

    // Initialize OKX client
    const okxClient = new OKXClient({
      apiKey: process.env.OKX_API_KEY!,
      secretKey: process.env.OKX_SECRET_KEY!,
      passphrase: process.env.OKX_PASSPHRASE!,
      isTestnet: process.env.OKX_TESTNET === 'true',
    });

    // Test connection
    console.log('🔗 Testing OKX connection...');
    try {
      const isConnected = await okxClient.testConnection();
      if (!isConnected) {
        throw new Error('Failed to connect to OKX API');
      }
    } catch (error) {
      console.error('❌ OKX connection test failed:', error);
      throw new Error(`OKX connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    console.log('✅ OKX connection established');

    // Get current positions
    console.log('📊 Getting current positions...');
    const positions = await okxClient.getPositions();
    
    if (!positions || positions.length === 0) {
      console.log('ℹ️ No positions found');
      return NextResponse.json({
        success: true,
        message: 'No positions to sell',
        soldAmount: 0,
        summary: {
          totalPositions: 0,
          soldPositions: 0,
          failedSales: 0,
          totalValue: 0,
        }
      });
    }

    console.log(`📈 Found ${positions.length} positions`);

    // Check which positions need to be sold based on strategy
    const sellResults = [];
    let soldCount = 0;
    let failedCount = 0;
    let totalSoldValue = 0;

    for (const position of positions) {
      try {
        // Skip positions with zero or negative size
        if (!position.pos || parseFloat(position.pos) <= 0) {
          continue;
        }

        const symbol = position.instId;
        const positionSize = parseFloat(position.pos);
        const avgPrice = parseFloat(position.avgPx);
        const currentPrice = await okxClient.getMarketPrice(symbol);
        
        console.log(`📊 Analyzing ${symbol}: Size=${positionSize}, Avg=${avgPrice}, Current=${currentPrice}`);

        // Simple sell strategy: sell if profit > 5% or loss > -10%
        const profitPercentage = ((currentPrice - avgPrice) / avgPrice) * 100;
        const shouldSell = profitPercentage >= 5 || profitPercentage <= -10;

        if (shouldSell) {
          console.log(`💰 Selling ${symbol}: Profit=${profitPercentage.toFixed(2)}%`);
          
          // Place market sell order
          const sellOrder = await okxClient.placeOrder({
            instId: symbol,
            tdMode: 'cash',
            side: 'sell',
            ordType: 'market',
            sz: positionSize.toString(),
          });

          if (sellOrder.data && sellOrder.data.length > 0) {
            soldCount++;
            const soldValue = positionSize * currentPrice;
            totalSoldValue += soldValue;
            
            sellResults.push({
              symbol,
              size: positionSize,
              avgPrice,
              sellPrice: currentPrice,
              profitPercentage: profitPercentage.toFixed(2),
              orderId: sellOrder.data[0].ordId,
              success: true,
              message: 'Position sold successfully'
            });
            
            console.log(`✅ Sold ${symbol} for $${soldValue.toFixed(2)}`);
          } else {
            failedCount++;
            sellResults.push({
              symbol,
              size: positionSize,
              avgPrice,
              sellPrice: currentPrice,
              profitPercentage: profitPercentage.toFixed(2),
              success: false,
              message: 'Failed to place sell order'
            });
            console.log(`❌ Failed to sell ${symbol}`);
          }
        } else {
          console.log(`⏳ Holding ${symbol}: Profit=${profitPercentage.toFixed(2)}% (within thresholds)`);
        }

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        failedCount++;
        sellResults.push({
          symbol: position.instId,
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error'
        });
        console.error(`❌ Error processing position ${position.instId}:`, error);
      }
    }

    const summary = {
      totalPositions: positions.length,
      soldPositions: soldCount,
      failedSales: failedCount,
      totalValue: totalSoldValue,
    };

    console.log('✅ Market sell operation completed');
    console.log(`📊 Summary: ${soldCount} positions sold, $${totalSoldValue.toFixed(2)} total value`);

    return NextResponse.json({
      success: true,
      message: 'Market sell operation completed',
      summary,
      results: sellResults,
    });

  } catch (error) {
    console.error('💥 Market sell API error:', error);
    
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
