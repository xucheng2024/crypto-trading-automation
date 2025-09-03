#!/usr/bin/env python3
"""
Auto Sell Orders Script
Automatically sells orders when sell_time is reached
Simple and optimized version
"""

import os
import sys
import logging
import logging.handlers
# import sqlite3  # Migrated to PostgreSQL
import time
from datetime import datetime, timedelta
from decimal import Decimal, getcontext
from tenacity import retry, stop_after_attempt, wait_exponential

# Set Decimal precision for consistency with create_algo_triggers.py
getcontext().prec = 28

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

def setup_logging():
    """Setup logging with file rotation"""
    log_filename = f"auto_sell_orders_{datetime.now().strftime('%Y%m%d')}.log"
    os.makedirs('logs', exist_ok=True)
    log_path = os.path.join('logs', log_filename)
    
    # Create logger
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
        encoding='utf-8'
    )
    file_handler.setFormatter(formatter)
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    
    # Add handlers
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    
    return logger

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
        
        # Load auto-sell configuration
        self.min_usd_value = self.load_auto_sell_config()
        
        # Initialize OKX Client
        self.okx_client = OKXClient(self.logger)
        self.trade_api = self.okx_client.get_trade_api()
        
        # Initialize database
        from lib.database import get_database_connection
        self.conn = get_database_connection()
        self.cursor = self.conn.cursor()
        self.logger.info("✅ Connected to PostgreSQL database")
        
        self.logger.info(f"🚀 Auto Sell Orders - {'Demo' if self.testnet else 'Live'} mode | Min USD: ${self.min_usd_value}")

    def format_price(self, price_str):
        """Format price string using Decimal for consistency"""
        try:
            if price_str:
                return str(Decimal(str(price_str)))
            return price_str
        except:
            return price_str



    def load_auto_sell_config(self):
        """Load auto-sell configuration from database"""
        try:
            from config_manager import ConfigManager
            config_manager = ConfigManager(self.logger)
            config = config_manager.load_full_config()
            
            min_usd = config.get('auto_sell_config', {}).get('min_usd_value', 0.01)
            self.logger.info(f"⚙️  Auto-sell config loaded from database: Min USD value = ${min_usd}")
            return min_usd
            
        except Exception as e:
            self.logger.warning(f"⚠️  Failed to load auto-sell config from database, using default: ${0.01} - {e}")
            return 0.01

    def get_orders_ready_to_sell(self):
        """Get all orders that are ready to sell (sell_time < current_time)"""
        # Use UTC time to match sell_time calculation in fetch_filled_orders.py
        current_time = int(datetime.utcnow().timestamp() * 1000)
        
        self.cursor.execute('''
            SELECT instId, ordId, tradeId, fillSz, side, ts, sell_time, fillPx
            FROM filled_orders 
            WHERE sell_time IS NOT NULL 
              AND sold_status IS NULL
              AND CAST(sell_time AS BIGINT) <= %s 
              AND side = 'buy'
            ORDER BY CAST(sell_time AS BIGINT) ASC
        ''', (current_time,))
        
        orders = self.cursor.fetchall()
        
        if orders:
            self.logger.info(f"🔍 Found {len(orders)} orders ready to sell")
            for order in orders:
                inst_id, ord_id, trade_id, fill_sz, side, ts, sell_time, fill_px = order
                # Display sell_time in UTC for consistency
                sell_time_str = datetime.utcfromtimestamp(int(sell_time)/1000).strftime('%H:%M:%S UTC')
                buy_price = self.format_price(fill_px)
                self.logger.info(f"   📋 {inst_id} | ordId: {ord_id} | tradeId: {trade_id} | fillSz: {fill_sz} | Buy: ${buy_price} | Sell: {sell_time_str}")
        
        return orders

    def mark_trade_processing(self, trade_id):
        """Mark trade as PROCESSING to avoid duplicate processing"""
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = 'PROCESSING'
                WHERE tradeId = %s AND sold_status IS NULL
            ''', (trade_id,))
            self.conn.commit()
            if self.cursor.rowcount == 1:
                self.logger.info(f"🔒 Locked trade for processing: {trade_id}")
                return True
            else:
                self.logger.info(f"⏭️  Skip, already taken or processed: {trade_id}")
                return False
        except Exception as e:
            self.logger.error(f"❌ Error locking trade {trade_id}: {e}")
            return False

    def clear_trade_processing(self, trade_id):
        """Clear PROCESSING status to allow future retries on failure"""
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = NULL
                WHERE tradeId = %s AND sold_status = 'PROCESSING'
            ''', (trade_id,))
            self.conn.commit()
            self.logger.info(f"🔓 Cleared processing lock: {trade_id}")
        except Exception as e:
            self.logger.error(f"❌ Error clearing processing for {trade_id}: {e}")

    def get_available_balance(self, inst_id):
        """Get available balance for a specific instrument"""
        try:
            # Extract cryptocurrency code from inst_id (e.g., NMR-USDT -> NMR)
            base_ccy = inst_id.split('-')[0].upper()
            
            account_api = self.okx_client.get_account_api()
            if not account_api:
                self.logger.warning(f"⚠️ Account API not initialized, cannot get {base_ccy} trading account balance")
                return 0.0, 0.0  # Return (balance, eqUsd)
            
            result = account_api.get_account_balance(ccy=base_ccy)
            self.logger.info(f"🔍 Trading account balance API returned: {result}")
            
            if not result or result.get('code') != '0':
                self.logger.warning(f"⚠️ Cannot get {base_ccy} trading account balance: {result}")
                return 0.0, 0.0
            
            data = result.get('data', [])
            if not data:
                self.logger.warning(f"⚠️ Trading account balance returned empty data: {result}")
                return 0.0, 0.0
            
            details = data[0].get('details', [])
            self.logger.info(f"📊 Trading account detail entries: {len(details)} | Returned currencies: {[d.get('ccy') for d in details][:20]}")
            
            for detail in details:
                ccy = detail.get('ccy', '').upper()
                if ccy == base_ccy:
                    # Prioritize availBal; if missing or 0, fall back to availEq (trading account available equity)
                    avail_str = detail.get('availBal')
                    avail_val = float(avail_str) if avail_str is not None else 0.0
                    if avail_val <= 0:
                        eq_str = detail.get('availEq')
                        if eq_str is not None:
                            try:
                                avail_val = float(eq_str)
                            except Exception:
                                pass
                    
                    # Get eqUsd value (USD equivalent)
                    eq_usd_str = detail.get('eqUsd', '0')
                    eq_usd_val = float(eq_usd_str) if eq_usd_str else 0.0
                    
                    self.logger.info(f"💰 {base_ccy} trading account available: {avail_val} | USD equivalent: ${eq_usd_val}")
                    return avail_val, eq_usd_val
            
            self.logger.warning(f"⚠️ No balance information found for {base_ccy} in trading account details")
            return 0.0, 0.0
            
        except Exception as e:
            self.logger.error(f"❌ Error getting balance for {inst_id}: {e}")
            return 0.0, 0.0

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    def place_market_sell_order(self, inst_id, size, order_id):
        """Place market sell order - check balance first, then decide sell amount"""
        self.logger.info(f"📤 Processing {inst_id}: requested size={size}")
        
        # Step 1: Check current balance first
        actual_balance, eq_usd = self.get_available_balance(inst_id)
        
        # Step 2: Check if balance is worth selling
        if eq_usd < self.min_usd_value:
            self.logger.warning(f"💰 {inst_id} USD equivalent too small (${eq_usd:.4f}) < ${self.min_usd_value}, not worth selling")
            return "INSUFFICIENT_VALUE"
        
        if actual_balance <= 0:
            self.logger.warning(f"💰 {inst_id} Balance is 0, cannot sell")
            return False
        
        # Step 3: Determine sell amount - use requested size if available, otherwise use full balance
        from decimal import Decimal
        requested_size = Decimal(str(size))
        available_balance = Decimal(str(actual_balance))
        
        if available_balance >= requested_size:
            sell_amount = str(requested_size)
            self.logger.info(f"💰 {inst_id} Sufficient balance ({actual_balance}) >= requested ({size}), selling requested amount")
        else:
            sell_amount = str(available_balance)
            self.logger.info(f"💰 {inst_id} Insufficient balance ({actual_balance}) < requested ({size}), selling full balance")
        
        # Step 4: Execute the sell order
        self.logger.info(f"📤 Selling {inst_id}: {sell_amount} tokens (USD equivalent: ${eq_usd:.4f})")
        
        result = self.trade_api.place_order(
            instId=inst_id,
            tdMode="cash",
            side="sell",
            ordType="market",
            sz=sell_amount,
            tgtCcy="base_ccy"  # Explicitly specify selling by base currency quantity
        )
        
        if not result or result.get('code') != '0':
            error_msg = result.get('msg', 'Unknown error') if result else 'Empty response'
            self.logger.error(f"❌ Sell failed for {inst_id}: {error_msg}")
            return False
        
        okx_order_id = result.get('data', [{}])[0].get('ordId', 'Unknown')
        self.logger.info(f"✅ Sold {inst_id} | Size: {sell_amount} | USD equivalent: ${eq_usd:.4f} | Order: {okx_order_id}")
        return True

    def mark_trade_as_sold(self, trade_id):
        """Mark trade as sold in database"""
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = 'SOLD'
                WHERE tradeId = %s
            ''', (trade_id,))
            
            self.conn.commit()
            self.logger.info(f"✅ Trade {trade_id} marked as sold")
            

            return True
            
        except Exception as e:
            self.logger.error(f"❌ Error marking trade {trade_id} as sold: {e}")
            return False



    def process_sell_orders(self):
        """Process all orders ready to sell"""
        orders = self.get_orders_ready_to_sell()
        
        if not orders:
            return
        
        successful_sells = 0
        failed_sells = 0
        
        for order in orders:
            inst_id, ord_id, trade_id, fill_sz, side, ts, sell_time, fill_px = order
            
            try:
                formatted_price = self.format_price(fill_px)
                self.logger.info(f"🔄 Processing: {inst_id} | ordId: {ord_id} | tradeId: {trade_id} | Buy: ${formatted_price} | fillSz: {fill_sz}")
                
                # Lock this trade to prevent duplicate processing (intra-run or concurrent)
                if not self.mark_trade_processing(trade_id):
                    continue
                
                sell_result = self.place_market_sell_order(inst_id, fill_sz, trade_id)
                
                if sell_result == True:  # Successfully sold
                    if self.mark_trade_as_sold(trade_id):
                        successful_sells += 1
                    else:
                        self.logger.warning(f"⚠️  Trade {trade_id} sold but failed to update database")
                        successful_sells += 1
                elif sell_result == "INSUFFICIENT_VALUE":  # USD equivalent too small, mark as processed
                    if self.mark_trade_as_sold(trade_id):
                        self.logger.info(f"✅ Trade {trade_id} marked as sold (insufficient USD value)")
                        successful_sells += 1
                    else:
                        self.logger.warning(f"⚠️  Trade {trade_id} insufficient value but failed to update database")
                        failed_sells += 1
                else:  # Selling failed
                    # Clear PROCESSING to allow future retry
                    self.clear_trade_processing(trade_id)
                    failed_sells += 1
                
                # Rate limiting: wait 0.1 seconds between orders
                time.sleep(0.1)
                
            except Exception as e:
                # Clear PROCESSING on unexpected error to avoid stuck state
                try:
                    self.clear_order_processing(ord_id)
                except Exception:
                    pass
                failed_sells += 1
                self.logger.error(f"❌ Error processing sell order {ord_id}: {e}")
                continue
        
        # Summary
        if successful_sells > 0 or failed_sells > 0:
            self.logger.info("─" * 50)
            self.logger.info(f"📊 Summary: {successful_sells} sold, {failed_sells} failed")
            self.logger.info("─" * 50)

    def run_continuous_monitoring(self, interval_minutes=15):
        """Run continuous monitoring with specified interval"""
        self.logger.info(f"🔄 Continuous monitoring - check every {interval_minutes}min")
        self.logger.info("⏹️  Press Ctrl+C to stop")
        
        try:
            while True:
                start_time = datetime.now()
                self.logger.info(f"⏰ Cycle: {start_time.strftime('%H:%M:%S')}")
                
                self.process_sell_orders()
                
                # Calculate sleep time
                cycle_duration = (datetime.now() - start_time).total_seconds()
                sleep_time = max(0, (interval_minutes * 60) - cycle_duration)
                
                self.logger.info(f"⏱️  Cycle: {cycle_duration:.1f}s | Sleep: {sleep_time:.1f}s")
                
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
    
    logger.info(f"🚀 OKX Auto Sell Orders - {'continuous' if args.continuous else 'once'}")
    logger.info(f"⏰ Start: {start_time.strftime('%H:%M:%S')}")
    
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
        logger.info(f"⏱️  Duration: {duration}")
        logger.info("✅ Script finished" if exit_code == 0 else f"❌ Script finished (code: {exit_code})")
        
        sys.exit(exit_code)

if __name__ == "__main__":
    main()
