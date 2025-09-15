#!/usr/bin/env python3
"""
检查OKX API返回的时间戳和时区信息
"""

import os
import sys
import logging
from decimal import Decimal
from datetime import datetime, timezone, timedelta

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

def check_btc_timezone():
    """检查BTC价格数据的时间戳和时区"""
    logger = setup_logging()
    
    try:
        # Initialize OKX client
        logger.info("🔧 初始化OKX客户端...")
        okx_client = OKXClient(logger)
        
        if not okx_client.is_market_available():
            logger.error("❌ OKX Market API not available")
            return None
        
        logger.info("✅ OKX Market API 可用")
        market_api = okx_client.get_market_api()
        
        # 获取最近几天的数据来对比
        logger.info("🔍 获取BTC-USDT最近3天的K线数据...")
        
        result = market_api.get_candlesticks(
            instId="BTC-USDT",
            bar="1D",
            limit="3"  # 获取最近3天
        )
        
        if result.get('code') == '0' and result.get('data'):
            data = result['data']
            logger.info("=" * 80)
            logger.info("📊 BTC-USDT 时间戳分析")
            logger.info("=" * 80)
            
            for i, day_data in enumerate(data):
                timestamp_ms = int(day_data[0])  # 毫秒时间戳
                timestamp_s = timestamp_ms / 1000  # 秒时间戳
                
                # 转换为不同时区的时间
                utc_time = datetime.fromtimestamp(timestamp_s, tz=timezone.utc)
                singapore_time = utc_time + timedelta(hours=8)  # UTC+8
                local_time = datetime.fromtimestamp(timestamp_s)
                
                open_price = Decimal(day_data[1])
                high_price = Decimal(day_data[2])
                low_price = Decimal(day_data[3])
                close_price = Decimal(day_data[4])
                
                logger.info(f"\n📅 第{i+1}天数据:")
                logger.info(f"   原始时间戳: {timestamp_ms} (毫秒)")
                logger.info(f"   UTC时间:    {utc_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
                logger.info(f"   新加坡时间:  {singapore_time.strftime('%Y-%m-%d %H:%M:%S')} (UTC+8)")
                logger.info(f"   本地时间:    {local_time.strftime('%Y-%m-%d %H:%M:%S')}")
                logger.info(f"   开盘价:      ${open_price}")
                logger.info(f"   最高价:      ${high_price}")
                logger.info(f"   最低价:      ${low_price}")
                logger.info(f"   收盘价:      ${close_price}")
            
            logger.info("=" * 80)
            
            # 检查当前时间
            now_utc = datetime.now(timezone.utc)
            now_singapore = now_utc + timedelta(hours=8)
            now_local = datetime.now()
            
            logger.info("🕐 当前时间对比:")
            logger.info(f"   UTC时间:     {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            logger.info(f"   新加坡时间:   {now_singapore.strftime('%Y-%m-%d %H:%M:%S')} (UTC+8)")
            logger.info(f"   本地时间:     {now_local.strftime('%Y-%m-%d %H:%M:%S')}")
            
            # 分析OKX的交易日定义
            latest_data = data[0]  # 最新的数据
            latest_timestamp = int(latest_data[0]) / 1000
            latest_utc = datetime.fromtimestamp(latest_timestamp, tz=timezone.utc)
            latest_singapore = latest_utc + timedelta(hours=8)
            
            logger.info("\n🔍 OKX交易日分析:")
            logger.info(f"   最新K线UTC时间:   {latest_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            logger.info(f"   最新K线新加坡时间: {latest_singapore.strftime('%Y-%m-%d %H:%M:%S')} (UTC+8)")
            
            # 检查是否是新加坡时间的0点
            if latest_singapore.hour == 0 and latest_singapore.minute == 0:
                logger.info("✅ 确认: OKX的日K线确实使用新加坡时间(UTC+8)的0点作为交易日开始")
            else:
                logger.info("❓ OKX的日K线时间不是新加坡时间0点")
            
            return data
            
        else:
            error_msg = result.get('msg', 'Unknown error')
            logger.error(f"❌ API错误: {error_msg}")
            return None
            
    except Exception as e:
        logger.error(f"❌ 获取BTC价格数据时出错: {e}")
        return None

def main():
    """Main function"""
    print("🕐 OKX时间戳和时区分析")
    print("=" * 50)
    
    check_btc_timezone()

if __name__ == "__main__":
    main()
