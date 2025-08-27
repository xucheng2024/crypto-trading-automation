#!/usr/bin/env python3
"""
OKX Pending Limit Order Canceller
Cancels all pending limit orders under the current account
"""

import os
import sys
import logging
import traceback
import time
from datetime import datetime
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # If dotenv is not available, try to load from environment directly
    def load_dotenv():
        pass
    load_dotenv()
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type, RetryError
from okx_client import OKXClient

# Load environment variables
load_dotenv()

# Configure logging with rotation
def setup_logging():
    """Setup logging with file rotation"""
    log_filename = f"cancel_limits_{datetime.now().strftime('%Y%m%d')}.log"
    
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

class OKXLimitOrderManager:
    def __init__(self):
        """Initialize OKX API connection"""
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
            
            logger.info("🚀 OKX Pending Limit Order Canceller")
            logger.info("============================================================")
            logger.info(f"🔧 Trading Environment: {'Demo' if self.testnet else 'Live'}")
            logger.info(f"🔑 API Key: {self.api_key[:8]}...{self.api_key[-4:] if len(self.api_key) > 12 else '***'}")
            logger.info("============================================================")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize OKX API: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_pending_limit_orders(self, side=None):
        """Get all pending limit orders with retry mechanism"""
        try:
            logger.debug("🔍 Fetching pending limit orders...")
            result = self.trade_api.get_order_list(
                instType="SPOT",
                ordType="limit"  # Get limit orders specifically
            )
            
            if not result:
                logger.warning("⚠️  Empty response from API")
                return []
            
            if result.get('code') == '0':
                all_orders = result.get('data', [])
                
                # Filter orders by side if specified
                if side:
                    orders = [order for order in all_orders if order.get('side', '').lower() == side.lower()]
                    logger.info(f"📋 Found {len(orders)} pending limit {side} orders (out of {len(all_orders)} total)")
                else:
                    orders = all_orders
                    logger.info(f"📋 Found {len(orders)} pending limit orders")
                
                # Log order details for debugging
                if orders:
                    logger.debug(f"📝 Order types found: {list(set(order.get('ordType', 'unknown') for order in orders))}")
                    logger.debug(f"📝 Order sides found: {list(set(order.get('side', 'unknown') for order in orders))}")
                    logger.debug(f"📝 Order states found: {list(set(order.get('state', 'unknown') for order in orders))}")
                
                return orders
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ API Error getting pending orders: {error_msg}")
                logger.debug(f"Full API response: {result}")
                return []
                
        except Exception as e:
            logger.error(f"❌ Exception getting pending orders: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def cancel_limit_order(self, ord_id, inst_id):
        """Cancel a specific limit order with retry mechanism"""
        try:
            logger.debug(f"🔄 Attempting to cancel order {ord_id} for {inst_id}")
            result = self.trade_api.cancel_order(
                instId=inst_id,
                ordId=ord_id
            )
            
            if not result:
                logger.warning(f"⚠️  Empty response when cancelling order {ord_id}")
                return False
            
            if result.get('code') == '0':
                data = result.get('data', [{}])
                if not data:
                    logger.warning(f"⚠️  No data in response when cancelling order {ord_id}")
                    return False
                
                order_data = data[0]
                s_code = order_data.get('sCode')
                s_msg = order_data.get('sMsg', 'No message')
                
                if s_code == '0':
                    logger.info(f"✅ Successfully cancelled limit order {ord_id} for {inst_id}")
                    return True
                else:
                    logger.error(f"❌ Failed to cancel order {ord_id}: {s_msg} (sCode: {s_code})")
                    logger.debug(f"Full cancel response: {result}")
                    return False
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ API Error cancelling order {ord_id}: {error_msg}")
                logger.debug(f"Full API response: {result}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Exception cancelling order {ord_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism



    def cancel_all_pending_limits(self, side=None):
        """Cancel all pending limit orders"""
        try:
            # Get pending orders
            side_text = f" {side}" if side else ""
            logger.info(f"🔍 Fetching pending limit{side_text} orders...")
            pending_orders = self.get_pending_limit_orders(side)
            
            if not pending_orders:
                logger.info("🎯 No pending limit orders to cancel")
                return
            
            logger.info(f"🎯 Found {len(pending_orders)} pending limit orders")
            logger.info("🔄 Starting cancellation process...")
            logger.info("============================================================")
            
            # Track results
            successful_cancellations = 0
            failed_orders = []
            skipped_orders = 0
            
            # Cancel each order
            total_orders = len(pending_orders)
            for index, order in enumerate(pending_orders, 1):
                inst_id = order.get('instId')
                ord_id = order.get('ordId')
                
                # Validate order data
                if not inst_id or not ord_id:
                    logger.warning(f"⚠️  Skipping order with missing data: {order}")
                    skipped_orders += 1
                    continue
                
                # Log progress
                logger.info(f"🔄 Cancelling {inst_id}... ({index}/{total_orders})")
                
                try:
                    if self.cancel_limit_order(ord_id, inst_id):
                        successful_cancellations += 1
                    else:
                        failed_orders.append(f"{inst_id}: {ord_id}")
                except RetryError as e:
                    logger.error(f"❌ Max retries exceeded for order {ord_id}: {e}")
                    failed_orders.append(f"{inst_id}: {ord_id} (retry failed)")
                except Exception as e:
                    logger.error(f"❌ Unexpected error cancelling order {ord_id}: {e}")
                    failed_orders.append(f"{inst_id}: {ord_id} (unexpected error)")
                
                # Rate limiting delay
                if index < total_orders:  # Don't delay after the last order
                    time.sleep(0.5)
            
            # Summary
            logger.info("============================================================")
            logger.info(f"📊 Summary: {successful_cancellations}/{total_orders} orders cancelled successfully")
            
            if skipped_orders > 0:
                logger.info(f"⏭️  Skipped orders: {skipped_orders}")
            
            if failed_orders:
                logger.warning(f"⚠️  Failed orders: {len(failed_orders)}")
                for failed in failed_orders:
                    logger.warning(f"   {failed}")
            
            success_rate = (successful_cancellations / total_orders * 100) if total_orders > 0 else 0
            logger.info(f"📈 Success rate: {success_rate:.1f}%")
            logger.info("✅ Script completed successfully")
            
        except Exception as e:
            logger.error(f"❌ Error in cancel_all_pending_limits: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise

def main():
    """Main function"""
    start_time = datetime.now()
    
    # Parse command line arguments
    import argparse
    parser = argparse.ArgumentParser(description='Cancel OKX pending limit orders')
    parser.add_argument('--side', choices=['buy', 'sell'], help='Only cancel orders with specified side (buy or sell)')
    args = parser.parse_args()
    
    side_text = f" ({args.side})" if args.side else ""
    logger.info(f"🚀 Starting OKX Limit Order Cancellation Process{side_text}")
    logger.info(f"⏰ Start time: {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    exit_code = 0
    
    try:
        # Initialize order manager
        logger.info("🔧 Initializing OKX API connection...")
        order_manager = OKXLimitOrderManager()
        
        # Cancel all pending limit orders (with optional side filter)
        order_manager.cancel_all_pending_limits(args.side)
        
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
