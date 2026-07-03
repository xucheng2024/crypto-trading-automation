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
from datetime import datetime, timedelta, timezone
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
        """Initialize OKX API connection and defer database connection until needed"""
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

            self.conn = None
            self.cursor = None
            self.database_initialized = False
            
            logger.info(f"🚀 OKX Filled Orders Fetcher - {'Demo' if self.testnet else 'Live'}")
            logger.info(f"🔑 API: {'✅ Configured' if self.api_key else '❌ Not Configured'}")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize OKX API: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    def ensure_database_initialized(self):
        """Connect to PostgreSQL only when persistence or DB-backed checks are required."""
        if self.database_initialized:
            return

        from lib.database import get_database_connection

        self.conn = get_database_connection()
        self.cursor = self.conn.cursor()
        self.database_initialized = True
        logger.info("✅ Connected to PostgreSQL database")

    def has_recent_buy_fills(self, hours=48, limit=100):
        """Check recent OKX buy fills before touching the database."""
        begin_time = datetime.utcnow() - timedelta(hours=hours)
        begin_ts = int(begin_time.timestamp() * 1000)

        logger.info(f"🧪 Pre-checking OKX buy fills for the last {hours} hours")

        try:
            trades = self.get_filled_trades(begin_ts=begin_ts, limit=limit)
            logger.info(f"🧪 Pre-check found {len(trades)} recent buy fills")
            return len(trades) > 0
        except Exception as e:
            logger.warning(f"⚠️ Recent fill pre-check failed, falling back to DB-backed flow: {e}")
            return None



    # Removed get_latest_order_utime() - no longer needed since we always query last 1 hour



    def get_last_trade_timestamp(self):
        """Get the timestamp of the last trade from database"""
        try:
            self.ensure_database_initialized()
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

    def prepare_trade_data(self, trade):
        """Prepare trade data for database insertion"""
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
            
            # 新加坡时间策略：当天买入，次日 23:55 触发卖出
            sell_time = None
            if ts:
                try:
                    sgt = timezone(timedelta(hours=8))
                    ts_utc = datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
                    ts_sgt = ts_utc.astimezone(sgt)
                    buy_date_sgt = ts_sgt.date()
                    next_day_sgt = buy_date_sgt + timedelta(days=1)
                    sell_time_sgt = datetime(
                        next_day_sgt.year, next_day_sgt.month, next_day_sgt.day, 23, 55, 0, tzinfo=sgt
                    )
                    sell_time = str(int(sell_time_sgt.timestamp() * 1000))
                except (ValueError, TypeError) as e:
                    logger.warning(f"⚠️  Could not calculate sell time for order {ord_id}: {e}")
            
            # Validate required fields
            if not all([inst_id, trade_id, fill_px, fill_sz, side]):
                logger.warning(f"⚠️  Skipping trade with missing required data: {trade}")
                return None
            
            # Return tuple for batch insert
            return (
                inst_id, ord_id, trade_id, bill_id, fill_px, fill_sz, side, ts,
                trade.get('subType', ''), trade.get('execType', ''),
                trade.get('fee', ''), trade.get('feeCcy', ''), trade.get('feeRate', ''),
                trade.get('fillTime', ''), trade.get('posSide', ''),
                trade.get('clOrdId', ''), trade.get('tag', ''), sell_time
            )
        except Exception as e:
            logger.error(f"❌ Error preparing trade data: {e}")
            return None

    def save_trades_batch(self, trades):
        """Save multiple trades to database using batch insert (optimized)"""
        if not trades:
            return 0, 0
        
        try:
            self.ensure_database_initialized()
            # Prepare all trade data
            trade_data_list = []
            valid_trades = []
            
            for trade in trades:
                trade_data = self.prepare_trade_data(trade)
                if trade_data:
                    trade_data_list.append(trade_data)
                    valid_trades.append(trade)
            
            if not trade_data_list:
                logger.warning("⚠️  No valid trades to save")
                return 0, len(trades)
            
            # Batch insert using executemany
            self.cursor.executemany('''
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
            ''', trade_data_list)
            
            # Single commit for all trades
            self.conn.commit()
            
            # Log successful trades
            successful_count = len(trade_data_list)
            for trade in valid_trades:
                inst_id = trade.get('instId', '')
                trade_id = trade.get('tradeId', '')
                fill_px = trade.get('fillPx', '')
                fill_sz = trade.get('fillSz', '')
                side = trade.get('side', '')
                
                if side == 'buy' and fill_px and fill_sz:
                    logger.info(f"💰 New buy trade saved: {inst_id} @ {fill_px} x {fill_sz}")
                else:
                    logger.debug(f"✅ Trade inserted/updated: {trade_id}")
            
            failed_count = len(trades) - successful_count
            logger.info(f"📊 Batch saved {successful_count}/{len(trades)} trades")
            
            return successful_count, failed_count
            
        except Exception as e:
            logger.error(f"❌ Error in batch save: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            self.conn.rollback()
            return 0, len(trades)



    def fetch_and_save_filled_trades(self, minutes=None):
        """Fetch filled trades using incremental approach based on last trade timestamp"""
        try:
            self.ensure_database_initialized()
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
            
            # Save trades to database using batch insert (optimized)
            successful_saves, failed_saves = self.save_trades_batch(trades)
            
            # Summary
            logger.info(f"📊 Summary: {successful_saves}/{len(trades)} trades saved")
            if failed_saves > 0:
                logger.warning(f"⚠️  Failed: {failed_saves}")
            
            # Check if 4+ orders are in trading, cancel all trigger orders if so
            self.check_and_cancel_triggers_if_needed()
            
        except Exception as e:
            logger.error(f"❌ Error in fetch_and_save_filled_trades: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise







    def auto_mark_manual_sells(self):
        """自动检测并标记手动卖出的订单（通过检查账户余额）"""
        try:
            self.ensure_database_initialized()
            # 获取所有未标记为已卖的币种
            self.cursor.execute('''
                SELECT DISTINCT instId
                FROM filled_orders 
                WHERE side = 'buy' 
                AND (sold_status IS NULL OR sold_status != 'SOLD')
            ''')
            
            unsold_instruments = [row[0] for row in self.cursor.fetchall()]
            
            if not unsold_instruments:
                return
            
            logger.info(f"🔍 Checking balances for {len(unsold_instruments)} instruments with unsold orders")
            
            marked_count = 0
            
            # 检查每个币种的余额
            for inst_id in unsold_instruments:
                try:
                    base_ccy = inst_id.split('-')[0].upper()
                    
                    # 获取账户余额
                    account_api = self.okx_client.get_account_api()
                    if not account_api:
                        continue
                    
                    result = account_api.get_account_balance(ccy=base_ccy)
                    
                    if not result or result.get('code') != '0':
                        continue
                    
                    data = result.get('data', [])
                    if not data:
                        continue
                    
                    details = data[0].get('details', [])
                    balance = 0.0
                    
                    for detail in details:
                        if detail.get('ccy', '').upper() == base_ccy:
                            avail_str = detail.get('availBal')
                            if avail_str:
                                balance = float(avail_str)
                            break
                    
                    # 如果余额为0或非常小（< 0.0001），标记为已卖出
                    if balance < 0.0001:
                        logger.info(f"💰 {inst_id}: Balance is {balance}, marking all orders as SOLD")
                        
                        # 标记该币种的所有订单为已卖出
                        self.cursor.execute('''
                            UPDATE filled_orders 
                            SET sold_status = 'SOLD'
                            WHERE side = 'buy' 
                            AND instId = %s
                            AND (sold_status IS NULL OR sold_status != 'SOLD')
                        ''', (inst_id,))
                        
                        self.conn.commit()
                        affected = self.cursor.rowcount
                        
                        if affected > 0:
                            marked_count += affected
                            logger.info(f"✅ Marked {affected} {inst_id} orders as SOLD (manual sell detected)")
                    
                    # Rate limiting
                    time.sleep(0.1)
                    
                except Exception as e:
                    logger.warning(f"⚠️ Error checking balance for {inst_id}: {e}")
                    continue
            
            if marked_count > 0:
                logger.info(f"📊 Auto-marked {marked_count} manually sold orders")
            
        except Exception as e:
            logger.error(f"❌ Error in auto_mark_manual_sells: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")

    def count_active_trading_currencies(self):
        """Count active trading orders (not sold yet) - includes multiple orders per currency"""
        try:
            self.ensure_database_initialized()
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
            # 首先自动检测并标记手动卖出的订单
            self.auto_mark_manual_sells()
            
            # 然后统计真实的持仓数
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


    def close(self):
        """Close database connection"""
        if getattr(self, 'conn', None):
            self.conn.close()
            logger.info("🗄️  Database connection closed")

def main():
    """Main function"""
    start_time = datetime.now()
    
    # Parse command line arguments
    import argparse
    parser = argparse.ArgumentParser(description='Fetch OKX filled limit orders and save to database')
    parser.add_argument('--minutes', type=int, default=15, help='Number of minutes to look back (default: 15)')
    parser.add_argument('--precheck-hours', type=int, default=48, help='Skip DB if OKX has no buy fills in this recent window (default: 48)')
    parser.add_argument('--force-db', action='store_true', help='Bypass OKX pre-check and force the legacy DB-backed flow')
    args = parser.parse_args()
    
    # Determine time range
    time_description = f"last {args.minutes} minutes"
    
    logger.info(f"🚀 Starting OKX Filled Orders Fetch ({time_description})")
    
    exit_code = 0
    fetcher = None
    
    try:
        # Initialize fetcher
        fetcher = OKXFilledOrdersFetcher()

        should_run_db_flow = args.force_db
        if args.force_db:
            logger.info("🛡️ Force DB fetch enabled, bypassing OKX pre-check")
        else:
            precheck_result = fetcher.has_recent_buy_fills(hours=args.precheck_hours)
            if precheck_result is False:
                logger.info("💤 No recent OKX buy fills detected, skipping Neon connection")
            else:
                should_run_db_flow = True

        if should_run_db_flow:
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
