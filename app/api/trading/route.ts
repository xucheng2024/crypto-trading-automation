import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, symbol, amount, price, side } = body;

    switch (action) {
      case 'place_order':
        const { data: order, error: orderError } = await supabase
          .from('trades')
          .insert({
            symbol,
            side,
            amount,
            price,
            status: 'pending',
          })
          .select()
          .single();

        if (orderError) throw orderError;

        return NextResponse.json({ success: true, order });

      case 'cancel_order':
        const { data: cancelled, error: cancelError } = await supabase
          .from('trades')
          .update({ status: 'cancelled' })
          .eq('id', body.orderId)
          .select()
          .single();

        if (cancelError) throw cancelError;

        return NextResponse.json({ success: true, cancelled });

      case 'sell':
        // Update portfolio and create sell trade
        const { data: portfolio, error: portfolioError } = await supabase
          .from('portfolio')
          .select('*')
          .eq('symbol', symbol)
          .single();

        if (portfolioError || !portfolio || portfolio.amount < amount) {
          return NextResponse.json(
            { error: 'Insufficient holdings' },
            { status: 400 }
          );
        }

        // Create sell trade
        const { data: sellTrade, error: sellError } = await supabase
          .from('trades')
          .insert({
            symbol,
            side: 'sell',
            amount,
            price,
            status: 'filled',
          })
          .select()
          .single();

        if (sellError) throw sellError;

        // Update portfolio
        const newAmount = portfolio.amount - amount;
        if (newAmount > 0) {
          await supabase
            .from('portfolio')
            .update({ amount: newAmount, updated_at: new Date().toISOString() })
            .eq('id', portfolio.id);
        } else {
          await supabase.from('portfolio').delete().eq('id', portfolio.id);
        }

        return NextResponse.json({ success: true, sellTrade });

      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Trading API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ trades });
  } catch (error) {
    console.error('Get trades error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
