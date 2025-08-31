#!/usr/bin/env python3
"""
Automated Filled Order Tracking System
Monitors completed orders and calculates sell times for automated trading
"""

import os
import sys
import time
import json
import logging
import logging.handlers
import traceback
from datetime import datetime, timedelta
from decimal import Decimal
# import sqlite3  # Migrated to PostgreSQL
import psycopg2
from psycopg2.extras import RealDictCursor

# Import tenacity for retry functionality
try:
    from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
except ImportError:
    # Fallback if tenacity is not available
    def retry(*args, **kwargs):
        def decorator(func):
            return func
        return decorator
    
    def stop_after_attempt(*args, **kwargs):
        pass
    
    def wait_exponential(*args, **kwargs):
        pass
    
    def retry_if_exception_type(*args, **kwargs):
        pass

# Load environment variables first
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # If dotenv is not available, try to load from environment directly
    def load_dotenv():
        pass
    load_dotenv()

from okx_client import OKXClient

# Configure logging with rotation
def setup_logging():
    """Setup logging with file rotation"""
    log_filename = f"fetch_filled_orders_{datetime.now().strftime('%Y%m%d')}.log"
    
    # Create logs directory if it doesn't exist
    os.makedirs('logs', exist_ok=True)
    log_path = os.path.join('logs', log_filename)
    
    # Configure logging with rotation
    logger = logging.getLogger(__name__)
    logger.setLevel(logging.INFO)
    
    # Clear existing handlers
    logger.handlers.clear()
    
    # Create formatter
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    
    # File handler with rotation (max 10MB, keep 5 backups)
    file_handler = logging.handlers.RotatingFileHandler(
        log_path, 
        maxBytes=10*1024*1024,  # 10MB
        backupCount=5,
        encoding='utf-8'
    )
    file_handler.setFormatter(formatter)
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    
    # Add handlers
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    
    return logging.getLogger(__name__)

logger = setup_logging()

