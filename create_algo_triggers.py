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
from decimal import Decimal, getcontext, ROUND_HALF_UP, ROUND_DOWN
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
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
        
        # Data cache to avoid redundant API calls
        # Key: inst_id, Value: {'candlestick_data': [...], 'current_price': Decimal, 'max_high': Decimal}
        self.data_cache = {}
        # Instrument metadata cache to enforce exchange precision rules
        self.instrument_rules_cache = {}
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_crypto_data(self, inst_id):
        """Get crypto data: today's open price and yesterday's volatility check"""
        try:
            # Check cache first (if candlestick data was already fetched)
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
                    logger.warning(f"⚠️ Failed to get historical data for {inst_id}: {error_msg}")
                    return None, True  # Continue process; pair may still be skipped later due to missing open price
            
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
                logger.warning(f"⚠️ {inst_id} | Insufficient historical data")
                # If we have at least today's data, use it
                if data and len(data) > 0:
                    today_open = Decimal(data[0][1])
                    logger.info(f"📊 {inst_id}: ${today_open} (limited historical data)")
                    return today_open, True
                return None, True  # Continue process; pair may still be skipped later due to missing open price
            
        except Exception as e:
            logger.warning(f"⚠️ Error getting data for {inst_id}: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return None, True  # Continue process; pair may still be skipped later due to missing open price
    
    def get_current_price(self, inst_id):
        """Get current price from ticker API"""
        try:
            ticker_result = self.market_api.get_ticker(instId=inst_id)
            if ticker_result.get('code') == '0' and ticker_result.get('data'):
                ticker_data = ticker_result['data']
                if ticker_data and len(ticker_data) > 0:
                    price = Decimal(ticker_data[0].get('last', '0'))
                    return price if price > 0 else None
            return None
        except Exception as e:
            logger.warning(f"⚠️ Error getting current price for {inst_id}: {e}")
            return None
    
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

    def _to_plain_decimal_str(self, value: Decimal) -> str:
        """Convert Decimal to plain string without scientific notation."""
        result = format(value, 'f')
        if '.' in result:
            result = result.rstrip('0').rstrip('.')
        return result or '0'

    def _round_to_step(self, value: Decimal, step: Decimal, rounding_mode=ROUND_HALF_UP):
        """Round value to exchange step size."""
        if step is None or step <= 0:
            return value
        units = (value / step).to_integral_value(rounding=rounding_mode)
        return units * step

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=10),
        retry=retry_if_exception_type((Exception,))
    )
    def get_instrument_rules(self, inst_id):
        """Get and cache instrument precision rules from OKX."""
        try:
            if inst_id in self.instrument_rules_cache:
                return self.instrument_rules_cache[inst_id]

            # Use PublicAPI (has get_instruments); MarketAPI does not
            api = self.okx_client.get_public_api() or self.market_api
            if not api or not hasattr(api, 'get_instruments'):
                logger.warning("⚠️ No API with get_instruments, fallback to local precision rules")
                self.instrument_rules_cache[inst_id] = None
                return None

            result = api.get_instruments(instType="SPOT", instId=inst_id)
            if result.get('code') != '0' or not result.get('data'):
                logger.warning(f"⚠️ {inst_id} | Failed to load instrument rules, using fallback precision")
                self.instrument_rules_cache[inst_id] = None
                return None

            item = result['data'][0]
            tick_sz = Decimal(item.get('tickSz', '0'))
            lot_sz = Decimal(item.get('lotSz', '0'))
            min_sz = Decimal(item.get('minSz', '0'))
            if tick_sz <= 0 or lot_sz <= 0:
                logger.warning(f"⚠️ {inst_id} | Invalid tick/lot size from exchange, using fallback precision")
                self.instrument_rules_cache[inst_id] = None
                return None

            rules = {
                'tick_sz': tick_sz,
                'lot_sz': lot_sz,
                'min_sz': min_sz if min_sz > 0 else lot_sz
            }
            self.instrument_rules_cache[inst_id] = rules
            return rules
        except Exception as e:
            logger.warning(f"⚠️ {inst_id} | Failed to load/parse instrument rules ({e}), using fallback precision")
            self.instrument_rules_cache[inst_id] = None
            return None

    def _normalize_order_params(self, inst_id, target_price: Decimal, token_quantity: Decimal, strategy_prefix=""):
        """Normalize price/size to exchange precision rules."""
        rules = self.get_instrument_rules(inst_id)
        if rules:
            adjusted_price = self._round_to_step(target_price, rules['tick_sz'], ROUND_HALF_UP)
            adjusted_size = self._round_to_step(token_quantity, rules['lot_sz'], ROUND_DOWN)
            if adjusted_price <= 0:
                return None, None, f"{strategy_prefix}invalid adjusted price after tick rounding"
            if adjusted_size < rules['min_sz']:
                return None, None, (
                    f"{strategy_prefix}size too small after lot rounding: "
                    f"{adjusted_size} < minSz {rules['min_sz']}"
                )
            return adjusted_price, adjusted_size, None

        # Fallback precision path if exchange metadata is unavailable
        precision = self._calculate_precision(target_price)
        adjusted_price = self._round_price(target_price, precision)
        adjusted_size = Decimal(self._format_quantity(token_quantity))
        if adjusted_price <= 0 or adjusted_size <= 0:
            return None, None, f"{strategy_prefix}invalid price/size after fallback rounding"
        return adjusted_price, adjusted_size, None
    
    @retry(
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=1, min=6, max=30),
        retry=retry_if_exception_type((Exception,))
    )
    def _place_limit_buy_order(self, inst_id, buy_price, strategy_name=""):
        """Place limit buy order directly (no trigger). Used when current price already below buy_price.
        Limit typically fills since price is below target; if not, cancel_pending_limits will cancel it."""
        try:
            strategy_prefix = f"{strategy_name} " if strategy_name else ""
            if not self.trade_api:
                logger.error(f"❌ {inst_id} {strategy_prefix}Trade API unavailable")
                return False

            if isinstance(buy_price, str):
                buy_price_decimal = Decimal(buy_price)
            else:
                buy_price_decimal = Decimal(str(buy_price))

            if buy_price_decimal <= 0:
                logger.error(f"❌ {inst_id} {strategy_prefix}invalid buy price: {buy_price_decimal}")
                return False

            usdt_amount = Decimal(self.order_size)
            if usdt_amount <= 0:
                logger.error(f"❌ {inst_id} {strategy_prefix}invalid order size: {self.order_size}")
                return False

            token_quantity = usdt_amount / buy_price_decimal
            adjusted_price, adjusted_size, normalize_error = self._normalize_order_params(
                inst_id, buy_price_decimal, token_quantity, strategy_prefix
            )
            if normalize_error:
                logger.warning(f"⚠️ {inst_id} | {normalize_error}, skip placing order")
                return False

            adjusted_price_str = self._to_plain_decimal_str(adjusted_price)
            adjusted_size_str = self._to_plain_decimal_str(adjusted_size)

            logger.info(f"💰 {inst_id} | {strategy_prefix}Limit buy at ${adjusted_price_str} (price already below target, no trigger)")
            time.sleep(2.0)
            result = self.trade_api.place_order(
                instId=inst_id,
                tdMode="cash",
                side="buy",
                ordType="limit",
                px=adjusted_price_str,
                sz=adjusted_size_str,
                tgtCcy="base_ccy"
            )
            
            if result.get('code') == '0':
                order_id = result.get('data', [{}])[0].get('ordId', 'N/A')
                logger.info(f"✅ {inst_id} {strategy_prefix}limit buy order placed - Order ID: {order_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                logger.error(f"❌ {inst_id} {strategy_prefix}limit buy failed: {error_msg}")
                return False
        except Exception as e:
            strategy_prefix = f"{strategy_name} " if strategy_name else ""
            logger.error(f"❌ {inst_id} {strategy_prefix}limit buy exception: {e}")
            raise
    
    @retry(
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=1, min=6, max=30),
        retry=retry_if_exception_type((Exception,))
    )
    def _create_trigger_order_internal(self, inst_id, trigger_price, strategy_name=""):
        """Internal method to create trigger order (common logic)"""
        try:
            strategy_prefix = f"{strategy_name} " if strategy_name else ""
            if not self.trade_api:
                logger.error(f"❌ {inst_id} {strategy_prefix}Trade API unavailable")
                return False

            # Convert trigger_price to Decimal
            if isinstance(trigger_price, str):
                trigger_price_decimal = Decimal(trigger_price)
            else:
                trigger_price_decimal = Decimal(str(trigger_price))

            if trigger_price_decimal <= 0:
                logger.error(f"❌ {inst_id} {strategy_prefix}invalid trigger price: {trigger_price_decimal}")
                return False
            
            # Calculate token quantity based on trigger price
            usdt_amount = Decimal(self.order_size)
            if usdt_amount <= 0:
                logger.error(f"❌ {inst_id} {strategy_prefix}invalid order size: {self.order_size}")
                return False

            token_quantity = usdt_amount / trigger_price_decimal
            adjusted_price, adjusted_size, normalize_error = self._normalize_order_params(
                inst_id, trigger_price_decimal, token_quantity, strategy_prefix
            )
            if normalize_error:
                logger.warning(f"⚠️ {inst_id} | {normalize_error}, skip placing trigger")
                return False

            adjusted_price_str = self._to_plain_decimal_str(adjusted_price)
            adjusted_size_str = self._to_plain_decimal_str(adjusted_size)

            logger.info(f"🎯 {inst_id} | {strategy_prefix}Trigger: ${adjusted_price_str}")
            logger.info(f"📊 {inst_id} | Size: {adjusted_size_str} tokens")
            
            # Small delay to avoid connection overload / "Server disconnected"
            time.sleep(2.0)
            # Create trigger order
            result = self.trade_api.place_algo_order(
                instId=inst_id,
                tdMode="cash",
                side="buy",
                ordType="trigger",
                sz=adjusted_size_str,
                triggerPx=adjusted_price_str,
                orderPx=adjusted_price_str
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
    
    def _process_single_limit_pair(self, inst_id, config, blacklisted_cryptos):
        """Process a single crypto pair for limits strategy (for parallel processing)"""
        best_limit = config.get('best_limit')
        
        if best_limit is None:
            return (inst_id, "no best_limit found", False)
        
        # Extract base currency from inst_id (e.g., "BTC-USDT" -> "BTC")
        base_currency = inst_id.split('-')[0] if '-' in inst_id else inst_id
        
        # Check if cryptocurrency is blacklisted
        if base_currency in blacklisted_cryptos:
            reason = self.blacklist_manager.get_blacklist_reason(base_currency)
            return (inst_id, f"Blacklisted: {reason}", False)
        
        logger.info(f"\n🔄 Processing {inst_id}...")
        
        try:
            # Get crypto data: price and yesterday volatility check
            open_price, price_check_passed = self.get_crypto_data(inst_id)
            
            if not price_check_passed:
                logger.warning(f"⚠️  Skipping {inst_id}: yesterday volatility too high")
                return (inst_id, "Skipped due to high yesterday volatility", False)
            
            if open_price is None:
                logger.warning(f"⚠️  Skipping {inst_id}: could not get open price")
                return (inst_id, "Failed to get open price", False)
            
            # Calculate trigger price: open_price × best_limit / 100
            trigger_price = open_price * Decimal(str(best_limit)) / Decimal('100')
            
            # If current price already below trigger_price, place limit buy directly (no trigger)
            current_price = self.get_current_price(inst_id)
            if current_price is not None and current_price < trigger_price:
                logger.info(f"📊 {inst_id} | Current price ${current_price} < trigger ${trigger_price}, placing limit buy directly (no trigger)")
                if self._place_limit_buy_order(inst_id, trigger_price, ""):
                    return (inst_id, None, True)
                else:
                    return (inst_id, "Failed to place limit order", False)
            
            logger.info(f"📊 {inst_id} | Open: ${open_price} | Limit: {best_limit}% | Trigger: ${trigger_price}")
            
            if self._create_trigger_order_internal(inst_id, trigger_price, ""):
                return (inst_id, None, True)
            else:
                return (inst_id, "Failed to create order", False)
            
        except Exception as e:
            logger.error(f"❌ Error processing {inst_id}: {e}")
            return (inst_id, str(e), False)

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
            logger.info("🚀 Processing with sequential execution (avoids Server disconnected)")
            logger.info("=" * 60)
            
            success_count = 0
            total_count = len(crypto_configs)
            failed_pairs = []
            skipped_blacklist = 0
            
            # Sequential (max_workers=1) to avoid connection overload / "Server disconnected"
            with ThreadPoolExecutor(max_workers=1) as executor:
                # Submit all tasks
                future_to_pair = {
                    executor.submit(self._process_single_limit_pair, inst_id, config, blacklisted_cryptos): inst_id
                    for inst_id, config in crypto_configs.items()
                }
                
                # Collect results as they complete
                for future in as_completed(future_to_pair):
                    inst_id = future_to_pair[future]
                    try:
                        result_inst_id, reason, success = future.result()
                        if success:
                            success_count += 1
                        else:
                            if reason and "Blacklisted" in reason:
                                skipped_blacklist += 1
                            else:
                                failed_pairs.append((result_inst_id, reason))
                    except Exception as e:
                        logger.error(f"❌ Exception processing {inst_id}: {e}")
                        failed_pairs.append((inst_id, str(e)))
            
            logger.info("\n" + "=" * 60)
            logger.info(f"📊 Summary: {success_count}/{total_count} orders created successfully")
            
            if skipped_blacklist > 0:
                logger.info(f"🚫 Skipped due to blacklist: {skipped_blacklist}")
            
            if failed_pairs:
                logger.warning(f"⚠️  Failed pairs: {len(failed_pairs)}")
                for pair, reason in failed_pairs:
                    logger.warning(f"   {pair}: {reason}")

            return len(failed_pairs) == 0
        except Exception as e:
            logger.error(f"❌ Error processing limits from database: {e}")
            logger.debug(f"Traceback: {traceback.format_exc()}")
            return False

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
        
        limits_success = okx_client.process_limits_from_database()

        if not limits_success:
            logger.error("❌ Script completed with failures")
            sys.exit(1)
        
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
