#!/usr/bin/env python3
"""
Auto Sell Orders Script
Automatically sells orders when sell_time is reached
Simple and optimized version
"""

import os
import sys
import logging
import sqlite3
import time
from datetime import datetime, timedelta
from decimal import Decimal, getcontext
from tenacity import retry, stop_after_attempt, wait_exponential
from okx_client import OKXClient

# Set Decimal precision for consistency with create_algo_triggers.py
getcontext().prec = 28

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # If dotenv is not available, try to load from environment directly
    def load_dotenv():
        pass
    load_dotenv()

# Load environment variables
load_dotenv()

def setup_logging():
    """Setup logging with file rotation"""
    log_filename = f"auto_sell_orders_{datetime.now().strftime('%Y%m%d')}.log"
    os.makedirs('logs', exist_ok=True)
    log_path = os.path.join('logs', log_filename)
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_path, encoding='utf-8'),
            logging.StreamHandler(sys.stdout)
        ]
    )
    return logging.getLogger(__name__)

class AutoSellOrders:
    def __init__(self):
        """Initialize with environment variables and API connection"""
        self.logger = setup_logging()
        
        # Load environment variables
        self.api_key = os.getenv('OKX_API_KEY')
        self.secret_key = os.getenv('OKX_SECRET_KEY')
        self.passphrase = os.getenv('OKX_PASSPHRASE')
        self.testnet = os.getenv('OKX_TESTNET', 'false').lower() == 'true'
        
        # Validate required variables
        if not all([self.api_key, self.secret_key, self.passphrase]):
            raise ValueError("Missing required environment variables: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE")
        
        # Initialize OKX Client
        self.okx_client = OKXClient(self.logger)
        self.trade_api = self.okx_client.get_trade_api()
        
        # Initialize database
        self.init_database()
        
        self.logger.info(f"🚀 Auto Sell Orders initialized - {'Demo' if self.testnet else 'Live'} mode")

    def format_price(self, price_str):
        """Format price string using Decimal for consistency"""
        try:
            if price_str:
                return str(Decimal(str(price_str)))
            return price_str
        except:
            return price_str

    def init_database(self):
        """Initialize database connection and ensure required columns exist"""
        self.db_path = 'filled_orders.db'
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(f"Database not found: {self.db_path}")
        
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()
        
        # Ensure sold_status column exists
        try:
            self.cursor.execute("ALTER TABLE filled_orders ADD COLUMN sold_status TEXT DEFAULT NULL")
            self.logger.info("✅ Added sold_status column to database")
        except sqlite3.OperationalError:
            pass  # Column already exists
        
        self.logger.info(f"🗄️  Database connected: {self.db_path}")

    def get_orders_ready_to_sell(self):
        """Get orders that are ready to sell within the 15-minute window"""
        current_time = int(datetime.now().timestamp() * 1000)
        cutoff_time = int((datetime.now() - timedelta(minutes=15)).timestamp() * 1000)
        
        self.cursor.execute('''
            SELECT instId, ordId, fillSz, side, ts, sell_time, fillPx
            FROM filled_orders 
            WHERE sell_time IS NOT NULL 
            AND (sold_status IS NULL OR sold_status != 'SOLD')
            AND sell_time <= ? 
            AND sell_time > ?
            AND side = 'buy'
            ORDER BY sell_time ASC
        ''', (current_time, cutoff_time))
        
        orders = self.cursor.fetchall()
        
        if orders:
            self.logger.info(f"🔍 Found {len(orders)} orders ready to sell")
            for order in orders:
                inst_id, ord_id, fill_sz, side, ts, sell_time, fill_px = order
                sell_time_str = datetime.fromtimestamp(int(sell_time)/1000).strftime('%Y-%m-%d %H:%M:%S')
                self.logger.info(f"   📋 {inst_id}: {ord_id} - Size: {fill_sz} - Sell Time: {sell_time_str}")
        
        return orders

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    def place_market_sell_order(self, inst_id, size, order_id):
        """Place market sell order with retry mechanism"""
        self.logger.info(f"📤 Placing market sell order for {inst_id}: {size}")
        
        result = self.trade_api.place_order(
            instId=inst_id,
            tdMode="cash",
            side="sell",
            ordType="market",
            sz=size,
            tgtCcy="base_ccy"  # 明确指定按基础货币数量卖出
        )
        
        if not result or result.get('code') != '0':
            error_msg = result.get('msg', 'Unknown error') if result else 'Empty response'
            self.logger.error(f"❌ API Error placing sell order for {inst_id}: {error_msg}")
            return False
        
        okx_order_id = result.get('data', [{}])[0].get('ordId', 'Unknown')
        self.logger.info(f"✅ Market sell order placed successfully for {inst_id}")
        self.logger.info(f"   📋 OKX Order ID: {okx_order_id}")
        self.logger.info(f"   💰 Size: {size}")
        return True

    def mark_order_as_sold(self, order_id):
        """Mark order as sold in database and play notification sound"""
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = 'SOLD'
                WHERE ordId = ?
            ''', (order_id,))
            
            self.conn.commit()
            self.logger.info(f"✅ Order {order_id} marked as sold in database")
            
            # Play notification sound
            self.play_sell_notification_sound()
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Error marking order {order_id} as sold: {e}")
            return False

    def play_sell_notification_sound(self):
        """Play 10-second notification sound on macOS"""
        try:
            self.logger.info("🔊 Playing sell notification sound for 10 seconds...")
            
            start_time = time.time()
            while time.time() - start_time < 10:
                os.system('osascript -e "beep"')
                time.sleep(0.5)
            
            self.logger.info("🔊 Sell notification sound completed")
            
        except Exception as e:
            self.logger.warning(f"⚠️  Could not play notification sound: {e}")

    def process_sell_orders(self):
        """Process all orders ready to sell"""
        orders = self.get_orders_ready_to_sell()
        
        if not orders:
            return
        
        successful_sells = 0
        failed_sells = 0
        
        for order in orders:
            inst_id, ord_id, fill_sz, side, ts, sell_time, fill_px = order
            
            try:
                formatted_price = self.format_price(fill_px)
                self.logger.info(f"🔄 Processing sell order: {inst_id} - {ord_id} (Price: {formatted_price})")
                
                if self.place_market_sell_order(inst_id, fill_sz, ord_id):
                    if self.mark_order_as_sold(ord_id):
                        successful_sells += 1
                    else:
                        self.logger.warning(f"⚠️  Order {ord_id} sold but failed to update database")
                        successful_sells += 1
                else:
                    failed_sells += 1
                
                # Rate limiting: wait 0.1 seconds between orders
                time.sleep(0.1)
                
            except Exception as e:
                failed_sells += 1
                self.logger.error(f"❌ Error processing sell order {ord_id}: {e}")
                continue
        
        # Summary
        if successful_sells > 0 or failed_sells > 0:
            self.logger.info("=" * 60)
            self.logger.info(f"📊 Summary: {successful_sells} successful, {failed_sells} failed")
            self.logger.info("=" * 60)

    def run_continuous_monitoring(self, interval_minutes=15):
        """Run continuous monitoring with specified interval"""
        self.logger.info(f"🔄 Starting continuous monitoring (check every {interval_minutes} minutes)")
        self.logger.info("⏹️  Press Ctrl+C to stop")
        
        try:
            while True:
                start_time = datetime.now()
                self.logger.info(f"⏰ Starting monitoring cycle at {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
                
                self.process_sell_orders()
                
                # Calculate sleep time
                cycle_duration = (datetime.now() - start_time).total_seconds()
                sleep_time = max(0, (interval_minutes * 60) - cycle_duration)
                
                self.logger.info(f"⏱️  Cycle completed in {cycle_duration:.1f} seconds")
                self.logger.info(f"😴 Sleeping for {sleep_time:.1f} seconds until next cycle")
                
                time.sleep(sleep_time)
                
        except KeyboardInterrupt:
            self.logger.info("⏹️  Monitoring stopped by user")
        except Exception as e:
            self.logger.error(f"❌ Monitoring error: {e}")
            raise

    def close(self):
        """Close database connection"""
        if hasattr(self, 'conn'):
            self.conn.close()
            self.logger.info("🗄️  Database connection closed")

def main():
    """Main function with argument parsing"""
    import argparse
    parser = argparse.ArgumentParser(description='Auto sell orders when sell_time is reached')
    parser.add_argument('--continuous', action='store_true', help='Run continuously (default: run once and exit)')
    parser.add_argument('--interval', type=int, default=15, help='Monitoring interval in minutes (default: 15)')
    args = parser.parse_args()
    
    start_time = datetime.now()
    logger = setup_logging()
    
    logger.info(f"🚀 Starting OKX Auto Sell Orders ({'continuous' if args.continuous else 'once'})")
    logger.info(f"⏰ Start time: {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    auto_seller = None
    exit_code = 0
    
    try:
        auto_seller = AutoSellOrders()
        
        if args.continuous:
            auto_seller.run_continuous_monitoring(interval_minutes=args.interval)
        else:
            auto_seller.process_sell_orders()
            logger.info("🎯 Single run completed")
        
        logger.info("🎉 Process completed successfully")
        
    except KeyboardInterrupt:
        logger.info("⏹️  Script interrupted by user")
        exit_code = 130
    except Exception as e:
        logger.error(f"❌ Script failed: {e}")
        exit_code = 1
    finally:
        if auto_seller:
            auto_seller.close()
        
        duration = datetime.now() - start_time
        logger.info(f"⏰ Duration: {duration}")
        logger.info("✅ Script finished" if exit_code == 0 else f"❌ Script finished with error code: {exit_code}")
        
        sys.exit(exit_code)

if __name__ == "__main__":
    main()
