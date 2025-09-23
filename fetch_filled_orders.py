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
            
        except Exception as e:
            logger.error(f"❌ Error in fetch_and_save_filled_trades: {e}")
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
