#!/usr/bin/env python3
"""
Script to find and cancel all pending OKX algo trigger orders
Uses OKX official Python SDK for API interactions
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
    # If dotenv is not available, try to load from environment directly
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
    log_file = f"{log_dir}/cancel_triggers_{timestamp}.log"
    
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

class OKXOrderManager:
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
        # Convert to OKX flag: true -> "1" (demo), false -> "0" (live)
        okx_flag = "1" if testnet.lower() == "true" else "0"
        
        # Initialize OKX Client
        self.okx_client = OKXClient()
        self.trade_api = self.okx_client.get_trade_api()
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_pending_algo_orders(self):
        """Get all pending algo orders with retry mechanism and pagination support"""
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
                    
                    all_orders.extend(orders)
                    logger.info(f"📋 Fetched {len(orders)} orders | Total: {len(all_orders)}")
                    
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
                    logger.error(f"❌ Failed to get pending orders: {error_msg}")
                    break
            
            logger.info(f"📋 Total pending algo orders found: {len(all_orders)}")
            return all_orders
                
        except Exception as e:
            logger.error(f"❌ Error getting pending orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def cancel_algo_orders_batch(self, orders_batch):
        """Cancel multiple algo orders in a single API call (max 10 per batch)"""
        try:
            # Create the params array as required by the API
            algo_orders = []
            for order in orders_batch:
                algo_orders.append({
                    "instId": order['instId'], 
                    "algoId": order['algoId']
                })
            
            result = self.trade_api.cancel_algo_order(algo_orders)
            
            if result.get('code') == '0':
                # Log successful batch cancellation
                order_ids = [order['algoId'] for order in orders_batch]
                inst_ids = [order['instId'] for order in orders_batch]
                logger.info(f"✅ Cancelled {len(orders_batch)} orders | Instruments: {', '.join(inst_ids)}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ Failed to cancel batch: {error_msg}")
                logger.debug(f"   Full response: {result}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error cancelling batch: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def cancel_algo_order(self, algo_id, inst_id):
        """Cancel a specific algo order with retry mechanism"""
        try:
            # Create the params array as required by the API
            algo_orders = [
                {"instId": inst_id, "algoId": algo_id}
            ]
            
            result = self.trade_api.cancel_algo_order(algo_orders)
            
            if result.get('code') == '0':
                logger.info(f"✅ Successfully cancelled algo order {algo_id} for {inst_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ Failed to cancel order {algo_id}: {error_msg}")
                logger.debug(f"   Full response: {result}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error cancelling order {algo_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    def cancel_all_pending_triggers(self):
        """Cancel all pending trigger orders"""
        try:
            logger.info("🚀 OKX Pending Trigger Order Canceller")
            logger.info("=" * 60)
            
            # Get all pending algo orders
            pending_orders = self.get_pending_algo_orders()
            
            if not pending_orders:
                logger.info("✅ No pending orders found")
                return
            
            logger.info("\n📋 Pending Orders Details:")
            logger.info("=" * 60)
            
            # Filter for trigger orders and display details
            trigger_orders = []
            for order in pending_orders:
                ord_type = order.get('ordType', '')
                if ord_type == 'trigger':
                    trigger_orders.append(order)
                    logger.info(f"🔍 {order.get('instId', 'N/A')} - {ord_type}")
                    logger.info(f"   Order ID: {order.get('algoId', 'N/A')}")
                    logger.info(f"   Side: {order.get('side', 'N/A')}")
                    logger.info(f"   Size: {order.get('sz', 'N/A')}")
                    logger.info(f"   Trigger Price: {order.get('triggerPx', 'N/A')}")
                    logger.info(f"   Order Price: {order.get('orderPx', 'N/A')}")
                    logger.info(f"   Status: {order.get('state', 'N/A')}")
                    logger.info("-" * 40)
            
            if not trigger_orders:
                logger.info("✅ No pending trigger orders found")
                return
            
            logger.info(f"\n🎯 Found {len(trigger_orders)} pending trigger orders")
            
            logger.info("\n🔄 Starting cancellation process...")
            logger.info("=" * 60)
            
            success_count = 0
            total_count = len(trigger_orders)
            failed_orders = []
            
            # Process orders in batches of 10
            batch_size = 10
            total_batches = (len(trigger_orders) + batch_size - 1) // batch_size
            
            # Track cancellation attempts
            max_attempts = 3
            attempt = 1
            remaining_orders = trigger_orders.copy()
            
            while remaining_orders and attempt <= max_attempts:
                logger.info(f"\n🔄 Cancellation attempt {attempt}/{max_attempts}")
                logger.info(f"   Remaining orders: {len(remaining_orders)}")
                logger.info("=" * 60)
                
                current_batch_size = min(batch_size, len(remaining_orders))
                total_current_batches = (len(remaining_orders) + current_batch_size - 1) // current_batch_size
                
                for i in range(0, len(remaining_orders), current_batch_size):
                    batch = remaining_orders[i : i + current_batch_size]
                    batch_num = i // current_batch_size + 1
                    logger.info(f"\n🔄 Processing batch {batch_num}/{total_current_batches}...")
                    logger.info(f"   Batch size: {len(batch)} orders")
                    
                    # Format batch for cancellation
                    batch_for_cancellation = []
                    for order in batch:
                        batch_for_cancellation.append({
                            'instId': order.get('instId', ''),
                            'algoId': order.get('algoId', '')
                        })
                    
                    try:
                        if self.cancel_algo_orders_batch(batch_for_cancellation):
                            success_count += len(batch)
                            logger.info(f"   ✅ Batch {batch_num} completed successfully")
                        else:
                            failed_orders.extend([(order.get('instId', ''), order.get('algoId', ''), f"API returned error (attempt {attempt})") for order in batch])
                            logger.error(f"   ❌ Batch {batch_num} failed")
                    except Exception as e:
                        logger.error(f"   ❌ Exception while cancelling batch {batch_num}: {e}")
                        failed_orders.extend([(order.get('instId', ''), order.get('algoId', ''), f"{str(e)} (attempt {attempt})") for order in batch])
                        continue
                    
                    # Rate limiting: OKX allows 20 requests per 2 seconds, so we can be more aggressive
                    # With batch size 10, we can process batches faster
                    if batch_num < total_current_batches:  # Don't sleep after the last batch
                        time.sleep(0.2)  # Reduced from 0.5s to 0.2s for batch processing
                
                # After this round, check if any orders remain
                if attempt < max_attempts:
                    logger.info(f"\n🔍 Verifying cancellation results (attempt {attempt})...")
                    time.sleep(2)  # Wait a bit for API to update
                    
                    try:
                        remaining_pending = self.get_pending_algo_orders()
                        remaining_trigger_orders = [order for order in remaining_pending if order.get('ordType') == 'trigger']
                        
                        if remaining_trigger_orders:
                            logger.warning(f"⚠️  {len(remaining_trigger_orders)} orders still pending after attempt {attempt}")
                            # Update remaining_orders for next attempt
                            remaining_orders = remaining_trigger_orders
                            attempt += 1
                        else:
                            logger.info("✅ All orders successfully cancelled!")
                            break
                    except Exception as e:
                        logger.error(f"❌ Error verifying cancellation results: {e}")
                        # If verification fails, assume we need to continue
                        attempt += 1
                else:
                    # Last attempt completed
                    if remaining_orders:
                        logger.error(f"❌ Failed to cancel all orders after {max_attempts} attempts")
                        logger.error(f"   {len(remaining_orders)} orders remain uncancelled")
                    break
            
            logger.info("\n" + "=" * 60)
            logger.info(f"📊 Summary: {success_count}/{total_count} orders cancelled successfully")
            
            if failed_orders:
                logger.warning(f"⚠️  Failed orders: {len(failed_orders)}")
                for inst_id, algo_id, reason in failed_orders:
                    logger.warning(f"   {inst_id} ({algo_id}): {reason}")
            
        except Exception as e:
            logger.error(f"❌ Error in cancel_all_pending_triggers: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

def main():
    try:
        # Check if .env file exists
        if not os.path.exists(".env"):
            logger.error("❌ Error: .env file not found in current directory")
            sys.exit(1)
        
        logger.info("🚀 Starting OKX Order Cancellation Process")
        logger.info(f"⏰ Start time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Create OKX client and cancel pending triggers
        okx_client = OKXOrderManager()
        okx_client.cancel_all_pending_triggers()
        
        logger.info("✅ Script completed successfully")
        logger.info(f"⏰ End time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
    except KeyboardInterrupt:
        logger.info("⚠️  Script interrupted by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}")
        logger.debug(f"Traceback: {traceback.format_exc()}")
        sys.exit(1)

if __name__ == "__main__":
    main()