class OKXFilledOrdersFetcher:
    def __init__(self):
        """Initialize OKX API connection and database"""
        try:
            self.api_key = os.getenv('OKX_API_KEY')
            self.secret_key = os.getenv('OKX_SECRET_KEY')
            self.passphrase = os.getenv('OKX_PASSPHRASE')
            self.testnet = os.getenv('OKX_TESTNET', 'false').lower() == 'true'
            
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
            
            # Initialize OKX Client
            self.okx_client = OKXClient(logger)
            self.trade_api = self.okx_client.get_trade_api()
            
            # Initialize database
            from lib.database import get_database_connection
            self.conn = get_database_connection()
            self.cursor = self.conn.cursor()
            logger.info("✅ Connected to PostgreSQL database")
            
            logger.info(f"🚀 OKX Filled Orders Fetcher - {'Demo' if self.testnet else 'Live'}")
            logger.info(f"🔑 API: {self.api_key[:8]}...{self.api_key[-4:] if len(self.api_key) > 12 else '***'}")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize OKX API: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise



    def get_latest_order_ts(self):
        """Get latest saved order timestamp (ms) from DB, or None"""
        try:
            self.cursor.execute("SELECT MAX(CAST(ts AS BIGINT)) FROM filled_orders")
            row = self.cursor.fetchone()
            if row and row[0]:
                return int(row[0])
        except Exception as e:
            logger.warning(f"⚠️  Failed to get latest ts from DB: {e}")
        return None



    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_filled_orders(self, begin_time=None, end_time=None, limit=100):
        """Get filled limit orders with retry mechanism"""
        try:
            logger.debug("🔍 Fetching filled limit orders...")
            
            # Prepare parameters for get_orders_history
            params = {
                'instType': 'SPOT',
                'ordType': 'limit',
                'state': 'filled',
                'limit': str(limit)
            }
            
            # Add time filters if provided (using begin/end for orders_history)
            if begin_time:
                params['begin'] = str(int(begin_time.timestamp() * 1000))
            if end_time:
                params['end'] = str(int(end_time.timestamp() * 1000))
            
            result = self.trade_api.get_orders_history(**params)
            
            if not result:
                logger.warning("⚠️  Empty response from API")
                return []
            
            # Log the full API response for debugging
            logger.debug(f"🔍 Full API response: {result}")
            
            if result.get('code') == '0':
                orders = result.get('data', [])
                logger.info(f"📋 Found {len(orders)} filled limit orders")
                
                # Filter for buy orders only
                buy_orders = [order for order in orders if order.get('side') == 'buy']
                logger.info(f"📋 Filtered to {len(buy_orders)} buy orders (removed {len(orders) - len(buy_orders)} sell orders)")
                
                # Log order details for debugging
                if buy_orders:
                    logger.debug(f"📝 Order types found: {list(set(order.get('ordType', 'unknown') for order in buy_orders))}")
                    logger.debug(f"📝 Order sides found: {list(set(order.get('side', 'unknown') for order in buy_orders))}")
                    # Log first order structure for debugging
                    if len(buy_orders) > 0:
                        logger.debug(f"📝 First order structure: {list(buy_orders[0].keys())}")
                
                return buy_orders
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ API Error getting filled orders: {error_msg}")
                logger.debug(f"Full API response: {result}")
                return []
                
        except Exception as e:
            logger.error(f"❌ Exception getting filled orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism

    def save_order_to_db(self, order):
        """Save a single order to database"""
        try:
            # Extract required fields
            inst_id = order.get('instId', '')
            ord_id = order.get('ordId', '')
            fill_px = order.get('fillPx', '')
            fill_sz = order.get('fillSz', '')
            side = order.get('side', '')
            
            # Try multiple timestamp fields in order of preference
            ts = order.get('fillTime') or order.get('uTime') or order.get('cTime') or ''
            
            # Calculate sell time (ts + 20 hours)
            sell_time = None
            if ts:
                try:
                    # Convert timestamp to datetime and add 20 hours
                    ts_datetime = datetime.fromtimestamp(int(ts) / 1000)
                    sell_time_datetime = ts_datetime + timedelta(hours=20)
                    sell_time = str(int(sell_time_datetime.timestamp() * 1000))
                except (ValueError, TypeError) as e:
                    logger.warning(f"⚠️  Could not calculate sell time for order {ord_id}: {e}")
            
            # Validate required fields (make ts optional for now)
            if not all([inst_id, ord_id, fill_px, fill_sz, side]):
                logger.warning(f"⚠️  Skipping order with missing required data: {order}")
                return False
            
            # Prepare data for insertion
            data = {
                'instId': inst_id,
                'ordId': ord_id,
                'fillPx': fill_px,
                'fillSz': fill_sz,
                'side': side,
                'ts': ts,
                'ordType': order.get('ordType', ''),
                'avgPx': order.get('avgPx', ''),
                'accFillSz': order.get('accFillSz', ''),
                'fee': order.get('fee', ''),
                'feeCcy': order.get('feeCcy', ''),
                'tradeId': order.get('tradeId', ''),
                'fillTime': order.get('fillTime', ''),
                'cTime': order.get('cTime', ''),
                'uTime': order.get('uTime', ''),
                'sell_time': sell_time
            }
            
            # Insert new order; ignore if ordId already exists to preserve sold_status
            self.cursor.execute('''
                INSERT INTO filled_orders 
                (instId, ordId, fillPx, fillSz, side, ts, ordType, avgPx, accFillSz, fee, feeCcy, tradeId, fillTime, cTime, uTime, sell_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (ordId) DO NOTHING
            ''', (
                data['instId'], data['ordId'], data['fillPx'], data['fillSz'], data['side'], data['ts'],
                data['ordType'], data['avgPx'], data['accFillSz'], data['fee'], data['feeCcy'],
                data['tradeId'], data['fillTime'], data['cTime'], data['uTime'], data['sell_time']
            ))

            # Log when a duplicate ordId is ignored (rowcount == 0)
            if self.cursor.rowcount == 0:
                logger.debug(f"🔁 Duplicate order ignored (preserved sold_status): {ord_id}")
                return False
            
            # If order is newly saved and it's a buy order, create trigger sell order
            if self.cursor.rowcount == 1 and side == 'buy' and fill_px and fill_sz:
                logger.info(f"💰 Buy order saved: {inst_id} @ {fill_px} x {fill_sz}")
                try:
                    self.create_trigger_sell_order(inst_id, fill_px, fill_sz, ord_id)
                except Exception as e:
                    logger.warning(f"⚠️  Failed to create trigger sell order for {ord_id}: {e}")
            
            return True
            
        except Exception as e:  # PostgreSQL compatible
            logger.warning(f"⚠️  Duplicate order ID {ord_id}: {e}")
            return False
        except Exception as e:
            logger.error(f"❌ Error saving order {ord_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return False

    def create_trigger_sell_order(self, inst_id, fill_px, fill_sz, ord_id):
        """Create a trigger sell order at 20% above buy price using OKX trigger order"""
        try:
            # Calculate trigger price (20% above buy price) using Decimal for precision
            buy_price = Decimal(fill_px)
            trigger_price = buy_price * Decimal('1.20')  # 20% above buy price
            
            # Convert to string for API call (maintains precision)
            trigger_price_str = str(trigger_price)
            
            logger.info(f"🎯 Creating trigger sell order: {inst_id} @ {trigger_price_str} (+20%)")
            
            # Create trigger order using OKX algo order API
            result = self.trade_api.place_algo_order(
                instId=inst_id,
                tdMode="cash",  # SPOT trading mode
                side="sell",
                ordType="trigger",  # Trigger order
                sz=fill_sz,
                triggerPx=trigger_price_str,  # Trigger price
                orderPx="-1"  # -1 for market price execution
            )
            
            if result and result.get('code') == '0':
                algo_ord_id = result.get('data', [{}])[0].get('algoOrdId', '')
                logger.info(f"✅ Trigger sell order created: {algo_ord_id}")
            else:
                error_msg = result.get('msg', 'Unknown error') if result else 'No response'
                logger.error(f"❌ Failed to create trigger sell order: {error_msg}")
                if result:
                    logger.debug(f"Full API response: {result}")
                    
        except Exception as e:
            logger.error(f"❌ Exception creating trigger sell order: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")



    def fetch_and_save_filled_orders(self, minutes=None):
        """Fetch filled orders with minutes parameter"""
        try:
            # Calculate time range based on minutes
            end_time = datetime.now()
            begin_time = end_time - timedelta(minutes=minutes or 15)  # Default to 15 minutes

            # Use DB watermark if more recent than computed begin_time (with small overlap)
            latest_ts_ms = self.get_latest_order_ts()
            if latest_ts_ms:
                latest_dt = datetime.fromtimestamp(latest_ts_ms / 1000)
                adjusted_begin = latest_dt + timedelta(milliseconds=1)
                if adjusted_begin > begin_time:
                    logger.info(f"🧭 Using DB watermark (+1ms). Adjust begin from {begin_time.strftime('%H:%M:%S')} to {adjusted_begin.strftime('%H:%M:%S')}")
                    begin_time = adjusted_begin
            
            logger.info(f"🔍 Fetching orders: {begin_time.strftime('%H:%M')} → {end_time.strftime('%H:%M')}")
            
            # Get filled orders
            orders = self.get_filled_orders(begin_time, end_time)
            
            if not orders:
                logger.info("🎯 No filled orders found in the specified time range")
                return
            

            
            # Save orders to database
            successful_saves = 0
            failed_saves = 0
            
            for order in orders:
                if self.save_order_to_db(order):
                    successful_saves += 1
                else:
                    failed_saves += 1
            
            # Commit changes
            self.conn.commit()
            
            # Summary
            logger.info(f"📊 Summary: {successful_saves}/{len(orders)} saved")
            if failed_saves > 0:
                logger.warning(f"⚠️  Failed: {failed_saves}")
            
        except Exception as e:
            logger.error(f"❌ Error in fetch_and_save_filled_orders: {e}")
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
    parser = argparse.ArgumentParser(description='Fetch OKX filled limit orders and save to database')
    parser.add_argument('--minutes', type=int, default=15, help='Number of minutes to look back (default: 15)')
    args = parser.parse_args()
    
    # Determine time range
    time_description = f"last {args.minutes} minutes"
    
    logger.info(f"🚀 Starting OKX Filled Orders Fetch ({time_description})")
    
    exit_code = 0
    fetcher = None
    
    try:
        # Initialize fetcher
        fetcher = OKXFilledOrdersFetcher()
        
        # Fetch and save filled orders
        fetcher.fetch_and_save_filled_orders(minutes=args.minutes)
        
        logger.info("✅ Process completed")
        
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
        if fetcher:
            fetcher.close()
        
        end_time = datetime.now()
        duration = end_time - start_time
        logger.info(f"⏱️  Duration: {duration}")
        
        if exit_code != 0:
            logger.error(f"❌ Script failed with code: {exit_code}")
        
        # Exit with appropriate code
        sys.exit(exit_code)

if __name__ == "__main__":
    main()
