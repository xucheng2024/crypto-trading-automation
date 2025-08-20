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

    // Get current balances
    console.log('📊 Getting current balances...');
    const balances = await okxClient.getBalance();
    
    if (!balances || balances.length === 0) {
      console.log('ℹ️ No balances found');
      return NextResponse.json({
        success: true,
        message: 'No assets to sell',
        soldAmount: 0,
        summary: {
          totalAssets: 0,
          soldAssets: 0,
          failedSales: 0,
          totalValue: 0,
        }
      });
    }

    console.log(`📈 Found ${balances.length} assets`);

    // Check which assets need to be sold based on strategy
    const sellResults = [];
    let soldCount = 0;
    let failedCount = 0;
    let totalSoldValue = 0;

    for (const balance of balances) {
      try {
        // Skip assets with zero or negative balance
        if (!balance.bal || parseFloat(balance.bal) <= 0) {
          continue;
        }

        const symbol = balance.ccy + '-USDT'; // Convert currency to trading pair
        const assetSize = parseFloat(balance.bal);
        const ticker = await okxClient.getMarketTicker(symbol);
        const currentPrice = parseFloat(ticker.last);
        
        console.log(`📊 Analyzing ${symbol}: Size=${assetSize}, Current=${currentPrice}`);

        // Simple sell strategy: sell all available assets
        const shouldSell = assetSize > 0;

        if (shouldSell) {
          console.log(`💰 Selling ${symbol}: Size=${assetSize}`);
          
          // Place market sell order
          const sellOrder = await okxClient.placeOrder({
            instId: symbol,
            tdMode: 'cash',
            side: 'sell',
            ordType: 'market',
            sz: assetSize.toString(),
          });

          if (sellOrder.data && sellOrder.data.length > 0) {
            soldCount++;
            const soldValue = assetSize * currentPrice;
            totalSoldValue += soldValue;
            
            sellResults.push({
              symbol,
              size: assetSize,
              sellPrice: currentPrice,
              orderId: sellOrder.data[0].ordId,
              success: true,
              message: 'Asset sold successfully'
            });
            
            console.log(`✅ Sold ${symbol} for $${soldValue.toFixed(2)}`);
          } else {
            failedCount++;
            sellResults.push({
              symbol,
              size: assetSize,
              sellPrice: currentPrice,
              success: false,
              message: 'Failed to place sell order'
            });
            console.log(`❌ Failed to sell ${symbol}`);
          }
        } else {
          console.log(`⏳ Holding ${symbol}: Size=${assetSize}`);
        }

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        failedCount++;
        sellResults.push({
          symbol: balance.ccy + '-USDT',
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error'
        });
        console.error(`❌ Error processing asset ${balance.ccy}:`, error);
      }
    }

    const summary = {
      totalAssets: balances.length,
      soldAssets: soldCount,
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
