#!/usr/bin/env python3
"""
Configuration Management Module
Responsible for loading, cleaning, and backing up limits configuration from database
"""

import json
import shutil
import logging
from datetime import datetime
from typing import Set, Dict, Any, Optional


class ConfigManager:
    """Configuration Database Manager"""
    
    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger or logging.getLogger(__name__)
        self.db = None
        self._connect_to_database()
    
    def _connect_to_database(self):
        """Connect to database"""
        try:
            from lib.database import Database
            self.db = Database()
            if not self.db.connect():
                self.logger.error("❌ Failed to connect to database")
                self.db = None
        except Exception as e:
            self.logger.error(f"❌ Database connection error: {e}")
            self.db = None
    
    def load_configured_cryptos(self) -> Set[str]:
        """Load configured cryptocurrency list from database"""
        try:
            if not self.db:
                self.logger.warning("⚠️ Database not available, will monitor all delist announcements")
                return set()
            
            # Get configured crypto pairs from database
            crypto_pairs = self.db.get_configured_cryptos()
            
            # Extract base currency symbols (remove -USDT suffix)
            base_cryptos = set()
            for pair in crypto_pairs:
                if '-USDT' in pair:
                    base_crypto = pair.replace('-USDT', '')
                    base_cryptos.add(base_crypto)
            
            self.logger.info(f"📋 Loaded {len(base_cryptos)} configured cryptocurrencies from database: {sorted(base_cryptos)}")
            return base_cryptos
            
        except Exception as e:
            self.logger.error(f"❌ Failed to load configured cryptos from database: {e}")
            return set()
    
    def backup_config(self) -> str:
        """Backup configuration from database to JSON file, return backup filename"""
        backup_filename = f"limits_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        try:
            if not self.db:
                self.logger.error("❌ Database not available for backup")
                return ""
            
            # Load configuration from database
            config_data = self.db.load_limits_config()
            if not config_data:
                self.logger.error("❌ No configuration found in database")
                return ""
            
            # Create backups directory if it doesn't exist
            os.makedirs('backups', exist_ok=True)
            
            # Save to backup file
            backup_path = f"backups/{backup_filename}"
            with open(backup_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            
            self.logger.info(f"📦 Configuration backed up to: {backup_path}")
            return backup_filename
        except Exception as e:
            self.logger.error(f"❌ Failed to backup configuration: {e}")
            return ""
    
    def remove_cryptos_from_config(self, affected_cryptos: Set[str]) -> bool:
        """Remove affected cryptocurrencies from database configuration"""
        if not affected_cryptos:
            return True
        
        try:
            if not self.db:
                self.logger.error("❌ Database not available for configuration update")
                return False
            
            # Backup original configuration
            self.backup_config()
            
            # Remove affected cryptocurrency configurations from database
            removed_cryptos = []
            
            for crypto in affected_cryptos:
                pair_key = f"{crypto}-USDT"
                
                # Check if crypto pair exists in database
                config = self.db.get_crypto_config(pair_key)
                if config:
                    # Remove from database
                    self.db.cursor.execute('DELETE FROM crypto_limits WHERE inst_id = %s', (pair_key,))
                    removed_cryptos.append(crypto)
                    self.logger.info(f"🗑️  Removed from database configuration: {pair_key}")
            
            # Commit changes
            if removed_cryptos:
                self.db.conn.commit()
                
                # Get updated count
                remaining_cryptos = self.db.get_configured_cryptos()
                new_count = len(remaining_cryptos)
                
                self.logger.info(f"✅ Database configuration cleanup completed: {len(removed_cryptos)} removed")
                self.logger.info(f"📋 Removed cryptocurrencies: {removed_cryptos}")
                self.logger.info(f"📊 Remaining crypto pairs: {new_count}")
                
                return True
            else:
                self.logger.info("ℹ️ No cryptocurrencies found in database configuration that need to be removed")
                return True
                
        except Exception as e:
            self.logger.error(f"❌ Failed to clean database configuration: {e}")
            return False
    
    def get_config_stats(self) -> Dict[str, Any]:
        """Get database configuration statistics"""
        try:
            if not self.db:
                self.logger.error("❌ Database not available for statistics")
                return {}
            
            # Load configuration from database
            config_data = self.db.load_limits_config()
            if not config_data:
                return {}
            
            crypto_configs = config_data.get('crypto_configs', {})
            return {
                'total_cryptos': len(crypto_configs),
                'crypto_pairs': list(crypto_configs.keys()),
                'strategy_name': config_data.get('strategy_name', 'Unknown'),
                'generated_at': config_data.get('generated_at', 'Unknown')
            }
        except Exception as e:
            self.logger.error(f"❌ Failed to get database configuration statistics: {e}")
            return {}
    
    def load_full_config(self) -> Dict[str, Any]:
        """Load full configuration from database"""
        try:
            if not self.db:
                self.logger.error("❌ Database not available")
                return {}
            
            config_data = self.db.load_limits_config()
            if config_data:
                self.logger.info(f"📋 Loaded full configuration from database: {len(config_data.get('crypto_configs', {}))} crypto pairs")
            return config_data or {}
        except Exception as e:
            self.logger.error(f"❌ Failed to load full configuration from database: {e}")
            return {}
    
    def get_crypto_config(self, inst_id: str) -> Dict[str, Any]:
        """Get configuration for specific crypto pair"""
        try:
            if not self.db:
                self.logger.error("❌ Database not available")
                return {}
            
            config = self.db.get_crypto_config(inst_id)
            return config or {}
        except Exception as e:
            self.logger.error(f"❌ Failed to get crypto config for {inst_id}: {e}")
            return {}


def test_config_manager():
    """Test configuration manager functionality"""
    import tempfile
    import os
    
    # Create temporary test configuration
    test_config = {
        "strategy_name": "test",
        "crypto_configs": {
            "BTC-USDT": {"best_limit": 94},
            "ETH-USDT": {"best_limit": 90},
            "XRP-USDT": {"best_limit": 87}
        }
    }
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        json.dump(test_config, f, indent=2)
        test_file = f.name
    
    try:
        # Test configuration manager
        config_manager = ConfigManager(test_file)
        
        print("🧪 Testing configuration manager")
        print("="*50)
        
        # Test loading configuration
        cryptos = config_manager.load_configured_cryptos()
        print(f"📋 Loaded cryptocurrencies: {sorted(cryptos)}")
        
        # Test statistics
        stats = config_manager.get_config_stats()
        print(f"📊 Configuration statistics: {stats}")
        
        # Test removing configuration
        affected = {'BTC', 'XRP'}
        success = config_manager.remove_cryptos_from_config(affected)
        print(f"🗑️  Removal operation successful: {success}")
        
        # Verify removal result
        remaining_cryptos = config_manager.load_configured_cryptos()
        print(f"📋 Remaining cryptocurrencies: {sorted(remaining_cryptos)}")
        
        if remaining_cryptos == {'ETH'}:
            print("✅ Test passed")
        else:
            print("❌ Test failed")
            
    finally:
        # Clean up test file
        if os.path.exists(test_file):
            os.remove(test_file)
        # Clean up possible backup files
        for file in os.listdir('.'):
            if file.startswith('limits_backup_') and file.endswith('.json'):
                os.remove(file)


if __name__ == "__main__":
    test_config_manager()
