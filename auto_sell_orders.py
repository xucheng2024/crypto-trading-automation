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
import sqlite3
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
        self.init_database()
        
        self.logger.info(f"🚀 Auto Sell Orders - {'Demo' if self.testnet else 'Live'} mode | Min USD: ${self.min_usd_value}")

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
        
        self.logger.info(f"🗄️  Database: {self.db_path}")

    def load_auto_sell_config(self):
        """Load auto-sell configuration from limits.json"""
        try:
            import json
            with open('limits.json', 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            min_usd = config.get('auto_sell_config', {}).get('min_usd_value', 0.01)
            self.logger.info(f"⚙️  Auto-sell config loaded: Min USD value = ${min_usd}")
            return min_usd
            
        except Exception as e:
            self.logger.warning(f"⚠️  Failed to load auto-sell config, using default: ${0.01} - {e}")
            return 0.01

    def get_orders_ready_to_sell(self):
        """Get all orders that are ready to sell (sell_time < current_time)"""
        current_time = int(datetime.now().timestamp() * 1000)
        
        self.cursor.execute('''
            SELECT instId, ordId, fillSz, side, ts, sell_time, fillPx
            FROM filled_orders 
            WHERE sell_time IS NOT NULL 
            AND sold_status IS NULL
            AND CAST(sell_time AS INTEGER) <= ? 
            AND side = 'buy'
            ORDER BY CAST(sell_time AS INTEGER) ASC
        ''', (current_time,))
        
        orders = self.cursor.fetchall()
        
        if orders:
            self.logger.info(f"🔍 Found {len(orders)} orders ready to sell")
            for order in orders:
                inst_id, ord_id, fill_sz, side, ts, sell_time, fill_px = order
                sell_time_str = datetime.fromtimestamp(int(sell_time)/1000).strftime('%H:%M:%S')
                buy_price = self.format_price(fill_px)
                self.logger.info(f"   📋 {inst_id} | ordId: {ord_id} | Size: {fill_sz} | Buy: ${buy_price} | Sell: {sell_time_str}")
        
        return orders

    def mark_order_processing(self, order_id):
        """Mark order as PROCESSING to avoid duplicate processing"""
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = 'PROCESSING'
                WHERE ordId = ? AND sold_status IS NULL
            ''', (order_id,))
            self.conn.commit()
            if self.cursor.rowcount == 1:
                self.logger.info(f"🔒 Locked order for processing: {order_id}")
                return True
            else:
                self.logger.info(f"⏭️  Skip, already taken or processed: {order_id}")
                return False
        except Exception as e:
            self.logger.error(f"❌ Error locking order {order_id}: {e}")
            return False

    def clear_order_processing(self, order_id):
        """Clear PROCESSING status to allow future retries on failure"""
        try:
            self.cursor.execute('''
                UPDATE filled_orders 
                SET sold_status = NULL
                WHERE ordId = ? AND sold_status = 'PROCESSING'
            ''', (order_id,))
            self.conn.commit()
            self.logger.info(f"🔓 Cleared processing lock: {order_id}")
        except Exception as e:
            self.logger.error(f"❌ Error clearing processing for {order_id}: {e}")

    def get_available_balance(self, inst_id):
        """Get available balance for a specific instrument"""
        try:
            # 从inst_id中提取币种代码 (例如: NMR-USDT -> NMR)
            base_ccy = inst_id.split('-')[0].upper()
            
            account_api = self.okx_client.get_account_api()
            if not account_api:
                self.logger.warning(f"⚠️ Account API 未初始化，无法获取 {base_ccy} 交易账户余额")
                return 0.0, 0.0  # Return (balance, eqUsd)
            
            result = account_api.get_account_balance(ccy=base_ccy)
            self.logger.info(f"🔍 交易账户余额API返回: {result}")
            
            if not result or result.get('code') != '0':
                self.logger.warning(f"⚠️ 无法获取 {base_ccy} 交易账户余额: {result}")
                return 0.0, 0.0
            
            data = result.get('data', [])
            if not data:
                self.logger.warning(f"⚠️ 交易账户余额返回空数据: {result}")
                return 0.0, 0.0
            
            details = data[0].get('details', [])
            self.logger.info(f"📊 交易账户详情条目: {len(details)} | 返回币种: {[d.get('ccy') for d in details][:20]}")
            
            for detail in details:
                ccy = detail.get('ccy', '').upper()
                if ccy == base_ccy:
                    # 优先使用 availBal；若缺失或为0，回退到 availEq（交易账户可用权益）
                    avail_str = detail.get('availBal')
                    avail_val = float(avail_str) if avail_str is not None else 0.0
                    if avail_val <= 0:
                        eq_str = detail.get('availEq')
                        if eq_str is not None:
                            try:
                                avail_val = float(eq_str)
                            except Exception:
                                pass
                    
                    # 获取 eqUsd 值（USD等值）
                    eq_usd_str = detail.get('eqUsd', '0')
                    eq_usd_val = float(eq_usd_str) if eq_usd_str else 0.0
                    
                    self.logger.info(f"💰 {base_ccy} 交易账户可用: {avail_val} | USD等值: ${eq_usd_val}")
                    return avail_val, eq_usd_val
            
            self.logger.warning(f"⚠️ 未在交易账户详情中找到 {base_ccy} 的余额信息")
            return 0.0, 0.0
            
        except Exception as e:
            self.logger.error(f"❌ 获取 {inst_id} 余额时出错: {e}")
            return 0.0, 0.0

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    def place_market_sell_order(self, inst_id, size, order_id):
        """Place market sell order with retry mechanism"""
        self.logger.info(f"📤 Selling {inst_id}: {size} tokens")
        
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
            
            # 检查是否是余额不足导致的失败
            if "insufficient" in error_msg.lower() or "balance" in error_msg.lower() or "all operations failed" in error_msg.lower():
                self.logger.warning(f"⚠️ 检测到可能的余额不足，尝试获取实际余额...")
                actual_balance, eq_usd = self.get_available_balance(inst_id)
                
                # 使用 eqUsd 判断是否值得卖出（如果USD等值小于配置的阈值，认为不值得卖出）
                if eq_usd < self.min_usd_value:
                    self.logger.warning(f"💰 {inst_id} USD等值过小 (${eq_usd:.4f}) < ${self.min_usd_value}，不值得卖出，标记为已处理")
                    # 即使不卖出，也标记为已处理，避免重复检查
                    return "INSUFFICIENT_VALUE"
                
                if actual_balance > 0:  # 移除 0.0001 限制，只要有余额就尝试卖出
                    self.logger.info(f"🔄 余额不足，按实际余额卖出: {actual_balance} tokens (USD等值: ${eq_usd:.4f})")
                    # 按实际余额重新下单
                    result = self.trade_api.place_order(
                        instId=inst_id,
                        tdMode="cash",
                        side="sell",
                        ordType="market",
                        sz=str(actual_balance),
                        tgtCcy="base_ccy"
                    )
                    
                    if result and result.get('code') == '0':
                        okx_order_id = result.get('data', [{}])[0].get('ordId', 'Unknown')
                        self.logger.info(f"✅ 按实际余额卖出成功: {inst_id} | Size: {actual_balance} | USD等值: ${eq_usd:.4f} | Order: {okx_order_id}")
                        return True
                    else:
                        self.logger.error(f"❌ 按实际余额卖出也失败: {result.get('msg', 'Unknown error')}")
                        return False
                else:
                    # 余额为0，无法卖出
                    self.logger.warning(f"💰 {inst_id} 余额为0，无法卖出")
                    return False
            
            self.logger.error(f"❌ Sell failed for {inst_id}: {error_msg}")
            return False
        
        okx_order_id = result.get('data', [{}])[0].get('ordId', 'Unknown')
        self.logger.info(f"✅ Sold {inst_id} | Size: {size} | Order: {okx_order_id}")
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
            self.logger.info(f"✅ Order {order_id} marked as sold")
            
            # Play notification sound
            self.play_sell_notification_sound()
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Error marking order {order_id} as sold: {e}")
            return False

    def play_sell_notification_sound(self):
        """Play 10-second notification sound on macOS"""
        try:
            self.logger.info("🔊 Playing sell notification sound...")
            
            start_time = time.time()
            while time.time() - start_time < 10:
                os.system('osascript -e "beep"')
                time.sleep(0.5)
            
            self.logger.info("🔊 Notification sound completed")
            
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
                self.logger.info(f"🔄 Processing: {inst_id} | ordId: {ord_id} | Buy: ${formatted_price}")
                
                # Lock this order to prevent duplicate processing (intra-run or concurrent)
                if not self.mark_order_processing(ord_id):
                    continue
                
                sell_result = self.place_market_sell_order(inst_id, fill_sz, ord_id)
                
                if sell_result == True:  # 成功卖出
                    if self.mark_order_as_sold(ord_id):
                        successful_sells += 1
                    else:
                        self.logger.warning(f"⚠️  Order {ord_id} sold but failed to update database")
                        successful_sells += 1
                elif sell_result == "INSUFFICIENT_VALUE":  # USD等值过小，标记为已处理
                    if self.mark_order_as_sold(ord_id):
                        self.logger.info(f"✅ Order {ord_id} marked as sold (insufficient USD value)")
                        successful_sells += 1
                    else:
                        self.logger.warning(f"⚠️  Order {ord_id} insufficient value but failed to update database")
                        failed_sells += 1
                else:  # 卖出失败
                    # Clear PROCESSING to allow future retry
                    self.clear_order_processing(ord_id)
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
