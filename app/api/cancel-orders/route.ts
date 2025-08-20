import { NextRequest, NextResponse } from 'next/server';
import { OKXClient } from '@/lib/okx';

export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Cancel Orders API endpoint called');
    
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

    // Get pending orders
    console.log('📋 Getting pending orders...');
    const pendingOrders = await okxClient.getPendingOrders();
    
    if (!pendingOrders || pendingOrders.length === 0) {
      console.log('ℹ️ No pending orders found');
      return NextResponse.json({
        success: true,
        message: 'No pending orders to cancel',
        cancelledOrders: 0,
        summary: {
          totalOrders: 0,
          cancelledOrders: 0,
          failedCancellations: 0,
        }
      });
    }

    console.log(`📊 Found ${pendingOrders.length} pending orders`);

    // Cancel all pending orders
    const results = [];
    let cancelledCount = 0;
    let failedCount = 0;

    for (const order of pendingOrders) {
      try {
        console.log(`❌ Cancelling order: ${order.ordId} for ${order.instId}`);
        
        const cancelResult = await okxClient.cancelOrder(
          order.instId,
          order.ordId,
          order.clOrdId
        );

        if (cancelResult.data && cancelResult.data.length > 0) {
          cancelledCount++;
          results.push({
            orderId: order.ordId,
            symbol: order.instId,
            success: true,
            message: 'Order cancelled successfully'
          });
          console.log(`✅ Order ${order.ordId} cancelled successfully`);
        } else {
          failedCount++;
          results.push({
            orderId: order.ordId,
            symbol: order.instId,
            success: false,
            message: 'Failed to cancel order'
          });
          console.log(`❌ Failed to cancel order ${order.ordId}`);
        }

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        failedCount++;
        results.push({
          orderId: order.ordId,
          symbol: order.instId,
          success: false,
          message: error instanceof Error ? error.message : 'Unknown error'
        });
        console.error(`❌ Error cancelling order ${order.ordId}:`, error);
      }
    }

    const summary = {
      totalOrders: pendingOrders.length,
      cancelledOrders: cancelledCount,
      failedCancellations: failedCount,
    };

    console.log('✅ Cancel orders operation completed');
    console.log(`📊 Summary: ${cancelledCount}/${pendingOrders.length} orders cancelled`);

    return NextResponse.json({
      success: true,
      message: 'Cancel orders operation completed',
      summary,
      results,
    });

  } catch (error) {
    console.error('💥 Cancel orders API error:', error);
    
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
