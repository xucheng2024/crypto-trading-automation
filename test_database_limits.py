#!/usr/bin/env python3
"""
Test script for database limits implementation
"""

import os
import sys
import json
from datetime import datetime

# Load environment variables
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

def test_database_connection():
    """Test database connection"""
    print("🧪 Testing database connection...")
    try:
        from lib.database import Database
        db = Database()
        if db.connect():
            print("✅ Database connection successful")
            db.disconnect()
            return True
        else:
            print("❌ Database connection failed")
            return False
    except Exception as e:
        print(f"❌ Database connection error: {e}")
        return False

def test_limits_migration():
    """Test limits migration from JSON to database"""
    print("\n🧪 Testing limits migration...")
    
    # Check if limits.json exists
    if not os.path.exists('limits.json'):
        print("❌ limits.json not found - cannot test migration")
        return False
    
    try:
        # Run migration script
        from migrate_limits_to_db import migrate_limits_to_database
        if migrate_limits_to_database():
            print("✅ Limits migration successful")
            return True
        else:
            print("❌ Limits migration failed")
            return False
    except Exception as e:
        print(f"❌ Migration test error: {e}")
        return False

def test_config_manager():
    """Test config manager with database"""
    print("\n🧪 Testing config manager...")
    try:
        from config_manager import ConfigManager
        config_manager = ConfigManager()
        
        # Test loading configured cryptos
        cryptos = config_manager.load_configured_cryptos()
        print(f"✅ Loaded {len(cryptos)} configured cryptocurrencies")
        
        # Test loading full config
        full_config = config_manager.load_full_config()
        if full_config:
            crypto_count = len(full_config.get('crypto_configs', {}))
            print(f"✅ Loaded full configuration with {crypto_count} crypto pairs")
        else:
            print("❌ Failed to load full configuration")
            return False
        
        # Test getting config stats
        stats = config_manager.get_config_stats()
        if stats:
            print(f"✅ Configuration stats: {stats['total_cryptos']} cryptos, strategy: {stats['strategy_name']}")
        else:
            print("❌ Failed to get configuration stats")
            return False
        
        return True
    except Exception as e:
        print(f"❌ Config manager test error: {e}")
        return False

def test_crypto_config_retrieval():
    """Test retrieving specific crypto configurations"""
    print("\n🧪 Testing crypto config retrieval...")
    try:
        from config_manager import ConfigManager
        config_manager = ConfigManager()
        
        # Test getting a specific crypto config
        test_pairs = ['BTC-USDT', 'ETH-USDT', 'XRP-USDT']
        
        for pair in test_pairs:
            config = config_manager.get_crypto_config(pair)
            if config:
                best_limit = config.get('best_limit', 'N/A')
                print(f"✅ {pair}: best_limit = {best_limit}")
            else:
                print(f"⚠️  {pair}: No configuration found")
        
        return True
    except Exception as e:
        print(f"❌ Crypto config retrieval test error: {e}")
        return False

def test_database_operations():
    """Test direct database operations"""
    print("\n🧪 Testing direct database operations...")
    try:
        from lib.database import Database
        db = Database()
        if not db.connect():
            print("❌ Failed to connect to database")
            return False
        
        # Test getting configured cryptos
        cryptos = db.get_configured_cryptos()
        print(f"✅ Database has {len(cryptos)} configured crypto pairs")
        
        # Test getting specific crypto config
        if cryptos:
            test_pair = cryptos[0]
            config = db.get_crypto_config(test_pair)
            if config:
                print(f"✅ Retrieved config for {test_pair}: {config.get('best_limit', 'N/A')}")
            else:
                print(f"❌ Failed to retrieve config for {test_pair}")
                return False
        
        # Test loading full config
        full_config = db.load_limits_config()
        if full_config:
            crypto_count = len(full_config.get('crypto_configs', {}))
            print(f"✅ Loaded full config from database: {crypto_count} crypto pairs")
        else:
            print("❌ Failed to load full config from database")
            return False
        
        db.disconnect()
        return True
    except Exception as e:
        print(f"❌ Database operations test error: {e}")
        return False

def main():
    """Run all tests"""
    print("=" * 60)
    print("🧪 Database Limits Implementation Test Suite")
    print("=" * 60)
    
    tests = [
        ("Database Connection", test_database_connection),
        ("Limits Migration", test_limits_migration),
        ("Config Manager", test_config_manager),
        ("Crypto Config Retrieval", test_crypto_config_retrieval),
        ("Database Operations", test_database_operations)
    ]
    
    passed = 0
    total = len(tests)
    
    for test_name, test_func in tests:
        print(f"\n📋 Running: {test_name}")
        try:
            if test_func():
                passed += 1
                print(f"✅ {test_name} PASSED")
            else:
                print(f"❌ {test_name} FAILED")
        except Exception as e:
            print(f"❌ {test_name} ERROR: {e}")
    
    print("\n" + "=" * 60)
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed! Database limits implementation is working correctly.")
        return True
    else:
        print("⚠️  Some tests failed. Please check the implementation.")
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
