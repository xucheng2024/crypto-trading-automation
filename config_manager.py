#!/usr/bin/env python3
"""
Configuration Management Module
Responsible for loading, cleaning, and backing up limits.json configuration files
"""

import json
import shutil
import logging
from datetime import datetime
from typing import Set, Dict, Any, Optional


class ConfigManager:
    """Configuration File Manager"""
    
    def __init__(self, config_file: str = 'limits.json', logger: Optional[logging.Logger] = None):
        self.config_file = config_file
        self.logger = logger or logging.getLogger(__name__)
    
    def load_configured_cryptos(self) -> Set[str]:
        """Load configured cryptocurrency list from limits.json"""
        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # Extract all cryptocurrency pairs, remove -USDT suffix to get base currency symbol
            crypto_pairs = list(data.get('crypto_configs', {}).keys())
            base_cryptos = set()
            
            for pair in crypto_pairs:
                if '-USDT' in pair:
                    base_crypto = pair.replace('-USDT', '')
                    base_cryptos.add(base_crypto)
            
            self.logger.info(f"📋 Loaded {len(base_cryptos)} configured cryptocurrencies: {sorted(base_cryptos)}")
            return base_cryptos
            
        except FileNotFoundError:
            self.logger.warning(f"⚠️ {self.config_file} file not found, will monitor all delist announcements")
            return set()
        except json.JSONDecodeError as e:
            self.logger.error(f"❌ {self.config_file} format error: {e}")
            return set()
        except Exception as e:
            self.logger.error(f"❌ Failed to load {self.config_file}: {e}")
            return set()
    
    def backup_config(self) -> str:
        """Backup configuration file, return backup filename"""
        backup_filename = f"limits_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        try:
            shutil.copy(self.config_file, backup_filename)
            self.logger.info(f"📋 Original configuration backed up to: {backup_filename}")
            return backup_filename
        except Exception as e:
            self.logger.error(f"❌ Failed to backup configuration file: {e}")
            raise
    
    def remove_cryptos_from_config(self, affected_cryptos: Set[str]) -> bool:
        """Remove affected cryptocurrencies from configuration"""
        if not affected_cryptos:
            return True
        
        try:
            # Backup original configuration file
            self.backup_config()
            
            # Read current configuration
            with open(self.config_file, 'r', encoding='utf-8') as f:
                limits_config = json.load(f)
            
            # Count configurations before removal
            original_count = len(limits_config.get('crypto_configs', {}))
            
            # Remove affected cryptocurrency configurations
            removed_cryptos = []
            crypto_configs = limits_config.get('crypto_configs', {})
            
            for crypto in affected_cryptos:
                pair_key = f"{crypto}-USDT"
                if pair_key in crypto_configs:
                    del crypto_configs[pair_key]
                    removed_cryptos.append(crypto)
                    self.logger.info(f"🗑️  Removed from configuration: {pair_key}")
            
            # Update configuration and save
            if removed_cryptos:
                limits_config['crypto_configs'] = crypto_configs
                
                with open(self.config_file, 'w', encoding='utf-8') as f:
                    json.dump(limits_config, f, indent=2, ensure_ascii=False)
                
                new_count = len(crypto_configs)
                self.logger.info(f"✅ Configuration cleanup completed: {original_count} -> {new_count} ({len(removed_cryptos)} removed)")
                self.logger.info(f"📋 Removed cryptocurrencies: {removed_cryptos}")
                
                return True
            else:
                self.logger.info("ℹ️ No cryptocurrencies found in configuration that need to be removed")
                return True
                
        except Exception as e:
            self.logger.error(f"❌ Failed to clean configuration file: {e}")
            return False
    
    def get_config_stats(self) -> Dict[str, Any]:
        """Get configuration file statistics"""
        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            crypto_configs = data.get('crypto_configs', {})
            return {
                'total_cryptos': len(crypto_configs),
                'crypto_pairs': list(crypto_configs.keys()),
                'strategy_name': data.get('strategy_name', 'Unknown'),
                'generated_at': data.get('generated_at', 'Unknown')
            }
        except Exception as e:
            self.logger.error(f"❌ Failed to get configuration statistics: {e}")
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
