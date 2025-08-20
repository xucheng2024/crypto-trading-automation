import { NextRequest, NextResponse } from 'next/server';
import { OKXClient, OKXOrderParams } from '@/lib/okx';
import { supabase } from '@/lib/supabase';

// Initialize OKX client
const okxClient = new OKXClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
  isTestnet: process.env.OKX_TESTNET === 'true',
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    console.log('OKX Trading API called:', { action, params });

    switch (action) {
      case 'place_order':
        return await handlePlaceOrder(params);
      
      case 'cancel_order':
        return await handleCancelOrder(params);
      
      case 'get_order':
        return await handleGetOrder(params);
      
      case 'get_balance':
        return await handleGetBalance(params);
      
      case 'get_positions':
        return await handleGetPositions(params);
      
      case 'market_buy':
        return await handleMarketBuy(params);
      
      case 'market_sell':
        return await handleMarketSell(params);
      
      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('OKX Trading API error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handlePlaceOrder(params: any) {
  try {
    const { symbol, amount, price, side, orderType = 'limit' } = params;
    
    // Validate required parameters
    if (!symbol || !amount || !side) {
      return NextResponse.json(
        { error: 'Missing required parameters: symbol, amount, side' },
        { status: 400 }
      );
    }

    // Format trading pair for OKX
    const instId = symbol.includes('-') ? symbol : `${symbol}-USDT`;
    
    const orderParams: OKXOrderParams = {
      instId,
      tdMode: 'cash',
      side: side.toLowerCase(),
      ordType: orderType.toLowerCase(),
      sz: amount.toString(),
      px: orderType === 'limit' ? price?.toString() : undefined,
      clOrdId: `manual_${Date.now()}`,
    };

    console.log('Placing OKX order:', orderParams);

    const response = await okxClient.placeOrder(orderParams);
    
    if (response.data && response.data.length > 0) {
      const orderData = response.data[0];
      
      // Record the order in Supabase
      const { data: dbOrder, error: dbError } = await supabase
        .from('trades')
        .insert({
          symbol: symbol.toUpperCase(),
          side: side.toLowerCase(),
          amount: parseFloat(amount),
          price: price ? parseFloat(price) : 0,
          status: 'pending',
        })
        .select()
        .single();

      if (dbError) {
        console.error('Failed to save order to database:', dbError);
      }

      return NextResponse.json({
        success: true,
        okxOrderId: orderData.ordId,
        clientOrderId: orderData.clOrdId,
        databaseOrder: dbOrder,
        message: 'Order placed successfully',
      });
    } else {
      throw new Error('No order data received from OKX');
    }
  } catch (error) {
    console.error('Failed to place order:', error);
    return NextResponse.json(
      { 
        error: 'Failed to place order',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleCancelOrder(params: any) {
  try {
    const { symbol, orderId, clientOrderId } = params;
    
    if (!symbol || !orderId) {
      return NextResponse.json(
        { error: 'Missing required parameters: symbol, orderId' },
        { status: 400 }
      );
    }

    const instId = symbol.includes('-') ? symbol : `${symbol}-USDT`;
    
    console.log('Cancelling OKX order:', { instId, orderId, clientOrderId });

    const response = await okxClient.cancelOrder(instId, orderId, clientOrderId);
    
    // Update order status in database
    if (response.data && response.data.length > 0) {
      await supabase
        .from('trades')
        .update({ status: 'cancelled' })
        .eq('symbol', symbol.toUpperCase());
    }

    return NextResponse.json({
      success: true,
      message: 'Order cancelled successfully',
      response,
    });
  } catch (error) {
    console.error('Failed to cancel order:', error);
    return NextResponse.json(
      { 
        error: 'Failed to cancel order',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleMarketBuy(params: any) {
  try {
    const { symbol, amount } = params;
    
    if (!symbol || !amount) {
      return NextResponse.json(
        { error: 'Missing required parameters: symbol, amount' },
        { status: 400 }
      );
    }

    // Get current market price
    const instId = symbol.includes('-') ? symbol : `${symbol}-USDT`;
    const marketPrice = await okxClient.getMarketPrice(instId);
    
    console.log('Market buy:', { symbol, amount, marketPrice });

    const orderParams: OKXOrderParams = {
      instId,
      tdMode: 'cash',
      side: 'buy',
      ordType: 'market',
      sz: amount.toString(),
      clOrdId: `market_buy_${Date.now()}`,
    };

    const response = await okxClient.placeOrder(orderParams);
    
    if (response.data && response.data.length > 0) {
      const orderData = response.data[0];
      
      // Record the market buy in database
      const { data: dbOrder, error: dbError } = await supabase
        .from('trades')
        .insert({
          symbol: symbol.toUpperCase(),
          side: 'buy',
          amount: parseFloat(amount),
          price: marketPrice,
          status: 'filled',
        })
        .select()
        .single();

      if (dbError) {
        console.error('Failed to save market buy to database:', dbError);
      }

      // Update portfolio
      await updatePortfolioAfterTrade(symbol.toUpperCase(), parseFloat(amount), marketPrice, 'buy');

      return NextResponse.json({
        success: true,
        okxOrderId: orderData.ordId,
        marketPrice,
        databaseOrder: dbOrder,
        message: 'Market buy executed successfully',
      });
    } else {
      throw new Error('No order data received from OKX');
    }
  } catch (error) {
    console.error('Failed to execute market buy:', error);
    return NextResponse.json(
      { 
        error: 'Failed to execute market buy',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleMarketSell(params: any) {
  try {
    const { symbol, amount } = params;
    
    if (!symbol || !amount) {
      return NextResponse.json(
        { error: 'Missing required parameters: symbol, amount' },
        { status: 400 }
      );
    }

    // Check if we have enough holdings
    const { data: portfolio } = await supabase
      .from('portfolio')
      .select('*')
      .eq('symbol', symbol.toUpperCase())
      .single();

    if (!portfolio || portfolio.amount < parseFloat(amount)) {
      return NextResponse.json(
        { error: 'Insufficient holdings for market sell' },
        { status: 400 }
      );
    }

    // Get current market price
    const instId = symbol.includes('-') ? symbol : `${symbol}-USDT`;
    const marketPrice = await okxClient.getMarketPrice(instId);
    
    console.log('Market sell:', { symbol, amount, marketPrice });

    const orderParams: OKXOrderParams = {
      instId,
      tdMode: 'cash',
      side: 'sell',
      ordType: 'market',
      sz: amount.toString(),
      clOrdId: `market_sell_${Date.now()}`,
    };

    const response = await okxClient.placeOrder(orderParams);
    
    if (response.data && response.data.length > 0) {
      const orderData = response.data[0];
      
      // Record the market sell in database
      const { data: dbOrder, error: dbError } = await supabase
        .from('trades')
        .insert({
          symbol: symbol.toUpperCase(),
          side: 'sell',
          amount: parseFloat(amount),
          price: marketPrice,
          status: 'filled',
        })
        .select()
        .single();

      if (dbError) {
        console.error('Failed to save market sell to database:', dbError);
      }

      // Update portfolio
      await updatePortfolioAfterTrade(symbol.toUpperCase(), parseFloat(amount), marketPrice, 'sell');

      return NextResponse.json({
        success: true,
        okxOrderId: orderData.ordId,
        marketPrice,
        databaseOrder: dbOrder,
        message: 'Market sell executed successfully',
      });
    } else {
      throw new Error('No order data received from OKX');
    }
  } catch (error) {
    console.error('Failed to execute market sell:', error);
    return NextResponse.json(
      { 
        error: 'Failed to execute market sell',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleGetOrder(params: any) {
  try {
    const { symbol, orderId, clientOrderId } = params;
    
    if (!symbol || !orderId) {
      return NextResponse.json(
        { error: 'Missing required parameters: symbol, orderId' },
        { status: 400 }
      );
    }

    const instId = symbol.includes('-') ? symbol : `${symbol}-USDT`;
    const response = await okxClient.getOrder(instId, orderId, clientOrderId);
    
    return NextResponse.json({
      success: true,
      order: response.data,
    });
  } catch (error) {
    console.error('Failed to get order:', error);
    return NextResponse.json(
      { 
        error: 'Failed to get order',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleGetBalance(params: any) {
  try {
    const { currency } = params;
    const response = await okxClient.getBalance(currency);
    
    return NextResponse.json({
      success: true,
      balance: response,
    });
  } catch (error) {
    console.error('Failed to get balance:', error);
    return NextResponse.json(
      { 
        error: 'Failed to get balance',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleGetPositions(params: any) {
  try {
    const { symbol } = params;
    const instId = symbol ? (symbol.includes('-') ? symbol : `${symbol}-USDT`) : undefined;
    const response = await okxClient.getPositions(instId);
    
    return NextResponse.json({
      success: true,
      positions: response,
    });
  } catch (error) {
    console.error('Failed to get positions:', error);
    return NextResponse.json(
      { 
        error: 'Failed to get positions',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function updatePortfolioAfterTrade(symbol: string, amount: number, price: number, side: 'buy' | 'sell') {
  try {
    const { data: existing } = await supabase
      .from('portfolio')
      .select('*')
      .eq('symbol', symbol)
      .single();

    if (existing) {
      if (side === 'buy') {
        // Add to existing position
        const newAmount = existing.amount + amount;
        const newAvgPrice = (existing.amount * existing.avg_price + amount * price) / newAmount;
        
        await supabase
          .from('portfolio')
          .update({
            amount: newAmount,
            avg_price: newAvgPrice,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        // Reduce existing position
        const newAmount = existing.amount - amount;
        if (newAmount > 0) {
          await supabase
            .from('portfolio')
            .update({
              amount: newAmount,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
        } else {
          // Remove position if fully sold
          await supabase
            .from('portfolio')
            .delete()
            .eq('id', existing.id);
        }
      }
    } else if (side === 'buy') {
      // Create new position
      await supabase
        .from('portfolio')
        .insert({
          symbol,
          amount,
          avg_price: price,
        });
    }
  } catch (error) {
    console.error('Failed to update portfolio:', error);
  }
}
