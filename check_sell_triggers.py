#!/usr/bin/env python3
"""
Check Sell Trigger Orders Script
Checks sell trigger orders and cancels those with balance < 1 USD
Runs every 5 minutes as part of the monitoring system
"""

import os
import sys
import logging
import logging.handlers
from datetime import datetime
import time
import traceback
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

# Load environment variables first
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    def load_dotenv():
        pass
    load_dotenv()

from okx_client import OKXClient

def setup_logging():
    """Setup logging configuration with rotation"""
    log_dir = "logs"
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = f"{log_dir}/check_sell_triggers_{timestamp}.log"
    
    # Create logger
    logger = logging.getLogger(__name__)
    logger.setLevel(logging.INFO)
    
    # Clear existing handlers
    logger.handlers.clear()
    
    # Create formatter
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    
    # File handler with rotation (max 10MB, keep 5 backups)
    file_handler = logging.handlers.RotatingFileHandler(
        log_file, 
        maxBytes=10*1024*1024,  # 10MB
        backupCount=5,
        encoding='utf-8'
    )
    file_handler.setFormatter(formatter)
    
    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    
    # Add handlers
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    
    return logger

logger = setup_logging()

class SellTriggerChecker:
    def __init__(self):
        self.api_key = os.getenv('OKX_API_KEY')
        self.secret_key = os.getenv('OKX_SECRET_KEY')
        self.passphrase = os.getenv('OKX_PASSPHRASE')
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            print("❌ Error: Missing OKX API credentials in environment variables")
            print("Please set: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE")
            sys.exit(1)
        
        # Get trading environment from environment variable
        testnet = os.getenv('OKX_TESTNET', 'false')
        okx_flag = "1" if testnet.lower() == "true" else "0"
        
        # Initialize OKX Client
        self.okx_client = OKXClient(logger)
        self.trade_api = self.okx_client.get_trade_api()
        self.account_api = self.okx_client.get_account_api()
        
        # Minimum USD value threshold
        self.min_usd_value = 1.0
        
        if not self.trade_api:
            logger.error("❌ Trade API not initialized")
            sys.exit(1)
        
        if not self.account_api:
            logger.error("❌ Account API not initialized")
            sys.exit(1)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_sell_trigger_orders(self):
        """Get all sell trigger orders with retry mechanism and pagination support"""
        try:
            all_orders = []
            limit = 100  # OKX API default limit
            after = None
            
            while True:
                # Prepare parameters for pagination
                params = {
                    "ordType": "trigger"  # Get trigger orders specifically
                }
                
                if after:
                    params["after"] = after
                
                # Use the order_algos_list method to get pending algo orders
                result = self.trade_api.order_algos_list(**params)
                
                if result.get('code') == '0':
                    orders = result.get('data', [])
                    if not orders:
                        break  # No more orders
                    
                    # Filter for sell trigger orders only
                    sell_orders = [order for order in orders if order.get('side') == 'sell']
                    all_orders.extend(sell_orders)
                    
                    logger.info(f"📋 Fetched {len(sell_orders)} sell trigger orders | Total: {len(all_orders)}")
                    
                    # Check if we got less than the limit (means it's the last page)
                    if len(orders) < limit:
                        break
                    
                    # Get the last order's ID for next page
                    after = orders[-1].get('algoId')
                    if not after:
                        break
                    
                    # Small delay to avoid rate limiting
                    time.sleep(0.1)
                else:
                    error_msg = result.get('msg', 'Unknown error')
                    logger.error(f"❌ Failed to get sell trigger orders: {error_msg}")
                    break
            
            logger.info(f"📋 Total sell trigger orders found: {len(all_orders)}")
            return all_orders
                
        except Exception as e:
            logger.error(f"❌ Error getting sell trigger orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism

    def get_balance_usd_value(self, inst_id):
        """Get USD value of balance for a specific instrument"""
        try:
            # Extract cryptocurrency code from inst_id (e.g., BTC-USDT -> BTC)
            base_ccy = inst_id.split('-')[0].upper()
            
            result = self.account_api.get_account_balance(ccy=base_ccy)
            logger.debug(f"🔍 Balance API response for {base_ccy}: {result}")
            
            if not result or result.get('code') != '0':
                logger.warning(f"⚠️ Cannot get {base_ccy} balance: {result}")
                return 0.0
            
            data = result.get('data', [])
            if not data:
                logger.warning(f"⚠️ Balance returned empty data for {base_ccy}: {result}")
                return 0.0
            
            details = data[0].get('details', [])
            
            for detail in details:
                ccy = detail.get('ccy', '').upper()
                if ccy == base_ccy:
                    # Get eqUsd value (USD equivalent)
                    eq_usd_str = detail.get('eqUsd', '0')
                    eq_usd_val = float(eq_usd_str) if eq_usd_str else 0.0
                    
                    # Also get available balance for logging
                    avail_str = detail.get('availBal')
                    avail_val = float(avail_str) if avail_str is not None else 0.0
                    
                    logger.info(f"💰 {base_ccy} balance: {avail_val} | USD value: ${eq_usd_val:.4f}")
                    return eq_usd_val
            
            logger.warning(f"⚠️ No balance information found for {base_ccy}")
            return 0.0
            
        except Exception as e:
            logger.error(f"❌ Error getting balance for {inst_id}: {e}")
            return 0.0

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def cancel_sell_trigger_order(self, algo_id, inst_id):
        """Cancel a specific sell trigger order with retry mechanism"""
        try:
            # Create the params array as required by the API
            algo_orders = [
                {"instId": inst_id, "algoId": algo_id}
            ]
            
            result = self.trade_api.cancel_algo_order(algo_orders)
            
            if result.get('code') == '0':
                logger.info(f"✅ Successfully cancelled sell trigger order {algo_id} for {inst_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ Failed to cancel sell trigger order {algo_id}: {error_msg}")
                logger.debug(f"   Full response: {result}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error cancelling sell trigger order {algo_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism

    def check_and_cancel_low_value_sell_triggers(self):
        """Check sell trigger orders and cancel those with balance < 1 USD"""
        try:
            logger.info("🚀 OKX Sell Trigger Order Checker")
            logger.info("=" * 60)
            
            # Get all sell trigger orders
            sell_orders = self.get_sell_trigger_orders()
            
            if not sell_orders:
                logger.info("✅ No sell trigger orders found")
                return
            
            logger.info(f"\n📋 Found {len(sell_orders)} sell trigger orders")
            logger.info("=" * 60)
            
            cancelled_count = 0
            kept_count = 0
            error_count = 0
            
            for order in sell_orders:
                inst_id = order.get('instId', 'N/A')
                algo_id = order.get('algoId', 'N/A')
                side = order.get('side', 'N/A')
                sz = order.get('sz', 'N/A')
                trigger_px = order.get('triggerPx', 'N/A')
                
                logger.info(f"\n🔍 Checking order: {inst_id}")
                logger.info(f"   Order ID: {algo_id}")
                logger.info(f"   Side: {side}")
                logger.info(f"   Size: {sz}")
                logger.info(f"   Trigger Price: {trigger_px}")
                
                # Get current balance USD value
                usd_value = self.get_balance_usd_value(inst_id)
                
                if usd_value < self.min_usd_value:
                    logger.warning(f"💰 {inst_id} USD value (${usd_value:.4f}) < ${self.min_usd_value}, cancelling order")
                    
                    try:
                        if self.cancel_sell_trigger_order(algo_id, inst_id):
                            cancelled_count += 1
                            logger.info(f"✅ Cancelled {inst_id} order {algo_id}")
                        else:
                            error_count += 1
                            logger.error(f"❌ Failed to cancel {inst_id} order {algo_id}")
                    except Exception as e:
                        error_count += 1
                        logger.error(f"❌ Exception cancelling {inst_id} order {algo_id}: {e}")
                else:
                    kept_count += 1
                    logger.info(f"✅ {inst_id} USD value (${usd_value:.4f}) >= ${self.min_usd_value}, keeping order")
                
                # Rate limiting: small delay between orders
                time.sleep(0.2)
            
            # Summary
            logger.info("\n" + "=" * 60)
            logger.info(f"📊 Summary:")
            logger.info(f"   Total sell trigger orders: {len(sell_orders)}")
            logger.info(f"   Cancelled (low value): {cancelled_count}")
            logger.info(f"   Kept (sufficient value): {kept_count}")
            logger.info(f"   Errors: {error_count}")
            logger.info("=" * 60)
            
        except Exception as e:
            logger.error(f"❌ Error in check_and_cancel_low_value_sell_triggers: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

def main():
    try:
        # Allow running without .env in CI; rely on environment variables from runner
        if not os.path.exists(".env"):
            logger.info("ℹ️ .env not found; using environment variables from environment/CI")
        
        logger.info("🚀 Starting OKX Sell Trigger Order Checker")
        logger.info(f"⏰ Start time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Create checker and process sell triggers
        checker = SellTriggerChecker()
        checker.check_and_cancel_low_value_sell_triggers()
        
        logger.info("✅ Script completed successfully")
        logger.info(f"⏰ End time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
    except KeyboardInterrupt:
        logger.info("⚠️ Script interrupted by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}")
        logger.debug(f"Traceback: {traceback.format_exc()}")
        sys.exit(1)

if __name__ == "__main__":
    main()
