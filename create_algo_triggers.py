#!/usr/bin/env python3
"""
Script to create OKX algo trigger orders based on limits.json configuration
Uses OKX official Python SDK for API interactions
"""

import json
import os
import sys
import logging
import logging.handlers
from datetime import datetime, timezone
from decimal import Decimal, getcontext
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
from blacklist_manager import BlacklistManager

# Set Decimal precision to handle very small prices
getcontext().prec = 28



def setup_logging():
    """Setup logging configuration with rotation"""
    log_dir = "logs"
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = f"{log_dir}/algo_triggers_{timestamp}.log"
    
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
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    
    # Add handlers
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    
    return logger

logger = setup_logging()

class OKXAlgoTrigger:
    def __init__(self, order_size="100"):
        self.api_key = os.getenv('OKX_API_KEY')
        self.secret_key = os.getenv('OKX_SECRET_KEY')
        self.passphrase = os.getenv('OKX_PASSPHRASE')
        
        # Order size in USDT (for buy orders) or base currency (for sell orders)
        self.order_size = order_size
        
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
        self.market_api = self.okx_client.get_market_api()
        
        # Initialize Blacklist Manager
        self.blacklist_manager = BlacklistManager(logger)
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_crypto_data(self, inst_id):
        """Get crypto data in one API call: today's open price and 3-day price increase check"""
        try:
            # Get past 4 days of data (today + 3 days back) in one API call
            result = self.market_api.get_candlesticks(
                instId=inst_id,
                bar="1D",
                limit="4"  # Get 4 days of data
            )
            
            if result.get('code') == '0' and result.get('data'):
                data = result['data']
                if len(data) >= 4:
                    # Data is ordered from newest to oldest
                    # data[0] = today, data[1] = yesterday, data[2] = 2 days ago, data[3] = 3 days ago
                    today_open = Decimal(data[0][1])  # Today's open price
                    three_days_ago_open = Decimal(data[3][1])  # 3 days ago open price
                    
                    # Calculate percentage increase from 3 days ago to today
                    price_increase_pct = ((today_open - three_days_ago_open) / three_days_ago_open) * Decimal('100')
                    
                    logger.info(f"📈 {inst_id} | 3d ago: ${three_days_ago_open} | Today: ${today_open} | Change: {price_increase_pct:.2f}%")
                    
                    # Check if price increase is too high (>70%)
                    if price_increase_pct > Decimal('70'):
                        logger.warning(f"🚫 {inst_id} | SKIPPING - Rose {price_increase_pct:.2f}% in past 3 days (>70%)")
                        return None, False  # Return None for price, False for filter
                    else:
                        logger.info(f"✅ {inst_id} | OK - Only rose {price_increase_pct:.2f}% in past 3 days (<70%)")
                        return today_open, True  # Return today's price, True for filter
                else:
                    logger.warning(f"⚠️ {inst_id} | Insufficient historical data, allowing trigger creation")
                    # If we have at least today's data, use it
                    if data:
                        today_open = Decimal(data[0][1])
                        logger.info(f"📊 {inst_id}: ${today_open} (limited historical data)")
                        return today_open, True
                    return None, True  # Allow if we don't have enough data
            
            error_msg = result.get('msg', 'Unknown error')
            logger.warning(f"⚠️ Failed to get historical data for {inst_id}: {error_msg}, allowing trigger creation")
            return None, True  # Allow if API call fails
            
        except Exception as e:
            logger.warning(f"⚠️ Error getting data for {inst_id}: {e}, allowing trigger creation")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return None, True  # Allow if exception occurs
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def create_algo_trigger_order(self, inst_id, limit_coefficient, open_price):
        """Create single trigger order at target price"""
        try:
            # Calculate base trigger price using Decimal for precision
            if isinstance(open_price, str):
                open_price_decimal = Decimal(open_price)
            else:
                open_price_decimal = open_price
            
            trigger_price = open_price_decimal * Decimal(str(limit_coefficient)) / Decimal('100')
            
            # Calculate precision based on Decimal price value
            # For very small prices, use higher precision
            if trigger_price < Decimal('0.00001'):
                precision = 9  # Use 9 decimal places for PEPE, SHIB, etc.
            elif trigger_price < Decimal('0.01'):
                precision = 6  # Use 6 decimal places for small prices
            else:
                precision = 4  # Default precision for normal prices
            
            logger.debug(f"🔧 {inst_id} using precision: {precision}")
            
            # Round trigger price to appropriate precision
            from decimal import ROUND_HALF_UP
            precision_context = Decimal('0.' + '0' * (precision - 1) + '1') if precision > 0 else Decimal('1')
            trigger_price = trigger_price.quantize(precision_context, rounding=ROUND_HALF_UP)
            
            logger.info(f"🎯 {inst_id} | Trigger: ${trigger_price} | Limit: {limit_coefficient}%")
            
            # Calculate token quantity based on trigger price using Decimal
            usdt_amount = Decimal(self.order_size)
            token_quantity = usdt_amount / trigger_price
            
            # Format token quantity with appropriate precision
            if token_quantity < Decimal('0.0001'):
                adjusted_order_size = f"{token_quantity:.8f}"
            elif token_quantity < Decimal('0.01'):
                adjusted_order_size = f"{token_quantity:.6f}"
            else:
                adjusted_order_size = f"{token_quantity:.4f}"
            
            logger.info(f"📊 {inst_id} | Size: {adjusted_order_size} tokens")
            
            # Create single trigger order
            try:
                result = self.trade_api.place_algo_order(
                    instId=inst_id,
                    tdMode="cash",
                    side="buy",
                    ordType="trigger",
                    sz=adjusted_order_size,
                    triggerPx=str(trigger_price),      # Trigger price
                    orderPx=str(trigger_price)         # Execution price same as trigger price
                )
                
                if result.get('code') == '0':
                    order_id = result.get('data', [{}])[0].get('ordId', 'N/A')
                    logger.info(f"✅ {inst_id} trigger order created successfully - Order ID: {order_id}")
                    return True
                else:
                    error_msg = result.get('msg', 'Unknown error')
                    logger.error(f"❌ {inst_id} trigger order failed: {error_msg}")
                    return False
                    
            except Exception as e:
                logger.error(f"❌ {inst_id} trigger order exception: {e}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Error creating trigger order for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    def process_limits_from_database(self):
        """Process limits from database and create algo trigger orders"""
        try:
            # Load configuration from database
            from config_manager import ConfigManager
            config_manager = ConfigManager(logger)
            limits_data = config_manager.load_full_config()
            
            if not limits_data:
                logger.error("❌ No limits configuration found in database")
                return False
            
            crypto_configs = limits_data.get('crypto_configs', {})
            logger.info(f"📋 Found {len(crypto_configs)} crypto pairs in database")
            
            # Load blacklisted cryptocurrencies
            blacklisted_cryptos = self.blacklist_manager.get_blacklisted_cryptos()
            if blacklisted_cryptos:
                logger.info(f"🚫 Blacklisted cryptocurrencies: {sorted(blacklisted_cryptos)}")
            else:
                logger.info("✅ No blacklisted cryptocurrencies found")
            
            logger.info("=" * 60)
            
            success_count = 0
            total_count = len(crypto_configs)
            failed_pairs = []
            skipped_blacklist = 0
            
            for inst_id, config in crypto_configs.items():
                best_limit = config.get('best_limit')
                if best_limit is None:
                    logger.warning(f"⚠️  Skipping {inst_id}: no best_limit found")
                    continue
                
                # Extract base currency from inst_id (e.g., "BTC-USDT" -> "BTC")
                base_currency = inst_id.split('-')[0] if '-' in inst_id else inst_id
                
                # Check if cryptocurrency is blacklisted
                if base_currency in blacklisted_cryptos:
                    reason = self.blacklist_manager.get_blacklist_reason(base_currency)
                    logger.warning(f"🚫 Skipping {inst_id}: blacklisted ({reason})")
                    failed_pairs.append((inst_id, f"Blacklisted: {reason}"))
                    skipped_blacklist += 1
                    continue
                
                logger.info(f"\n🔄 Processing {inst_id}...")
                
                try:
                    # Get crypto data in one API call: price and 3-day increase check
                    open_price, price_check_passed = self.get_crypto_data(inst_id)
                    
                    if not price_check_passed:
                        logger.warning(f"⚠️  Skipping {inst_id}: rose >70% in past 3 days")
                        failed_pairs.append((inst_id, "Skipped due to high price increase (>70% in 3 days)"))
                        continue
                    
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
            
            if skipped_blacklist > 0:
                logger.info(f"🚫 Skipped due to blacklist: {skipped_blacklist}")
            
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
        logger.info("🚀 OKX Algo Trigger Order Creator (Using Database Configuration)")
        logger.info("=" * 60)
        
        # Use default order size or get from environment variable
        order_size = os.getenv('OKX_ORDER_SIZE', '100')
        logger.info(f"📊 Using order size: {order_size} USDT")
        logger.info("=" * 60)
        
        # Create OKX client and process limits from database
        okx_client = OKXAlgoTrigger(order_size=order_size)
        okx_client.process_limits_from_database()
        
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
