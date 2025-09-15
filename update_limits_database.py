#!/usr/bin/env python3
"""
Update Limits Database Script
Loads limits.json and updates the database configuration
"""

import json
import os
import sys
import logging
from datetime import datetime

# Load environment variables
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from lib.database import Database

def setup_logging():
    """Setup logging configuration"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(f'logs/update_limits_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log')
        ]
    )
    return logging.getLogger(__name__)

def main():
    """Main function to update limits database"""
    logger = setup_logging()
    
    try:
        logger.info("🚀 Starting limits database update")
        logger.info("=" * 60)
        
        # Check if limits.json exists
        if not os.path.exists('limits.json'):
            logger.error("❌ limits.json file not found")
            sys.exit(1)
        
        # Load limits.json
        logger.info("📋 Loading limits.json...")
        with open('limits.json', 'r', encoding='utf-8') as f:
            limits_data = json.load(f)
        
        logger.info(f"📊 Loaded configuration:")
        logger.info(f"   Strategy: {limits_data.get('strategy_name', 'N/A')}")
        logger.info(f"   Description: {limits_data.get('description', 'N/A')}")
        logger.info(f"   Crypto pairs: {len(limits_data.get('crypto_configs', {}))}")
        
        # Connect to database
        logger.info("🔗 Connecting to database...")
        db = Database()
        if not db.connect():
            logger.error("❌ Failed to connect to database")
            sys.exit(1)
        
        # Save configuration to database
        logger.info("💾 Saving configuration to database...")
        if db.save_limits_config(limits_data):
            logger.info("✅ Successfully updated limits database")
            
            # Show summary
            crypto_configs = limits_data.get('crypto_configs', {})
            logger.info(f"📊 Database updated with {len(crypto_configs)} crypto pairs")
            
            # Show first few pairs as example
            logger.info("📋 Sample crypto pairs:")
            for i, (inst_id, config) in enumerate(crypto_configs.items()):
                if i >= 5:  # Show only first 5
                    break
                logger.info(f"   {inst_id}: limit={config.get('best_limit')}, returns={config.get('max_returns')}")
            
            if len(crypto_configs) > 5:
                logger.info(f"   ... and {len(crypto_configs) - 5} more pairs")
                
        else:
            logger.error("❌ Failed to save configuration to database")
            sys.exit(1)
        
        # Disconnect from database
        db.disconnect()
        logger.info("✅ Database update completed successfully")
        
    except Exception as e:
        logger.error(f"❌ Error updating limits database: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()




