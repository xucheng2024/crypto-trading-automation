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
from decimal import Decimal, getcontext, ROUND_HALF_UP
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
from lib.database import Database

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
        
        # Data cache to avoid redundant API calls
        # Key: inst_id, Value: {'candlestick_data': [...], 'current_price': Decimal, 'max_high': Decimal}
        self.data_cache = {}
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_crypto_data(self, inst_id):
        """Get crypto data: today's open price and yesterday's volatility check"""
        try:
            # Check cache first (if 7day data was already fetched)
            if inst_id in self.data_cache and 'candlestick_data' in self.data_cache[inst_id]:
                cached_data = self.data_cache[inst_id]['candlestick_data']
                if len(cached_data) >= 2:
                    logger.debug(f"📦 {inst_id} | Using cached candlestick data")
                    data = cached_data
                else:
                    data = None
            else:
                data = None
            
            # If no cache, fetch 2 days of data
            if data is None:
                result = self.market_api.get_candlesticks(
                    instId=inst_id,
                    bar="1D",
                    limit="2"  # Get 2 days of data (today and yesterday)
                )
                
                if result.get('code') == '0' and result.get('data'):
                    data = result['data']
                else:
                    error_msg = result.get('msg', 'Unknown error')
                    logger.warning(f"⚠️ Failed to get historical data for {inst_id}: {error_msg}, allowing trigger creation")
                    return None, True  # Allow if API call fails
            
            if data and len(data) >= 2:
                # Data is ordered from newest to oldest
                # data[0] = today, data[1] = yesterday
                today_open = Decimal(data[0][1])  # Today's open price
                
                # Yesterday's data: [timestamp, open, high, low, close, volume, ...]
                yesterday_open = Decimal(data[1][1])   # Yesterday's open
                yesterday_high = Decimal(data[1][2])   # Yesterday's high
                yesterday_low = Decimal(data[1][3])    # Yesterday's low
                yesterday_close = Decimal(data[1][4])  # Yesterday's close
                
                # Calculate volatility metrics
                # Rule 1: (high-low)/open > 0.25 (amplitude > 25%)
                amplitude_ratio = (yesterday_high - yesterday_low) / yesterday_open
                
                # Rule 2: abs(close/open-1) > 0.12 (price change > 12%)
                price_change_ratio = abs(yesterday_close / yesterday_open - Decimal('1'))
                
                logger.info(f"📈 {inst_id} | Yesterday: O=${yesterday_open} H=${yesterday_high} L=${yesterday_low} C=${yesterday_close}")
                logger.info(f"   Amplitude: {(amplitude_ratio * 100):.2f}% | Price Change: {(price_change_ratio * 100):.2f}%")
                
                # Check skip conditions
                if amplitude_ratio > Decimal('0.25'):
                    logger.warning(f"🚫 {inst_id} | SKIPPING - Yesterday amplitude {(amplitude_ratio * 100):.2f}% > 25%")
                    return None, False  # Skip: too volatile
                
                if price_change_ratio > Decimal('0.12'):
                    logger.warning(f"🚫 {inst_id} | SKIPPING - Yesterday price change {(price_change_ratio * 100):.2f}% > 12%")
                    return None, False  # Skip: too volatile
                
                logger.info(f"✅ {inst_id} | OK - Yesterday volatility within limits")
                return today_open, True  # Return today's price, True for filter
            else:
                logger.warning(f"⚠️ {inst_id} | Insufficient historical data, allowing trigger creation")
                # If we have at least today's data, use it
                if data and len(data) > 0:
                    today_open = Decimal(data[0][1])
                    logger.info(f"📊 {inst_id}: ${today_open} (limited historical data)")
                    return today_open, True
                return None, True  # Allow if we don't have enough data
            
        except Exception as e:
            logger.warning(f"⚠️ Error getting data for {inst_id}: {e}, allowing trigger creation")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return None, True  # Allow if exception occurs
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_7day_data(self, inst_id):
        """Get past 7 days of data (including today) and calculate max high, and get current price"""
        try:
            # Check cache first
            if inst_id in self.data_cache:
                cached = self.data_cache[inst_id]
                if 'max_high' in cached and 'current_price' in cached:
                    logger.debug(f"📦 {inst_id} | Using cached 7day data")
                    return cached['max_high'], cached['current_price']
            
            # Get past 7 days of data (including today)
            result = self.market_api.get_candlesticks(
                instId=inst_id,
                bar="1D",
                limit="7"  # Get 7 days of data (including today)
            )
            
            if result.get('code') == '0' and result.get('data'):
                data = result['data']
                if len(data) < 7:
                    logger.warning(f"⚠️ {inst_id} | Insufficient 7-day data: {len(data)} days")
                    return None, None
                
                # Data is ordered from newest to oldest
                # data[0] = today, data[1] = yesterday, ... data[6] = 7 days ago
                
                # Find max high in past 7 days (including today)
                max_high = Decimal(data[0][2])  # Start with today's high
                for i in range(1, 7):
                    day_high = Decimal(data[i][2])
                    if day_high > max_high:
                        max_high = day_high
                
                # Get current price using ticker API
                ticker_result = self.market_api.get_ticker(instId=inst_id)
                if ticker_result.get('code') == '0' and ticker_result.get('data'):
                    ticker_data = ticker_result['data']
                    if ticker_data and len(ticker_data) > 0:
                        current_price = Decimal(ticker_data[0].get('last', '0'))  # Current last traded price
                        if current_price > 0:
                            logger.info(f"📊 {inst_id} | 7-day max high: ${max_high} | Current price: ${current_price}")
                            
                            # Cache the data for potential reuse
                            self.data_cache[inst_id] = {
                                'candlestick_data': data,
                                'current_price': current_price,
                                'max_high': max_high
                            }
                            
                            return max_high, current_price
                        else:
                            logger.warning(f"⚠️ {inst_id} | Invalid current price from ticker")
                    else:
                        logger.warning(f"⚠️ {inst_id} | No ticker data returned")
                else:
                    ticker_error = ticker_result.get('msg', 'Unknown error')
                    logger.warning(f"⚠️ {inst_id} | Failed to get ticker: {ticker_error}")
                
                return None, None
            
            error_msg = result.get('msg', 'Unknown error')
            logger.warning(f"⚠️ Failed to get 7-day data for {inst_id}: {error_msg}")
            return None, None
            
        except Exception as e:
            logger.warning(f"⚠️ Error getting 7-day data for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return None, None
    
    def _calculate_precision(self, price):
        """Calculate precision based on price value"""
        if price < Decimal('0.00001'):
            return 9  # Use 9 decimal places for PEPE, SHIB, etc.
        elif price < Decimal('0.01'):
            return 6  # Use 6 decimal places for small prices
        else:
            return 4  # Default precision for normal prices
    
    def _format_quantity(self, quantity):
        """Format token quantity with appropriate precision"""
        if quantity < Decimal('0.0001'):
            return f"{quantity:.8f}"
        elif quantity < Decimal('0.01'):
            return f"{quantity:.6f}"
        else:
            return f"{quantity:.4f}"
    
    def _round_price(self, price, precision):
        """Round price to appropriate precision"""
        precision_context = Decimal('0.' + '0' * (precision - 1) + '1') if precision > 0 else Decimal('1')
        return price.quantize(precision_context, rounding=ROUND_HALF_UP)
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def _create_trigger_order_internal(self, inst_id, trigger_price, strategy_name=""):
        """Internal method to create trigger order (common logic)"""
        try:
            # Convert trigger_price to Decimal
            if isinstance(trigger_price, str):
                trigger_price_decimal = Decimal(trigger_price)
            else:
                trigger_price_decimal = Decimal(str(trigger_price))
            
            # Calculate precision and round price
            precision = self._calculate_precision(trigger_price_decimal)
            trigger_price_decimal = self._round_price(trigger_price_decimal, precision)
            
            strategy_prefix = f"{strategy_name} " if strategy_name else ""
            logger.info(f"🎯 {inst_id} | {strategy_prefix}Trigger: ${trigger_price_decimal}")
            
            # Calculate token quantity based on trigger price
            usdt_amount = Decimal(self.order_size)
            token_quantity = usdt_amount / trigger_price_decimal
            
            # Format token quantity
            adjusted_order_size = self._format_quantity(token_quantity)
            logger.info(f"📊 {inst_id} | Size: {adjusted_order_size} tokens")
            
            # Create trigger order
            result = self.trade_api.place_algo_order(
                instId=inst_id,
                tdMode="cash",
                side="buy",
                ordType="trigger",
                sz=adjusted_order_size,
                triggerPx=str(trigger_price_decimal),
                orderPx=str(trigger_price_decimal)
            )
            
            if result.get('code') == '0':
                order_id = result.get('data', [{}])[0].get('ordId', 'N/A')
                logger.info(f"✅ {inst_id} {strategy_prefix}trigger order created successfully - Order ID: {order_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ {inst_id} {strategy_prefix}trigger order failed: {error_msg}")
                return False
                
        except Exception as e:
            strategy_prefix = f"{strategy_name} " if strategy_name else ""
            logger.error(f"❌ {inst_id} {strategy_prefix}trigger order exception: {e}")
            raise  # Re-raise for retry mechanism
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def create_algo_trigger_order(self, inst_id, limit_coefficient, open_price):
        """Create single trigger order at target price"""
        try:
            # Calculate trigger price: open_price * limit_coefficient / 100
            if isinstance(open_price, str):
                open_price_decimal = Decimal(open_price)
            else:
                open_price_decimal = open_price
            
            trigger_price = open_price_decimal * Decimal(str(limit_coefficient)) / Decimal('100')
            
            logger.info(f"📊 {inst_id} | Open: ${open_price_decimal} | Limit: {limit_coefficient}%")
            
            # Use common method to create order
            return self._create_trigger_order_internal(inst_id, trigger_price, "")
                
        except Exception as e:
            logger.error(f"❌ Error creating trigger order for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            raise  # Re-raise for retry mechanism
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def create_7day_drop_trigger_order(self, inst_id, trigger_price):
        """Create single trigger order at target price (for 7day drop strategy)"""
        try:
            # Use common method to create order
            return self._create_trigger_order_internal(inst_id, trigger_price, "7day Drop")
                
        except Exception as e:
            logger.error(f"❌ Error creating 7day drop trigger order for {inst_id}: {e}")
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
                    # Get crypto data: price and yesterday volatility check
                    open_price, price_check_passed = self.get_crypto_data(inst_id)
                    
                    if not price_check_passed:
                        logger.warning(f"⚠️  Skipping {inst_id}: yesterday volatility too high")
                        failed_pairs.append((inst_id, "Skipped due to high yesterday volatility"))
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
            
        except Exception as e:
            logger.error(f"❌ Error processing limits from database: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
    
    def process_7day_drop_from_database(self):
        """Process 7day drop strategy from database and create algo trigger orders"""
        try:
            # Load 7day drop configuration from database
            db = Database()
            if not db.connect():
                logger.error("❌ Failed to connect to database")
                return False
            
            config_data = db.load_7day_drop_config()
            db.disconnect()
            
            if not config_data:
                logger.error("❌ No 7day drop configuration found in database")
                return False
            
            crypto_configs = config_data.get('crypto_configs', {})
            logger.info(f"📋 Found {len(crypto_configs)} crypto pairs in 7day drop configuration")
            
            # Load blacklisted cryptocurrencies
            blacklisted_cryptos = self.blacklist_manager.get_blacklisted_cryptos()
            if blacklisted_cryptos:
                logger.info(f"🚫 Blacklisted cryptocurrencies: {sorted(blacklisted_cryptos)}")
            else:
                logger.info("✅ No blacklisted cryptocurrencies found")
            
            logger.info("=" * 60)
            logger.info("📊 Processing 7day Drop Strategy")
            logger.info("=" * 60)
            
            success_count = 0
            total_count = len(crypto_configs)
            failed_pairs = []
            skipped_blacklist = 0
            skipped_conditions = 0
            
            for inst_id, config in crypto_configs.items():
                drop_ratio = config.get('drop_ratio')
                
                if drop_ratio is None:
                    logger.warning(f"⚠️  Skipping {inst_id}: no drop_ratio found")
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
                    # Get 7-day data: max high and current price
                    max_high, current_price = self.get_7day_data(inst_id)
                    
                    if max_high is None or current_price is None:
                        logger.warning(f"⚠️  Skipping {inst_id}: could not get 7-day data or current price")
                        failed_pairs.append((inst_id, "Failed to get 7-day data or current price"))
                        continue
                    
                    # Calculate buy price: max_high × (1 - drop_ratio)
                    drop_ratio_decimal = Decimal(str(drop_ratio))
                    buy_price = max_high * (Decimal('1') - drop_ratio_decimal)
                    
                    logger.info(f"📊 {inst_id} | Max high: ${max_high} | Drop ratio: {drop_ratio} | Buy price: ${buy_price} | Current price: ${current_price}")
                    
                    # Check condition: current price <= buy price
                    if current_price > buy_price:
                        logger.info(f"⏭️  {inst_id} | Skipping: Current price (${current_price}) > Buy price (${buy_price})")
                        skipped_conditions += 1
                        continue
                    
                    # Create buy trigger order at buy_price
                    if self.create_7day_drop_trigger_order(inst_id, buy_price):
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
            logger.info(f"📊 7day Drop Summary: {success_count}/{total_count} orders created successfully")
            
            if skipped_blacklist > 0:
                logger.info(f"🚫 Skipped due to blacklist: {skipped_blacklist}")
            
            if skipped_conditions > 0:
                logger.info(f"⏭️  Skipped due to conditions: {skipped_conditions}")
            
            if failed_pairs:
                logger.warning(f"⚠️  Failed pairs: {len(failed_pairs)}")
                for pair, reason in failed_pairs:
                    logger.warning(f"   {pair}: {reason}")
            
        except Exception as e:
            logger.error(f"❌ Error processing 7day drop strategy: {e}")
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
        
        # Process 7day drop strategy first (cache 7day data)
        okx_client.process_7day_drop_from_database()
        
        # Process regular limits strategy (can use cached 7day data if available)
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
