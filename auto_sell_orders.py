#!/usr/bin/env python3
"""
Auto Sell Orders Script
Automatically sells orders when sell_time is reached
Checks database every 15 minutes for orders ready to sell
"""

import os
import sys
import logging
import traceback
import sqlite3
import time
from datetime import datetime, timedelta
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    def load_dotenv():
        pass
    load_dotenv()

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type, RetryError
from okx import Trade

# Configure logging with rotation
def setup_logging():
    """Setup logging with file rotation"""
    log_filename = f"auto_sell_orders_{datetime.now().strftime('%Y%m%d')}.log"
    
    # Create logs directory if it doesn't exist
    os.makedirs('logs', exist_ok=True)
    log_path = os.path.join('logs', log_filename)
    
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_path, encoding='utf-8'),
            logging.StreamHandler(sys.stdout)
        ]
    )
    
    return logging.getLogger(__name__)

logger = setup_logging()

class AutoSellOrders:
    def __init__(self):
        """Initialize OKX API connection and database"""
        try:
            self.api_key = os.getenv('OKX_API_KEY')
            self.secret_key = os.getenv('OKX_SECRET_KEY')
            self.passphrase = os.getenv('OKX_PASSPHRASE')
            self.testnet = os.getenv('OKX_TESTNET', '1').lower() == 'true'
            
            # Validate environment variables
            missing_vars = []
            if not self.api_key:
                missing_vars.append('OKX_API_KEY')
            if not self.secret_key:
                missing_vars.append('OKX_SECRET_KEY')
            if not self.passphrase:
                missing_vars.append('OKX_PASSPHRASE')
            
            if missing_vars:
                raise ValueError(f"Missing required environment variables: {', '.join(missing_vars)}")
            
            # Set flag for demo/live trading
            self.okx_flag = "1" if self.testnet else "0"
            
            # Initialize Trade API
            self.trade_api = Trade.TradeAPI(
                api_key=self.api_key,
                api_secret_key=self.secret_key,
                passphrase=self.passphrase,
                flag=self.okx_flag,
                debug=False
            )
            
            # Initialize database
            self.init_database()
            
            logger.info("🚀 OKX Auto Sell Orders")
            logger.info("============================================================")
            logger.info(f"🔧 Trading Environment: {'Demo' if self.testnet else 'Live'}")
            logger.info(f"🔑 API Key: {self.api_key[:8]}...{self.api_key[-4:] if len(self.api_key) > 12 else '***'}")
            logger.info("============================================================")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize OKX API: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def init_database(self):
        """Initialize SQLite database connection"""
        try:
            self.db_path = 'filled_orders.db'
            if not os.path.exists(self.db_path):
                raise FileNotFoundError(f"Database not found: {self.db_path}")
            
            self.conn = sqlite3.connect(self.db_path)
            self.cursor = self.conn.cursor()
            
            # Check if sell_time column exists
            self.cursor.execute("PRAGMA table_info(filled_orders)")
            columns = [col[1] for col in self.cursor.fetchall()]
            
            if 'sell_time' not in columns:
                raise ValueError("sell_time column not found in filled_orders table")
            
            logger.info(f"🗄️  Database connected: {self.db_path}")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize database: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def get_orders_ready_to_sell(self):
        """Get orders that are ready to sell (sell_time <= current_time and > current_time - 15 minutes)"""
        try:
            current_time = int(datetime.now().timestamp() * 1000)
            cutoff_time = int((datetime.now() - timedelta(minutes=15)).timestamp() * 1000)
            
            # Query orders ready to sell (exclude already sold orders)
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
                logger.info(f"🔍 Found {len(orders)} orders ready to sell")
                for order in orders:
                    inst_id, ord_id, fill_sz, side, ts, sell_time, fill_px = order
                    sell_time_str = datetime.fromtimestamp(int(sell_time)/1000).strftime('%Y-%m-%d %H:%M:%S')
                    logger.info(f"   📋 {inst_id}: {ord_id} - Size: {fill_sz} - Sell Time: {sell_time_str}")
            else:
                logger.info("🎯 No orders ready to sell at this time")
            
            return orders
            
        except Exception as e:
            logger.error(f"❌ Error getting orders ready to sell: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return []

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def place_market_sell_order(self, inst_id, size, order_id):
        """Place market sell order with retry mechanism"""
        try:
            logger.info(f"📤 Placing market sell order for {inst_id}: {size}")
            
            # Place market sell order
            result = self.trade_api.place_order(
                instId=inst_id,
                tdMode="cash",
                side="sell",
                ordType="market",
                sz=size
            )
            
            if not result:
                logger.error(f"❌ Empty response from API for {inst_id}")
                return False
            
            if result.get('code') == '0':
                order_data = result.get('data', [{}])[0]
                okx_order_id = order_data.get('ordId', 'Unknown')
                logger.info(f"✅ Market sell order placed successfully for {inst_id}")
                logger.info(f"   📋 OKX Order ID: {okx_order_id}")
                logger.info(f"   💰 Size: {size}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ API Error placing sell order for {inst_id}: {error_msg}")
                logger.debug(f"Full API response: {result}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Exception placing sell order for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism

    def mark_order_as_sold(self, order_id):
        """Mark order as sold in database"""
        try:
            # Add a new column to track sold status instead of modifying sell_time
            self.cursor.execute('''
                ALTER TABLE filled_orders ADD COLUMN sold_status TEXT DEFAULT NULL
            ''')
        except sqlite3.OperationalError:
            # Column already exists
            pass
        
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = 'SOLD'
                WHERE ordId = ?
            ''', (order_id,))
            
            self.conn.commit()
            logger.info(f"✅ Order {order_id} marked as sold in database")
            
            # Play notification sound for 10 seconds when order is sold
            self.play_sell_notification_sound()
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Error marking order {order_id} as sold: {e}")
            return False

    def play_sell_notification_sound(self):
        """Play system notification sound on macOS for 10 seconds continuously when selling"""
        try:
            logger.info("🔊 Playing sell notification sound for 10 seconds...")
            
            # Play sound continuously for 10 seconds
            start_time = time.time()
            duration = 10  # 10 seconds
            
            while time.time() - start_time < duration:
                # Play system beep sound
                os.system('osascript -e "beep"')
                # Small delay to prevent overwhelming the system
                time.sleep(0.5)
            
            logger.info("🔊 Sell notification sound completed")
            
        except Exception as e:
            logger.warning(f"⚠️  Could not play sell notification sound: {e}")

    def process_sell_orders(self):
        """Process all orders ready to sell"""
        try:
            # Get orders ready to sell
            orders = self.get_orders_ready_to_sell()
            
            if not orders:
                return
            
            successful_sells = 0
            failed_sells = 0
            
            for order in orders:
                inst_id, ord_id, fill_sz, side, ts, sell_time, fill_px = order
                
                try:
                    logger.info(f"🔄 Processing sell order: {inst_id} - {ord_id}")
                    
                    # Place market sell order
                    if self.place_market_sell_order(inst_id, fill_sz, ord_id):
                        # Mark as sold in database
                        if self.mark_order_as_sold(ord_id):
                            successful_sells += 1
                            logger.info(f"✅ Successfully processed sell order: {ord_id}")
                        else:
                            logger.warning(f"⚠️  Order {ord_id} sold but failed to update database")
                            successful_sells += 1
                    else:
                        failed_sells += 1
                        logger.error(f"❌ Failed to place sell order: {ord_id}")
                    
                    # Rate limiting: OKX allows 60 requests per 2 seconds
                    # Wait 0.1 seconds between orders to be safe
                    time.sleep(0.1)
                    
                except Exception as e:
                    failed_sells += 1
                    logger.error(f"❌ Error processing sell order {ord_id}: {e}")
                    continue
            
            # Summary
            if successful_sells > 0 or failed_sells > 0:
                logger.info("============================================================")
                logger.info(f"📊 Sell Orders Summary: {successful_sells} successful, {failed_sells} failed")
                logger.info("============================================================")
            
        except Exception as e:
            logger.error(f"❌ Error in process_sell_orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def run_continuous_monitoring(self, interval_minutes=15):
        """Run continuous monitoring with specified interval"""
        logger.info(f"🔄 Starting continuous monitoring (check every {interval_minutes} minutes)")
        logger.info("⏹️  Press Ctrl+C to stop")
        
        try:
            while True:
                start_time = datetime.now()
                logger.info(f"⏰ Starting monitoring cycle at {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
                
                # Process sell orders
                self.process_sell_orders()
                
                # Calculate sleep time
                end_time = datetime.now()
                cycle_duration = (end_time - start_time).total_seconds()
                sleep_time = max(0, (interval_minutes * 60) - cycle_duration)
                
                logger.info(f"⏱️  Cycle completed in {cycle_duration:.1f} seconds")
                logger.info(f"😴 Sleeping for {sleep_time:.1f} seconds until next cycle")
                
                time.sleep(sleep_time)
                
        except KeyboardInterrupt:
            logger.info("⏹️  Monitoring stopped by user")
        except Exception as e:
            logger.error(f"❌ Monitoring error: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def close(self):
        """Close database connection"""
        if hasattr(self, 'conn'):
            self.conn.close()
            logger.info("🗄️  Database connection closed")

def main():
    """Main function"""
    start_time = datetime.now()
    
    # Parse command line arguments
    import argparse
    parser = argparse.ArgumentParser(description='Auto sell orders when sell_time is reached')
    parser.add_argument('--once', action='store_true', help='Run once and exit (default: continuous monitoring)')
    parser.add_argument('--interval', type=int, default=15, help='Monitoring interval in minutes (default: 15)')
    args = parser.parse_args()
    
    logger.info(f"🚀 Starting OKX Auto Sell Orders ({'once' if args.once else 'continuous'})")
    logger.info(f"⏰ Start time: {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    exit_code = 0
    auto_seller = None
    
    try:
        # Initialize auto seller
        logger.info("🔧 Initializing OKX API connection and database...")
        auto_seller = AutoSellOrders()
        
        if args.once:
            # Run once
            auto_seller.process_sell_orders()
            logger.info("🎯 Single run completed")
        else:
            # Run continuous monitoring
            auto_seller.run_continuous_monitoring(interval_minutes=args.interval)
        
        logger.info("🎉 Process completed successfully")
        
    except KeyboardInterrupt:
        logger.info("⏹️  Script interrupted by user")
        exit_code = 130  # SIGINT exit code
    except ValueError as e:
        logger.error(f"❌ Configuration error: {e}")
        exit_code = 1
    except Exception as e:
        logger.error(f"❌ Script failed: {e}")
        logger.debug(f"Traceback: {traceback.format_exc()}")
        exit_code = 1
    finally:
        # Clean up
        if auto_seller:
            auto_seller.close()
        
        end_time = datetime.now()
        duration = end_time - start_time
        logger.info(f"⏰ End time: {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
        logger.info(f"⏱️  Duration: {duration}")
        
        if exit_code == 0:
            logger.info("✅ Script finished with success")
        else:
            logger.error(f"❌ Script finished with error code: {exit_code}")
        
        # Exit with appropriate code
        sys.exit(exit_code)

if __name__ == "__main__":
    main()
