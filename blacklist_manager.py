#!/usr/bin/env python3
"""
Blacklist Manager Module
Responsible for querying blacklisted cryptocurrencies from database
"""

import os
import logging
from typing import Set, Optional
import psycopg2
from psycopg2.extras import RealDictCursor

# Load environment variables first
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # If dotenv is not available, try to load from environment directly
    def load_dotenv():
        pass
    load_dotenv()


class BlacklistManager:
    """Blacklist Manager for cryptocurrency monitoring"""
    
    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger or logging.getLogger(__name__)
        self.db_config = self._get_db_config()
    
    def _get_db_config(self) -> dict:
        """Get database configuration from environment variables"""
        db_url = os.getenv('DATABASE_URL')
        if not db_url:
            return {}
        
        # Parse DATABASE_URL to get connection parameters
        try:
            import urllib.parse
            parsed = urllib.parse.urlparse(db_url)
            return {
                'host': parsed.hostname,
                'port': parsed.port or 5432,
                'database': parsed.path[1:],  # Remove leading '/'
                'user': parsed.username,
                'password': parsed.password
            }
        except Exception as e:
            self.logger.error(f"❌ Error parsing DATABASE_URL: {e}")
            return {}
    
    def get_blacklisted_cryptos(self) -> Set[str]:
        """Get list of blacklisted cryptocurrency symbols"""
        try:
            if not all(self.db_config.values()):
                self.logger.warning("⚠️ Database credentials not fully configured, skipping blacklist check")
                return set()
            
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT crypto_symbol 
                        FROM blacklist 
                        WHERE is_active = TRUE
                    """)
                    
                    results = cursor.fetchall()
                    blacklisted = {row['crypto_symbol'] for row in results}
                    
                    self.logger.info(f"📋 Loaded {len(blacklisted)} blacklisted cryptocurrencies: {sorted(blacklisted)}")
                    return blacklisted
                    
        except psycopg2.Error as e:
            self.logger.error(f"❌ Database error loading blacklist: {e}")
            return set()
        except Exception as e:
            self.logger.error(f"❌ Error loading blacklist: {e}")
            return set()
    
    def is_blacklisted(self, crypto_symbol: str) -> bool:
        """Check if a cryptocurrency is blacklisted"""
        try:
            if not all(self.db_config.values()):
                return False
            
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("""
                        SELECT 1 
                        FROM blacklist 
                        WHERE crypto_symbol = %s AND is_active = TRUE
                    """, (crypto_symbol,))
                    
                    return cursor.fetchone() is not None
                    
        except Exception as e:
            self.logger.error(f"❌ Error checking blacklist for {crypto_symbol}: {e}")
            return False
    
    def get_blacklist_reason(self, crypto_symbol: str) -> Optional[str]:
        """Get the reason for blacklisting a cryptocurrency"""
        try:
            if not all(self.db_config.values()):
                return None
            
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT reason, blacklist_type 
                        FROM blacklist 
                        WHERE crypto_symbol = %s AND is_active = TRUE
                    """, (crypto_symbol,))
                    
                    result = cursor.fetchone()
                    if result:
                        return f"{result['blacklist_type']}: {result['reason']}"
                    return None
                    
        except Exception as e:
            self.logger.error(f"❌ Error getting blacklist reason for {crypto_symbol}: {e}")
            return None


def test_blacklist_manager():
    """Test blacklist manager functionality"""
    print("🧪 Testing blacklist manager")
    print("="*50)
    
    manager = BlacklistManager()
    
    # Test getting all blacklisted cryptos
    blacklisted = manager.get_blacklisted_cryptos()
    print(f"📋 Blacklisted cryptocurrencies: {sorted(blacklisted)}")
    
    # Test checking specific cryptos
    test_cryptos = ['BTC', 'WBTC', 'ETH', 'JST']
    for crypto in test_cryptos:
        is_blacklisted = manager.is_blacklisted(crypto)
        reason = manager.get_blacklist_reason(crypto)
        status = "❌ Blacklisted" if is_blacklisted else "✅ Not blacklisted"
        print(f"   {crypto}: {status}")
        if reason:
            print(f"      Reason: {reason}")
    
    print("✅ Test completed")


if __name__ == "__main__":
    test_blacklist_manager()
