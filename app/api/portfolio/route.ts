import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  try {
    const { data: portfolio, error } = await supabase
      .from('portfolio')
      .select('*')
      .order('symbol');

    if (error) throw error;

    // Calculate total value and remaining balance
    let totalValue = 0;
    const holdings = portfolio?.map((item) => {
      const value = item.amount * item.avg_price;
      totalValue += value;
      return {
        ...item,
        current_value: value,
      };
    }) || [];

    return NextResponse.json({
      holdings,
      total_value: totalValue,
    });
  } catch (error) {
    console.error('Portfolio API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { symbol, amount, price } = body;

    // Check if portfolio item exists
    const { data: existing, error: checkError } = await supabase
      .from('portfolio')
      .select('*')
      .eq('symbol', symbol)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      throw checkError;
    }

    if (existing) {
      // Update existing portfolio
      const newAmount = existing.amount + amount;
      const newAvgPrice =
        (existing.amount * existing.avg_price + amount * price) / newAmount;

      const { data: updated, error: updateError } = await supabase
        .from('portfolio')
        .update({
          amount: newAmount,
          avg_price: newAvgPrice,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) throw updateError;
      return NextResponse.json({ success: true, portfolio: updated });
    } else {
      // Create new portfolio item
      const { data: newItem, error: insertError } = await supabase
        .from('portfolio')
        .insert({
          symbol,
          amount,
          avg_price: price,
        })
        .select()
        .single();

      if (insertError) throw insertError;
      return NextResponse.json({ success: true, portfolio: newItem });
    }
  } catch (error) {
    console.error('Portfolio update error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
