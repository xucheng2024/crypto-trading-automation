#!/usr/bin/env python3
"""
Cryptocurrency Matching Function Module
Responsible for checking if announcements affect configured cryptocurrencies
"""

import logging
from typing import Set, Tuple, Optional
from config_manager import ConfigManager


class CryptoMatcher:
    """Cryptocurrency Matcher"""
    
    def __init__(self, config_manager: Optional[ConfigManager] = None, logger: Optional[logging.Logger] = None):
        self.config_manager = config_manager or ConfigManager()
        self.logger = logger or logging.getLogger(__name__)
        self.configured_cryptos = self.config_manager.load_configured_cryptos()
    
    def is_spot_related(self, announcement: dict) -> bool:
        """Check if it's related to spot trading"""
        title = announcement.get('title', '').lower()
        return 'spot' in title or 'spot trading' in title
    
    def find_affected_cryptos(self, announcement_text: str) -> Set[str]:
        """Find affected cryptocurrencies in announcement text"""
        if not self.configured_cryptos:
            return set()
        
        announcement_upper = announcement_text.upper()
        affected_cryptos = set()
        
        for crypto in self.configured_cryptos:
            crypto_upper = crypto.upper()
            # Check if cryptocurrency symbol is in the text
            if crypto_upper in announcement_upper:
                affected_cryptos.add(crypto)
        
        return affected_cryptos
    
    def check_announcement_impact(self, announcement: dict) -> Tuple[bool, Set[str]]:
        """Check if announcement affects configured cryptocurrencies"""
        # Check if it's related to spot trading
        if not self.is_spot_related(announcement):
            return False, set()
        
        # Get announcement text
        title = announcement.get('title', '')
        
        # Find affected cryptocurrencies
        affected_cryptos = self.find_affected_cryptos(title)
        
        is_affected = len(affected_cryptos) > 0
        
        if is_affected:
            self.logger.warning(f"🎯 Found affected cryptocurrencies: {sorted(affected_cryptos)}")
        
        return is_affected, affected_cryptos
    
    def reload_config(self):
        """Reload configuration"""
        self.configured_cryptos = self.config_manager.load_configured_cryptos()


# Compatibility functions, maintain backward compatibility
def load_configured_cryptos():
    """Load configured cryptocurrency list from limits.json"""
    config_manager = ConfigManager()
    return config_manager.load_configured_cryptos()

def find_affected_cryptos(announcement_text, configured_cryptos):
    """Find affected cryptocurrencies in announcement text"""
    matcher = CryptoMatcher()
    matcher.configured_cryptos = configured_cryptos
    return matcher.find_affected_cryptos(announcement_text)

def check_announcement_impact(announcement_text):
    """Check if announcement affects configured cryptocurrencies"""
    announcement = {'title': announcement_text}
    matcher = CryptoMatcher()
    has_impact, affected_cryptos = matcher.check_announcement_impact(announcement)
    return has_impact, affected_cryptos


def test_crypto_matcher():
    """Test cryptocurrency matcher"""
    print("🧪 Testing cryptocurrency matcher")
    print("="*50)
    
    matcher = CryptoMatcher()
    
    print(f"📋 Configured cryptocurrencies count: {len(matcher.configured_cryptos)}")
    print(f"📋 Configured cryptocurrencies: {sorted(list(matcher.configured_cryptos)[:5])}...")  # Only show first 5
    
    # Test announcements
    test_announcements = [
        {
            'title': 'OKX to delist X, BSV, GOG, DIA, BONE and OXT spot trading pairs'
        },
        {
            'title': 'OKX to delist BTC, ETH, and XRP spot trading pairs'
        },
        {
            'title': 'Notice on Delisting of DOGE, SHIB Spot Trading Pairs'
        }
    ]
    
    for i, announcement in enumerate(test_announcements, 1):
        print(f"\n📢 Test announcement {i}: {announcement['title']}")
        is_affected, affected_cryptos = matcher.check_announcement_impact(announcement)
        print(f"   Result: {'🎯 Affected' if is_affected else '✅ Not affected'}")
        if affected_cryptos:
            print(f"   Affected cryptocurrencies: {sorted(affected_cryptos)}")
    
    print("\n✅ Testing completed")


if __name__ == "__main__":
    test_crypto_matcher()
