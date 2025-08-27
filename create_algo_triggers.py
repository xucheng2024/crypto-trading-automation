#!/usr/bin/env python3
"""
Script to create OKX algo trigger orders based on limits.json configuration
Uses OKX official Python SDK for API interactions
"""

import json
import os
import sys
import logging
from datetime import datetime, timezone
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
        logging.FileHandler('algo_triggers.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Configure logging
def setup_logging():
    """Setup logging configuration"""
    log_dir = "logs"
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = f"{log_dir}/algo_triggers_{timestamp}.log"
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(sys.stdout)
        ]
    )
    return logging.getLogger(__name__)

logger = setup_logging()

class OKXAlgoTrigger:
    def __init__(self, order_size="1000"):
        self.api_key = os.getenv('OKX_API_KEY')
        self.secret_key = os.getenv('OKX_SECRET_KEY')
        self.passphrase = os.getenv('OKX_PASSPHRASE')
        
        # Order size in USDT (for buy orders) or base currency (for sell orders)
        self.order_size = order_size
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            print("❌ Error: Missing OKX API credentials in environment variables")
            print("Please set: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE")
            sys.exit(1)
        
        # Initialize OKX SDK clients
        self.market_client = Market(
            key=self.api_key,
            secret=self.secret_key,
            passphrase=self.passphrase,
            flag="1"  # 0: live trading, 1: demo trading
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
    def get_daily_open_price(self, inst_id):
        """Get today's open price for a trading pair using OKX SDK with retry mechanism"""
        try:
            # Get daily candlestick data (much simpler than 1m intervals)
            result = self.market_client.get_candles(
                instId=inst_id,
                bar="1D",
                limit="1"  # Just get today's daily candle
            )
            
            if result.get('code') == '0' and result.get('data'):
                data = result['data']
                if data:
                    open_price = float(data[0][1])  # Open price is at index 1
                    logger.info(f"📊 {inst_id} daily open price: {open_price}")
                    return open_price
            
            error_msg = result.get('msg', 'Unknown error')
            logger.error(f"❌ Failed to get open price for {inst_id}: {error_msg}")
            return None
            
        except Exception as e:
            logger.error(f"❌ Error getting open price for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def create_algo_trigger_order(self, inst_id, limit_coefficient, open_price):
        """Create algo trigger order using OKX SDK with retry mechanism"""
        try:
            # Calculate trigger price
            trigger_price = open_price * limit_coefficient / 100
            
            # Use trigger price directly without precision adjustment
            trigger_price_str = str(trigger_price)
                
            logger.info(f"🎯 {inst_id} trigger price: {trigger_price} (limit: {limit_coefficient}%)")
            
            # Calculate token quantity based on USDT amount
            usdt_amount = float(self.order_size)
            token_quantity = usdt_amount / float(trigger_price)
            
            # Format token quantity with appropriate precision
            if token_quantity < 0.0001:
                adjusted_order_size = f"{token_quantity:.8f}"
            elif token_quantity < 0.01:
                adjusted_order_size = f"{token_quantity:.6f}"
            else:
                adjusted_order_size = f"{token_quantity:.4f}"
            
            logger.info(f"📊 {inst_id} order size: {adjusted_order_size} tokens")
            
            # Create trigger order using OKX TradeAPI
            result = self.trade_api.place_algo_order(
                instId=inst_id,
                tdMode="cash",
                side="buy",
                ordType="trigger",
                sz=adjusted_order_size,
                triggerPx=trigger_price_str,
                orderPx=trigger_price_str
            )
            
            if result.get('code') == '0':
                order_id = result.get('data', [{}])[0].get('ordId', 'N/A')
                logger.info(f"✅ Successfully created algo trigger order for {inst_id}")
                logger.info(f"   Order ID: {order_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ Failed to create order for {inst_id}: {error_msg}")
                logger.debug(f"   Full response: {result}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error creating algo trigger order for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    def process_limits_file(self, limits_file="limits.json"):
        """Process limits.json and create algo trigger orders"""
        try:
            # Read limits.json
            with open(limits_file, 'r') as f:
                limits_data = json.load(f)
            
            crypto_configs = limits_data.get('crypto_configs', {})
            logger.info(f"📋 Found {len(crypto_configs)} crypto pairs in {limits_file}")
            logger.info("=" * 60)
            
            success_count = 0
            total_count = len(crypto_configs)
            failed_pairs = []
            
            for inst_id, config in crypto_configs.items():
                best_limit = config.get('best_limit')
                if best_limit is None:
                    logger.warning(f"⚠️  Skipping {inst_id}: no best_limit found")
                    continue
                
                logger.info(f"\n🔄 Processing {inst_id}...")
                
                try:
                    # Get daily open price
                    open_price = self.get_daily_open_price(inst_id)
                    if open_price is None:
                        logger.warning(f"⚠️  Skipping {inst_id}: could not get open price")
                        failed_pairs.append((inst_id, "Failed to get open price"))
                        continue
                    
                    # Create algo trigger order
                    if self.create_algo_trigger_order(inst_id, best_limit, open_price):
                        success_count += 1
                    else:
                        failed_pairs.append((inst_id, "Failed to create order"))
                    
                except Exception as e:
                    logger.error(f"❌ Error processing {inst_id}: {e}")
                    failed_pairs.append((inst_id, str(e)))
                    continue
                
                # Rate limiting: OKX allows 5 requests per 2 seconds
                time.sleep(0.5)
            
            logger.info("\n" + "=" * 60)
            logger.info(f"📊 Summary: {success_count}/{total_count} orders created successfully")
            
            if failed_pairs:
                logger.warning(f"⚠️  Failed pairs: {len(failed_pairs)}")
                for pair, reason in failed_pairs:
                    logger.warning(f"   {pair}: {reason}")
            
        except FileNotFoundError:
            logger.error(f"❌ Error: {limits_file} not found")
        except json.JSONDecodeError:
            logger.error(f"❌ Error: Invalid JSON in {limits_file}")
        except Exception as e:
            logger.error(f"❌ Error processing {limits_file}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")

def main():
    try:
        logger.info("🚀 OKX Algo Trigger Order Creator (Using Official SDK)")
        logger.info("=" * 60)
        
        # Check if limits.json exists
        if not os.path.exists("limits.json"):
            logger.error("❌ Error: limits.json not found in current directory")
            sys.exit(1)
        
        # Use default order size or get from environment variable
        order_size = os.getenv('OKX_ORDER_SIZE', '170')
        logger.info(f"📊 Using order size: {order_size} USDT")
        logger.info("=" * 60)
        
        # Create OKX client and process limits
        okx_client = OKXAlgoTrigger(order_size=order_size)
        okx_client.process_limits_file()
        
        logger.info("✅ Script completed successfully")
        
    except KeyboardInterrupt:
        logger.info("⚠️  Script interrupted by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}")
        logger.debug(f"Traceback: {traceback.format_exc()}")
        sys.exit(1)

if __name__ == "__main__":
    main()
