#!/usr/bin/env python3
"""
Simple script to get BTC open price for today using OKX API
"""

import os
import sys
import logging
from decimal import Decimal

# Load environment variables
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from okx_client import OKXClient

def setup_logging():
    """Setup basic logging"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    return logging.getLogger(__name__)

def get_btc_open_price():
    """Get BTC open price for today"""
    logger = setup_logging()
    
    try:
        # Initialize OKX client
        okx_client = OKXClient(logger)
        
        # Check if market API is available
        if not okx_client.is_market_available():
            logger.error("❌ OKX Market API not available")
            return None
        
        market_api = okx_client.get_market_api()
        
        # Get BTC-USDT candlestick data for today
        logger.info("🔍 Fetching BTC-USDT price data...")
        
        result = market_api.get_candlesticks(
            instId="BTC-USDT",
            bar="1D",
            limit="1"  # Get only today's data
        )
        
        if result.get('code') == '0' and result.get('data'):
            data = result['data']
            if data:
                # Data format: [timestamp, open, high, low, close, volume, ...]
                today_data = data[0]
                open_price = Decimal(today_data[1])  # Open price
                high_price = Decimal(today_data[2])  # High price
                low_price = Decimal(today_data[3])   # Low price
                close_price = Decimal(today_data[4]) # Close price
                volume = today_data[5]               # Volume
                
                # Convert timestamp to readable date
                timestamp = int(today_data[0]) / 1000
                from datetime import datetime
                date_str = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
                
                logger.info("=" * 60)
                logger.info(f"📊 BTC-USDT Price Data for {date_str}")
                logger.info("=" * 60)
                logger.info(f"💰 Open Price:  ${open_price}")
                logger.info(f"📈 High Price:  ${high_price}")
                logger.info(f"📉 Low Price:   ${low_price}")
                logger.info(f"📊 Close Price: ${close_price}")
                logger.info(f"📦 Volume:      {volume}")
                logger.info("=" * 60)
                
                return {
                    'open': float(open_price),
                    'high': float(high_price),
                    'low': float(low_price),
                    'close': float(close_price),
                    'volume': volume,
                    'date': date_str
                }
            else:
                logger.error("❌ No data returned from API")
                return None
        else:
            error_msg = result.get('msg', 'Unknown error')
            logger.error(f"❌ API error: {error_msg}")
            return None
            
    except Exception as e:
        logger.error(f"❌ Error getting BTC price: {e}")
        return None

def main():
    """Main function"""
    print("🚀 BTC Price Fetcher")
    print("=" * 40)
    
    price_data = get_btc_open_price()
    
    if price_data:
        print(f"\n✅ Successfully retrieved BTC price data!")
        print(f"📅 Date: {price_data['date']}")
        print(f"💰 Today's Open Price: ${price_data['open']}")
    else:
        print("\n❌ Failed to retrieve BTC price data")
        sys.exit(1)

if __name__ == "__main__":
    main()
