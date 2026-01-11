#!/usr/bin/env python3
"""
Update 7day Drop Database Script
Loads 7day_limit.json and updates the database configuration
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
    log_dir = "logs"
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(f'{log_dir}/update_7day_drop_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log')
        ]
    )

    return logging.getLogger(__name__)

def main():
    """Main function to update 7day drop database"""
    logger = setup_logging()
    
    try:
        logger.info("🚀 Starting 7day drop database update")
        logger.info("=" * 60)

        json_path = sys.argv[1] if len(sys.argv) > 1 else '7day_limit.json'
        
        # Check if 7day_limit.json exists
        if not os.path.exists(json_path):
            logger.error(f"❌ 7day_limit.json file not found: {json_path}")
            sys.exit(1)
        
        # Load 7day_limit.json
        logger.info(f"📋 Loading 7day_limit.json: {json_path}")
        with open(json_path, 'r', encoding='utf-8') as f:
            config_data = json.load(f)
        
        logger.info(f"📊 Loaded configuration:")
        logger.info(f"   Strategy: {config_data.get('strategy_name', 'N/A')}")
        logger.info(f"   Description: {config_data.get('description', 'N/A')}")
        logger.info(f"   Strategy Type: {config_data.get('strategy_type', 'N/A')}")
        logger.info(f"   Crypto pairs: {len(config_data.get('crypto_configs', {}))}")
        
        # Connect to database
        logger.info("🔗 Connecting to database...")
        db = Database()
        if not db.connect():
            logger.error("❌ Failed to connect to database")
            sys.exit(1)
        
        # Save configuration to database
        logger.info("💾 Saving configuration to database...")
        if db.save_7day_drop_config(config_data):
            logger.info("✅ Configuration saved successfully")
        else:
            logger.error("❌ Failed to save configuration")
            sys.exit(1)
        
        # Verify by loading back
        logger.info("🔍 Verifying saved configuration...")
        loaded_config = db.load_7day_drop_config()
        if loaded_config:
            logger.info(f"✅ Verified: {len(loaded_config.get('crypto_configs', {}))} crypto pairs loaded")
        else:
            logger.warning("⚠️  Could not verify saved configuration")
        
        db.disconnect()
        logger.info("✅ Script completed successfully")
        
    except json.JSONDecodeError as e:
        logger.error(f"❌ Invalid JSON file: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"❌ Error: {e}")
        logger.exception(e)
        sys.exit(1)

if __name__ == "__main__":
    main()
