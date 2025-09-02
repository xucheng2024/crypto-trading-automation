#!/usr/bin/env python3
"""
Migration script to move limits.json configuration to PostgreSQL database
"""

import json
import os
import sys
from datetime import datetime

# Load environment variables
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from lib.database import Database

def migrate_limits_to_database():
    """Migrate limits.json to database"""
    print("🚀 Starting limits migration to database...")
    
    # Check if limits.json exists
    if not os.path.exists('limits.json'):
        print("❌ Error: limits.json not found in current directory")
        return False
    
    # Load limits.json
    try:
        with open('limits.json', 'r', encoding='utf-8') as f:
            limits_data = json.load(f)
        print(f"✅ Loaded limits.json with {len(limits_data.get('crypto_configs', {}))} crypto pairs")
    except Exception as e:
        print(f"❌ Failed to load limits.json: {e}")
        return False
    
    # Connect to database
    db = Database()
    if not db.connect():
        print("❌ Failed to connect to database")
        return False
    
    try:
        # Create tables if they don't exist
        if not db.create_tables():
            print("❌ Failed to create database tables")
            return False
        
        # Save limits configuration to database
        if not db.save_limits_config(limits_data):
            print("❌ Failed to save limits configuration to database")
            return False
        
        print("✅ Successfully migrated limits configuration to database")
        
        # Verify migration
        loaded_config = db.load_limits_config()
        if loaded_config:
            original_count = len(limits_data.get('crypto_configs', {}))
            migrated_count = len(loaded_config.get('crypto_configs', {}))
            print(f"📊 Verification: {original_count} original pairs, {migrated_count} migrated pairs")
            
            if original_count == migrated_count:
                print("✅ Migration verification successful")
                return True
            else:
                print("❌ Migration verification failed - count mismatch")
                return False
        else:
            print("❌ Failed to verify migration")
            return False
            
    except Exception as e:
        print(f"❌ Migration failed: {e}")
        return False
    finally:
        db.disconnect()

def main():
    """Main function"""
    print("=" * 60)
    print("📦 Limits Migration Tool")
    print("=" * 60)
    
    if migrate_limits_to_database():
        print("\n🎉 Migration completed successfully!")
        print("💡 You can now use database-based limits in your trading system")
        print("💡 Consider backing up limits.json before removing it")
    else:
        print("\n❌ Migration failed!")
        sys.exit(1)

if __name__ == "__main__":
    main()
