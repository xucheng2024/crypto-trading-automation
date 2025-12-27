#!/usr/bin/env python3
"""
Automated Filled Order Tracking System
Monitors completed orders and calculates trade times for automated trading
"""

import os
import sys
import time
import json
import logging
import logging.handlers
import traceback
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP, getcontext
# import sqlite3  # Migrated to PostgreSQL
import psycopg2
from psycopg2.extras import RealDictCursor

# Set Decimal precision
getcontext().prec = 28

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
            logger.info(f"🔑 API: {'✅ Configured' if self.api_key else '❌ Not Configured'}")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize OKX API: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise



    # Removed get_latest_order_utime() - no longer needed since we always query last 1 hour



    def get_last_trade_timestamp(self):
        """Get the timestamp of the last trade from database"""
        try:
            self.cursor.execute('''
                SELECT MAX(CAST(ts AS BIGINT)) as last_ts
                FROM filled_orders 
                WHERE ts IS NOT NULL AND ts != ''
            ''')
            result = self.cursor.fetchone()
            if result and result[0]:
                return int(result[0])
            return None
        except Exception as e:
            logger.warning(f"⚠️ Failed to get last trade timestamp: {e}")
            return None

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_filled_trades(self, begin_ts=None, limit=100):
        """Get filled trades using get_fills API with retry mechanism"""
        try:
            logger.debug("🔍 Fetching filled trades...")
            
            # Prepare parameters for get_fills (transaction details)
            params = {
                'instType': 'SPOT',
                'limit': str(limit)
            }
            
            # Add time filter if provided
            if begin_ts:
                params['begin'] = str(begin_ts)
            
            result = self.trade_api.get_fills(**params)
            
            if not result:
                logger.warning("⚠️  Empty response from API")
                return []
            
            # Log the full API response for debugging
            logger.debug(f"🔍 Full API response: {result}")
            
            if result.get('code') == '0':
                trades = result.get('data', [])
                logger.info(f"📋 Found {len(trades)} total trades")
                
                # Filter for buy trades only (SDK doesn't support subType parameter)
                buy_trades = [trade for trade in trades if trade.get('side') == 'buy']
                logger.info(f"📋 Filtered to {len(buy_trades)} buy trades (removed {len(trades) - len(buy_trades)} sell trades)")
                
                # Log trade details for debugging
                if buy_trades:
                    logger.debug(f"📝 Trade sides found: {list(set(trade.get('side', 'unknown') for trade in buy_trades))}")
                    logger.debug(f"📝 Sub types found: {list(set(trade.get('subType', 'unknown') for trade in buy_trades))}")
                    # Log first trade structure for debugging
                    if len(buy_trades) > 0:
                        logger.debug(f"📝 First trade structure: {list(buy_trades[0].keys())}")
                
                return buy_trades
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ API Error getting filled orders: {error_msg}")
                logger.debug(f"Full API response: {result}")
                return []
                
        except Exception as e:
            logger.error(f"❌ Exception getting filled trades: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism

    def save_trade_to_db(self, trade):
        """Save a single trade to database"""
        try:
            # Extract required fields from trade data
            inst_id = trade.get('instId', '')
            ord_id = trade.get('ordId', '')
            trade_id = trade.get('tradeId', '')
            bill_id = trade.get('billId', '')
            fill_px = trade.get('fillPx', '')
            fill_sz = trade.get('fillSz', '')
            side = trade.get('side', '')
            
            # Use ts field from trade data
            ts = trade.get('ts', '')
            
            # Calculate sell time (ts + 30 hours)
            sell_time = None
            if ts:
                try:
                    # Convert timestamp to UTC datetime and add 30 hours
                    ts_datetime = datetime.utcfromtimestamp(int(ts) / 1000)
                    sell_time_datetime = ts_datetime + timedelta(hours=30)
                    sell_time = str(int(sell_time_datetime.timestamp() * 1000))
                except (ValueError, TypeError) as e:
                    logger.warning(f"⚠️  Could not calculate sell time for order {ord_id}: {e}")
            
            # Validate required fields
            if not all([inst_id, trade_id, fill_px, fill_sz, side]):
                logger.warning(f"⚠️  Skipping trade with missing required data: {trade}")
                return False
            
            # Prepare data for insertion
            data = {
                'instId': inst_id,
                'ordId': ord_id,
                'tradeId': trade_id,
                'billId': bill_id,
                'fillPx': fill_px,
                'fillSz': fill_sz,
                'side': side,
                'ts': ts,
                'subType': trade.get('subType', ''),
                'execType': trade.get('execType', ''),
                'fee': trade.get('fee', ''),
                'feeCcy': trade.get('feeCcy', ''),
                'feeRate': trade.get('feeRate', ''),
                'fillTime': trade.get('fillTime', ''),
                'posSide': trade.get('posSide', ''),
                'clOrdId': trade.get('clOrdId', ''),
                'tag': trade.get('tag', ''),
                'sell_time': sell_time
            }
            
            # Insert new trade; update existing trade but preserve sell_time and sold_status
            self.cursor.execute('''
                INSERT INTO filled_orders 
                (instId, ordId, tradeId, billId, fillPx, fillSz, side, ts, subType, execType, fee, feeCcy, feeRate, fillTime, posSide, clOrdId, tag, sell_time)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (tradeId) DO UPDATE SET
                    fillPx = EXCLUDED.fillPx,
                    fillSz = EXCLUDED.fillSz,
                    fee = EXCLUDED.fee,
                    feeCcy = EXCLUDED.feeCcy,
                    feeRate = EXCLUDED.feeRate,
                    fillTime = EXCLUDED.fillTime,
                    execType = EXCLUDED.execType
                    -- sell_time and sold_status are preserved (not updated)
            ''', (
                data['instId'], data['ordId'], data['tradeId'], data['billId'], data['fillPx'], data['fillSz'], 
                data['side'], data['ts'], data['subType'], data['execType'], data['fee'], data['feeCcy'], 
                data['feeRate'], data['fillTime'], data['posSide'], data['clOrdId'], data['tag'], data['sell_time']
            ))

            # Log the result of insert/update
            if self.cursor.rowcount == 1:
                logger.debug(f"✅ Trade inserted/updated: {trade_id}")
            else:
                logger.debug(f"⚠️  Unexpected rowcount: {self.cursor.rowcount} for trade: {trade_id}")
                return False
            
            # Log successful trade save
            if self.cursor.rowcount == 1 and side == 'buy' and fill_px and fill_sz:
                logger.info(f"💰 New buy trade saved: {inst_id} @ {fill_px} x {fill_sz}")
            
            return True
            
        except Exception as e:  # PostgreSQL compatible
            logger.warning(f"⚠️  Duplicate trade ID {trade_id}: {e}")
            return False
        except Exception as e:
            logger.error(f"❌ Error saving trade {trade_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return False




    def fetch_and_save_filled_trades(self, minutes=None):
        """Fetch filled trades using incremental approach based on last trade timestamp"""
        try:
            # Get the timestamp of the last trade from database
            last_trade_ts = self.get_last_trade_timestamp()
            
            if last_trade_ts:
                # Start from the next microsecond after the last trade
                begin_ts = last_trade_ts + 1
                logger.info(f"🧭 Incremental fetch: from {begin_ts} (last trade + 1μs)")
            else:
                # First run: get trades from the last specified minutes
                end_time = datetime.utcnow()
                begin_time = end_time - timedelta(minutes=minutes or 15)
                begin_ts = int(begin_time.timestamp() * 1000)
                logger.info(f"🧭 Initial fetch: last {minutes or 15} minutes from {begin_ts}")
            
            # Get filled trades
            trades = self.get_filled_trades(begin_ts=begin_ts)
            
            if not trades:
                logger.info("🎯 No new filled trades found")
                return
            
            # Save trades to database
            successful_saves = 0
            failed_saves = 0
            
            for trade in trades:
                if self.save_trade_to_db(trade):
                    successful_saves += 1
                else:
                    failed_saves += 1
            
            # Commit changes
            self.conn.commit()
            
            # Summary
            logger.info(f"📊 Summary: {successful_saves}/{len(trades)} trades saved")
            if failed_saves > 0:
                logger.warning(f"⚠️  Failed: {failed_saves}")
            
            # Check if 4+ orders are in trading, cancel all trigger orders if so
            self.check_and_cancel_triggers_if_needed()
            
            # Check and create sell trigger orders for active trades
            self.check_and_create_sell_triggers()
            
        except Exception as e:
            logger.error(f"❌ Error in fetch_and_save_filled_trades: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise







    def count_active_trading_currencies(self):
        """Count active trading orders (not sold yet) - includes multiple orders per currency"""
        try:
            self.cursor.execute('''
                SELECT COUNT(*) as order_count
                FROM filled_orders 
                WHERE side = 'buy' 
                AND (sold_status IS NULL OR sold_status != 'SOLD')
            ''')
            result = self.cursor.fetchone()
            if result and result[0] is not None:
                return int(result[0])
            return 0
        except Exception as e:
            logger.warning(f"⚠️ Failed to count active trading orders: {e}")
            return 0

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_pending_algo_orders(self):
        """Get all pending algo trigger orders"""
        try:
            all_orders = []
            limit = 100
            after = None
            
            while True:
                params = {
                    "ordType": "trigger"
                }
                
                if after:
                    params["after"] = after
                
                result = self.trade_api.order_algos_list(**params)
                
                if result.get('code') == '0':
                    orders = result.get('data', [])
                    if not orders:
                        break
                    
                    all_orders.extend(orders)
                    
                    if len(orders) < limit:
                        break
                    
                    after = orders[-1].get('algoId')
                    if not after:
                        break
                    
                    time.sleep(0.1)
                else:
                    error_msg = result.get('msg', 'Unknown error')
                    logger.error(f"❌ Failed to get pending orders: {error_msg}")
                    break
            
            return all_orders
                
        except Exception as e:
            logger.error(f"❌ Error getting pending orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def cancel_algo_orders_batch(self, orders_batch):
        """Cancel multiple algo orders in a single API call (max 10 per batch)"""
        try:
            algo_orders = []
            for order in orders_batch:
                algo_orders.append({
                    "instId": order['instId'], 
                    "algoId": order['algoId']
                })
            
            result = self.trade_api.cancel_algo_order(algo_orders)
            
            if result.get('code') == '0':
                order_ids = [order['algoId'] for order in orders_batch]
                inst_ids = [order['instId'] for order in orders_batch]
                logger.info(f"✅ Cancelled {len(orders_batch)} trigger orders | Instruments: {', '.join(inst_ids)}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ Failed to cancel batch: {error_msg}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error cancelling batch: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def cancel_all_trigger_orders(self):
        """Cancel all pending trigger orders"""
        try:
            logger.info("🔍 Checking for pending trigger orders...")
            pending_orders = self.get_pending_algo_orders()
            
            if not pending_orders:
                logger.info("✅ No pending trigger orders found")
                return
            
            # Filter for trigger orders (all types)
            trigger_orders = [order for order in pending_orders if order.get('ordType') == 'trigger']
            
            if not trigger_orders:
                logger.info("✅ No pending trigger orders found")
                return
            
            logger.info(f"🎯 Found {len(trigger_orders)} pending trigger orders to cancel")
            
            # Process orders in batches of 10
            batch_size = 10
            success_count = 0
            
            for i in range(0, len(trigger_orders), batch_size):
                batch = trigger_orders[i : i + batch_size]
                batch_num = i // batch_size + 1
                total_batches = (len(trigger_orders) + batch_size - 1) // batch_size
                
                logger.info(f"🔄 Processing batch {batch_num}/{total_batches}...")
                
                try:
                    if self.cancel_algo_orders_batch(batch):
                        success_count += len(batch)
                    
                    if batch_num < total_batches:
                        time.sleep(0.2)
                except Exception as e:
                    logger.error(f"❌ Exception while cancelling batch {batch_num}: {e}")
                    continue
            
            logger.info(f"📊 Summary: {success_count}/{len(trigger_orders)} trigger orders cancelled")
            
        except Exception as e:
            logger.error(f"❌ Error cancelling trigger orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def check_and_cancel_triggers_if_needed(self):
        """Check if 4+ orders are in trading, cancel all trigger orders if so"""
        try:
            active_count = self.count_active_trading_currencies()
            logger.info(f"📊 Currently {active_count} active trading orders")
            
            if active_count >= 4:
                logger.warning(f"⚠️  {active_count} active trading orders (>= 4), cancelling all trigger orders...")
                self.cancel_all_trigger_orders()
            else:
                logger.info(f"✅ {active_count} active trading orders (< 4), no action needed")
        except Exception as e:
            logger.error(f"❌ Error checking trading orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")

    def get_active_trading_orders(self):
        """Get all active trading orders (not sold yet, buy orders)"""
        try:
            self.cursor.execute('''
                SELECT instId, tradeId, fillSz, fillPx, ts
                FROM filled_orders 
                WHERE sold_status IS NULL
                  AND side = 'buy'
                ORDER BY CAST(ts AS BIGINT) ASC
            ''')
            return self.cursor.fetchall()
        except Exception as e:
            logger.error(f"❌ Error getting active trading orders: {e}")
            return []

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_pending_trigger_orders_for_inst(self, inst_id):
        """Get pending trigger orders for a specific instrument"""
        try:
            all_orders = []
            limit = 100
            after = None
            
            while True:
                params = {"ordType": "trigger"}
                if after:
                    params["after"] = after
                
                result = self.trade_api.order_algos_list(**params)
                
                if result.get('code') == '0':
                    orders = result.get('data', [])
                    if not orders:
                        break
                    
                    # Filter for this inst_id and trigger type
                    filtered_orders = [order for order in orders 
                                     if order.get('instId') == inst_id and order.get('ordType') == 'trigger']
                    all_orders.extend(filtered_orders)
                    
                    if len(orders) < limit:
                        break
                    
                    after = orders[-1].get('algoId')
                    if not after:
                        break
                    
                    time.sleep(0.1)
                else:
                    break
            
            return all_orders
        except Exception as e:
            logger.error(f"❌ Error getting pending trigger orders for {inst_id}: {e}")
            return []

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def create_sell_trigger_order(self, inst_id, buy_price, fill_sz):
        """Create a sell trigger order at 115% of buy price (15% profit)"""
        try:
            # Calculate trigger price: buy_price * 1.15 (115% = +15% profit)
            buy_price_decimal = Decimal(str(buy_price))
            trigger_price = buy_price_decimal * Decimal('1.15')
            
            # Calculate precision based on price value
            if trigger_price < Decimal('0.00001'):
                precision = 9
            elif trigger_price < Decimal('0.01'):
                precision = 6
            else:
                precision = 4
            
            # Round trigger price
            precision_context = Decimal('0.' + '0' * (precision - 1) + '1') if precision > 0 else Decimal('1')
            trigger_price = trigger_price.quantize(precision_context, rounding=ROUND_HALF_UP)
            
            # Format order size (use fill_sz from buy order)
            fill_sz_decimal = Decimal(str(fill_sz))
            if fill_sz_decimal < Decimal('0.0001'):
                order_size = f"{fill_sz_decimal:.8f}"
            elif fill_sz_decimal < Decimal('0.01'):
                order_size = f"{fill_sz_decimal:.6f}"
            else:
                order_size = f"{fill_sz_decimal:.4f}"
            
            logger.info(f"📈 {inst_id} | Creating sell trigger: ${trigger_price} (buy: ${buy_price} +15%) | Size: {order_size}")
            
            # Create sell trigger order
            result = self.trade_api.place_algo_order(
                instId=inst_id,
                tdMode="cash",
                side="sell",
                ordType="trigger",
                sz=order_size,
                triggerPx=str(trigger_price),
                orderPx=str(trigger_price)
            )
            
            if result.get('code') == '0':
                order_id = result.get('data', [{}])[0].get('ordId', 'N/A')
                logger.info(f"✅ {inst_id} sell trigger order created successfully - Order ID: {order_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ {inst_id} sell trigger order failed: {error_msg}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error creating sell trigger order for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return False

    def check_and_create_sell_triggers(self):
        """Check all active trades and create sell trigger at 115% if not exists"""
        try:
            logger.info("\n🔍 Checking active trades for sell trigger orders...")
            
            # Get all active trading orders
            active_orders = self.get_active_trading_orders()
            
            if not active_orders:
                logger.info("✅ No active trading orders found")
                return
            
            logger.info(f"📊 Found {len(active_orders)} active trading orders")
            
            created_count = 0
            skipped_count = 0
            failed_count = 0
            
            for order in active_orders:
                inst_id, trade_id, fill_sz, fill_px, ts = order
                
                try:
                    # Get existing trigger orders for this instrument
                    pending_triggers = self.get_pending_trigger_orders_for_inst(inst_id)
                    
                    # Calculate target trigger price (115% of buy price)
                    buy_price = Decimal(str(fill_px))
                    target_trigger_price = buy_price * Decimal('1.15')
                    
                    # Check if there's already a sell trigger at 115% (±1% tolerance)
                    has_sell_trigger = False
                    for trigger in pending_triggers:
                        if trigger.get('side') == 'sell':
                            trigger_px = Decimal(str(trigger.get('triggerPx', '0')))
                            # Check if trigger price is within 1% of target (114% to 116%)
                            price_diff = abs(trigger_px - target_trigger_price) / target_trigger_price
                            if price_diff <= Decimal('0.01'):  # 1% tolerance
                                has_sell_trigger = True
                                logger.debug(f"✅ {inst_id} already has sell trigger at ${trigger_px} (target: ${target_trigger_price})")
                                break
                    
                    if has_sell_trigger:
                        skipped_count += 1
                        logger.debug(f"⏭️  {inst_id} - Sell trigger already exists, skipping")
                    else:
                        # Create sell trigger order
                        if self.create_sell_trigger_order(inst_id, fill_px, fill_sz):
                            created_count += 1
                        else:
                            failed_count += 1
                        
                        # Rate limiting
                        time.sleep(0.2)
                        
                except Exception as e:
                    logger.error(f"❌ Error processing {inst_id}: {e}")
                    failed_count += 1
                    continue
            
            logger.info(f"\n📊 Sell Trigger Summary:")
            logger.info(f"   Created: {created_count}")
            logger.info(f"   Skipped (already exists): {skipped_count}")
            logger.info(f"   Failed: {failed_count}")
            
        except Exception as e:
            logger.error(f"❌ Error in check_and_create_sell_triggers: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")

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
        
        # Fetch and save filled trades
        fetcher.fetch_and_save_filled_trades(minutes=args.minutes)
        
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
