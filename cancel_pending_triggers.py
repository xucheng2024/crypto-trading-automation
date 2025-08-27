#!/usr/bin/env python3
"""
Script to find and cancel all pending OKX algo trigger orders
Uses OKX official Python SDK for API interactions
"""

import os
import sys
import logging
from datetime import datetime
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # If dotenv is not available, try to load from environment directly
    def load_dotenv():
        pass
    load_dotenv()
import time
import traceback
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from okx.api import Market
from okx import Trade



# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('cancel_triggers.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class OKXOrderManager:
    def __init__(self):
        self.api_key = os.getenv('OKX_API_KEY')
        self.secret_key = os.getenv('OKX_SECRET_KEY')
        self.passphrase = os.getenv('OKX_PASSPHRASE')
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            print("❌ Error: Missing OKX API credentials in environment variables")
            print("Please set: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE")
            sys.exit(1)
        
        # Initialize OKX SDK clients
        self.market_client = Market(
            key=self.api_key,
            secret=self.secret_key,
            passphrase=self.passphrase,
            flag=okx_flag  # Use environment variable setting
        )
        
        # Get trading environment from environment variable
        testnet = os.getenv('OKX_TESTNET', 'true')
        # Convert to OKX flag: true -> "1" (demo), false -> "0" (live)
        okx_flag = "1" if testnet.lower() == "true" else "0"
        
        self.trade_api = Trade.TradeAPI(
            api_key=self.api_key,
            api_secret_key=self.secret_key,
            passphrase=self.passphrase,
            flag=okx_flag  # 0: live trading, 1: demo trading
        )
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_pending_algo_orders(self):
        """Get all pending algo orders with retry mechanism"""
        try:
            # Use the order_algos_list method to get pending algo orders
            result = self.trade_api.order_algos_list(
                ordType="trigger"  # Get trigger orders specifically
            )
            
            if result.get('code') == '0':
                orders = result.get('data', [])
                logger.info(f"📋 Found {len(orders)} pending algo orders")
                return orders
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ Failed to get pending orders: {error_msg}")
                return []
                
        except Exception as e:
            logger.error(f"❌ Error getting pending orders: {e}")
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
            
            for order in trigger_orders:
                inst_id = order.get('instId', '')
                algo_id = order.get('algoId', '')
                
                logger.info(f"\n🔄 Cancelling {inst_id}...")
                
                try:
                    if self.cancel_algo_order(algo_id, inst_id):
                        success_count += 1
                    else:
                        failed_orders.append((inst_id, algo_id, "API returned error"))
                except Exception as e:
                    logger.error(f"❌ Exception while cancelling {inst_id}: {e}")
                    failed_orders.append((inst_id, algo_id, str(e)))
                    continue
                
                # Rate limiting: OKX allows 5 requests per 2 seconds
                time.sleep(0.5)
            
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
