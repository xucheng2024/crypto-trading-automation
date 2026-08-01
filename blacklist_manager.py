#!/usr/bin/env python3
"""
Blacklist Manager Module
Responsible for querying blacklisted cryptocurrencies from database
"""

import os
import logging
from typing import Set, Optional
from lib.db_backend import get_database_connection, get_database_cursor

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
        self.database_url = os.getenv('DATABASE_URL')
    
    def get_blacklisted_cryptos(self) -> Optional[Set[str]]:
        """Get active blacklist, or ``None`` when it cannot be verified.

        An empty set is a valid, verified result.  Callers that create orders
        must treat ``None`` as an error rather than as an empty blacklist.
        """
        try:
            if not self.database_url:
                self.logger.error("❌ Database credentials not fully configured; blacklist cannot be verified")
                return None
            
            with get_database_connection(self.database_url) as conn:
                with get_database_cursor(conn, dict_rows=True) as cursor:
                    cursor.execute("""
                        SELECT crypto_symbol 
                        FROM blacklist 
                        WHERE is_active = TRUE
                    """)
                    
                    results = cursor.fetchall()
                    blacklisted = {row['crypto_symbol'] for row in results}
                    
                    self.logger.info(f"📋 Loaded {len(blacklisted)} blacklisted cryptocurrencies: {sorted(blacklisted)}")
                    return blacklisted
                    
        except Exception as e:
            self.logger.error(f"❌ Error loading blacklist: {e}")
            return None
    
    def is_blacklisted(self, crypto_symbol: str) -> bool:
        """Check if a cryptocurrency is blacklisted"""
        try:
            if not self.database_url:
                return False
            
            with get_database_connection(self.database_url) as conn:
                with get_database_cursor(conn) as cursor:
                    cursor.execute("""
                        SELECT 1 
                        FROM blacklist 
                        WHERE crypto_symbol = ? AND is_active = TRUE
                    """, (crypto_symbol,))
                    
                    return cursor.fetchone() is not None
                    
        except Exception as e:
            self.logger.error(f"❌ Error checking blacklist for {crypto_symbol}: {e}")
            return False
    
    def get_blacklist_reason(self, crypto_symbol: str) -> Optional[str]:
        """Get the reason for blacklisting a cryptocurrency"""
        try:
            if not self.database_url:
                return None
            
            with get_database_connection(self.database_url) as conn:
                with get_database_cursor(conn, dict_rows=True) as cursor:
                    cursor.execute("""
                        SELECT reason, blacklist_type 
                        FROM blacklist 
                        WHERE crypto_symbol = ? AND is_active = TRUE
                    """, (crypto_symbol,))
                    
                    result = cursor.fetchone()
                    if result:
                        return f"{result['blacklist_type']}: {result['reason']}"
                    return None
                    
        except Exception as e:
            self.logger.error(f"❌ Error getting blacklist reason for {crypto_symbol}: {e}")
            return None
    
    def add_to_blacklist(self, crypto_symbol: str, reason: str, blacklist_type: str = 'delisted', notes: str = None) -> bool:
        """Add a cryptocurrency to blacklist"""
        try:
            if not self.database_url:
                self.logger.warning("⚠️ Database credentials not fully configured, skipping blacklist addition")
                return False
            
            with get_database_connection(self.database_url) as conn:
                with get_database_cursor(conn) as cursor:
                    cursor.execute("""
                        INSERT INTO blacklist (crypto_symbol, reason, blacklist_type, notes)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT (crypto_symbol) 
                        DO UPDATE SET 
                            reason = EXCLUDED.reason,
                            blacklist_type = EXCLUDED.blacklist_type,
                            notes = EXCLUDED.notes,
                            is_active = TRUE,
                            updated_at = CURRENT_TIMESTAMP
                    """, (crypto_symbol, reason, blacklist_type, notes))
                    
                    conn.commit()
                    self.logger.info(f"✅ Added {crypto_symbol} to blacklist: {reason}")
                    return True
                    
        except Exception as e:
            self.logger.error(f"❌ Error adding {crypto_symbol} to blacklist: {e}")
            return False
    
    def add_multiple_to_blacklist(self, crypto_symbols: Set[str], reason: str, blacklist_type: str = 'delisted', notes: str = None) -> int:
        """Add multiple cryptocurrencies to blacklist, return number of successful additions"""
        if not crypto_symbols:
            return 0
        
        success_count = 0
        for crypto in crypto_symbols:
            if self.add_to_blacklist(crypto, reason, blacklist_type, notes):
                success_count += 1
        
        self.logger.info(f"📋 Added {success_count}/{len(crypto_symbols)} cryptocurrencies to blacklist")
        return success_count
    
    def is_announcement_processed(self, announcement_id: str) -> bool:
        """Check if an announcement has been processed before"""
        try:
            if not self.database_url:
                return False
            
            with get_database_connection(self.database_url) as conn:
                with get_database_cursor(conn) as cursor:
                    cursor.execute("""
                        SELECT 1 
                        FROM processed_announcements 
                        WHERE announcement_id = ?
                    """, (announcement_id,))
                    
                    return cursor.fetchone() is not None
                    
        except Exception as e:
            self.logger.error(f"❌ Error checking if announcement {announcement_id} is processed: {e}")
            return False
    
    def mark_announcement_processed(self, announcement_id: str, title: str, url: str, 
                                  p_time: int, affected_cryptos: Set[str] = None, 
                                  protection_executed: bool = False, notes: str = None) -> bool:
        """Mark an announcement as processed"""
        try:
            if not self.database_url:
                self.logger.warning("⚠️ Database credentials not fully configured, skipping announcement tracking")
                return False
            
            with get_database_connection(self.database_url) as conn:
                with get_database_cursor(conn) as cursor:
                    cursor.execute("""
                        INSERT INTO processed_announcements 
                        (announcement_id, title, url, p_time, affected_cryptos, protection_executed, notes)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (announcement_id) DO NOTHING
                    """, (announcement_id, title, url, p_time,
                          sorted(affected_cryptos) if affected_cryptos else None,
                          protection_executed, notes))
                    
                    conn.commit()
                    self.logger.info(f"✅ Marked announcement as processed: {announcement_id}")
                    return True
                    
        except Exception as e:
            self.logger.error(f"❌ Error marking announcement {announcement_id} as processed: {e}")
            return False


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
