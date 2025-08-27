#!/usr/bin/env python3
"""
Query Filled Orders Database
Simple script to query and display filled orders with sell times
"""

import sqlite3
import argparse
from datetime import datetime

def connect_db():
    """Connect to the filled orders database"""
    try:
        conn = sqlite3.connect('filled_orders.db')
        cursor = conn.cursor()
        return conn, cursor
    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        return None, None

def show_all_orders(cursor, limit=50):
    """Show all orders with sell times"""
    try:
        cursor.execute('''
            SELECT instId, ordId, side, fillPx, fillSz, ts, sell_time, created_at
            FROM filled_orders 
            ORDER BY created_at DESC 
            LIMIT ?
        ''', (limit,))
        
        orders = cursor.fetchall()
        
        if not orders:
            print("📭 No orders found in database")
            return
        
        print(f"📋 Found {len(orders)} orders:")
        print("=" * 100)
        print(f"{'Symbol':<15} {'Order ID':<20} {'Side':<6} {'Price':<12} {'Size':<12} {'Fill Time':<20} {'Sell Time':<20}")
        print("=" * 100)
        
        for order in orders:
            inst_id, ord_id, side, price, size, ts, sell_time, created_at = order
            
            # Format timestamps
            fill_time = "N/A"
            sell_time_str = "N/A"
            
            if ts:
                try:
                    fill_dt = datetime.fromtimestamp(int(ts) / 1000)
                    fill_time = fill_dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            
            if sell_time:
                try:
                    sell_dt = datetime.fromtimestamp(int(sell_time) / 1000)
                    sell_time_str = sell_dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            
            print(f"{inst_id:<15} {ord_id:<20} {side:<6} {price:<12} {size:<12} {fill_time:<20} {sell_time_str:<20}")
        
        print("=" * 100)
        
    except Exception as e:
        print(f"❌ Error querying orders: {e}")

def show_orders_by_symbol(cursor, symbol):
    """Show orders for a specific symbol"""
    try:
        cursor.execute('''
            SELECT instId, ordId, side, fillPx, fillSz, ts, sell_time, created_at
            FROM filled_orders 
            WHERE instId = ?
            ORDER BY created_at DESC
        ''', (symbol,))
        
        orders = cursor.fetchall()
        
        if not orders:
            print(f"📭 No orders found for {symbol}")
            return
        
        print(f"📋 Found {len(orders)} orders for {symbol}:")
        print("=" * 100)
        print(f"{'Order ID':<20} {'Side':<6} {'Price':<12} {'Size':<12} {'Fill Time':<20} {'Sell Time':<20}")
        print("=" * 100)
        
        for order in orders:
            inst_id, ord_id, side, price, size, ts, sell_time, created_at = order
            
            # Format timestamps
            fill_time = "N/A"
            sell_time_str = "N/A"
            
            if ts:
                try:
                    fill_dt = datetime.fromtimestamp(int(ts) / 1000)
                    fill_time = fill_dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            
            if sell_time:
                try:
                    sell_dt = datetime.fromtimestamp(int(sell_time) / 1000)
                    sell_time_str = sell_dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            
            print(f"{ord_id:<20} {side:<6} {price:<12} {size:<12} {fill_time:<20} {sell_time_str:<20}")
        
        print("=" * 100)
        
    except Exception as e:
        print(f"❌ Error querying orders for {symbol}: {e}")

def show_database_stats(cursor):
    """Show database statistics"""
    try:
        # Total orders
        cursor.execute("SELECT COUNT(*) FROM filled_orders")
        total_orders = cursor.fetchone()[0]
        
        # Orders by side
        cursor.execute("SELECT side, COUNT(*) FROM filled_orders GROUP BY side")
        side_stats = dict(cursor.fetchall())
        
        # Orders with sell_time
        cursor.execute("SELECT COUNT(*) FROM filled_orders WHERE sell_time IS NOT NULL")
        orders_with_sell_time = cursor.fetchone()[0]
        
        # Latest order
        cursor.execute("SELECT MAX(ts) FROM filled_orders")
        latest_ts = cursor.fetchone()[0]
        
        print("📊 Database Statistics:")
        print(f"   Total orders: {total_orders}")
        print(f"   Buy orders: {side_stats.get('buy', 0)}")
        print(f"   Sell orders: {side_stats.get('sell', 0)}")
        print(f"   Orders with sell_time: {orders_with_sell_time}/{total_orders}")
        
        if latest_ts:
            try:
                latest_time = datetime.fromtimestamp(int(latest_ts)/1000).strftime('%Y-%m-%d %H:%M:%S')
                print(f"   Latest order: {latest_time}")
            except:
                print(f"   Latest order: {latest_ts}")
        
        # Show symbols
        cursor.execute("SELECT instId, COUNT(*) FROM filled_orders GROUP BY instId ORDER BY COUNT(*) DESC")
        symbols = cursor.fetchall()
        
        if symbols:
            print("\n📈 Orders by Symbol:")
            for symbol, count in symbols:
                print(f"   {symbol}: {count}")
        
    except Exception as e:
        print(f"❌ Error getting database stats: {e}")

def main():
    """Main function"""
    parser = argparse.ArgumentParser(description='Query filled orders database')
    parser.add_argument('--symbol', '-s', help='Filter by symbol (e.g., BTC-USDT)')
    parser.add_argument('--limit', '-l', type=int, default=50, help='Limit number of orders to show (default: 50)')
    parser.add_argument('--stats', action='store_true', help='Show database statistics only')
    
    args = parser.parse_args()
    
    print("🔍 OKX Filled Orders Database Query Tool")
    print("=" * 50)
    
    # Connect to database
    conn, cursor = connect_db()
    if not conn:
        return
    
    try:
        if args.stats:
            show_database_stats(cursor)
        elif args.symbol:
            show_orders_by_symbol(cursor, args.symbol.upper())
        else:
            show_database_stats(cursor)
            print()
            show_all_orders(cursor, args.limit)
    
    finally:
        conn.close()

if __name__ == "__main__":
    main()
