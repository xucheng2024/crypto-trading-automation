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
        
        # Create alias mapping for common trading pair formats
        self._create_alias_mapping()
    
    def is_spot_related(self, announcement: dict) -> bool:
        """Check if it's related to spot trading"""
        title = announcement.get('title', '').lower()
        return 'spot' in title or 'spot trading' in title
    
    def find_affected_cryptos(self, announcement_text: str) -> Set[str]:
        """Find affected cryptocurrencies in announcement text using improved matching"""
        if not self.configured_cryptos:
            return set()
        
        # Use the new alias-based matching
        return self._find_crypto_aliases(announcement_text)
    
    def _is_exact_match(self, crypto: str, text: str) -> bool:
        """Check if cryptocurrency appears as a complete word in text with improved regex"""
        import re
        
        # Ensure both crypto and text are uppercase for case-insensitive matching
        crypto_upper = crypto.upper()
        text_upper = text.upper()
        
        # Create a more precise regex pattern
        # (?<![A-Z0-9]) ensures the crypto is not preceded by alphanumeric characters
        # (?![A-Z0-9]) ensures the crypto is not followed by alphanumeric characters
        # re.I flag for case-insensitive matching (though we already converted to uppercase)
        pattern = re.compile(rf'(?<![A-Z0-9]){re.escape(crypto_upper)}(?![A-Z0-9])', re.I)
        
        return bool(pattern.search(text_upper))
    
    def _create_alias_mapping(self):
        """Create alias mapping for common trading pair formats"""
        self.alias_mapping = {}
        
        # Common quote currencies
        quote_currencies = ['USDT', 'USDC', 'BTC', 'ETH', 'USD', 'EUR', 'GBP']
        
        for crypto in self.configured_cryptos:
            crypto_upper = crypto.upper()
            aliases = {crypto_upper}  # Include the original crypto
            
            # Add common trading pair formats
            for quote in quote_currencies:
                # BTC-USDT, BTC/USDT, BTCUSDT formats
                aliases.add(f"{crypto_upper}-{quote}")
                aliases.add(f"{crypto_upper}/{quote}")
                aliases.add(f"{crypto_upper}{quote}")
            
            self.alias_mapping[crypto_upper] = aliases
    
    def _find_crypto_aliases(self, text: str) -> Set[str]:
        """Find all crypto aliases that appear in the text"""
        found_cryptos = set()
        text_upper = text.upper()
        
        for crypto, aliases in self.alias_mapping.items():
            for alias in aliases:
                if self._is_exact_match(alias, text_upper):
                    found_cryptos.add(crypto)
                    break  # Found this crypto, no need to check other aliases
        
        return found_cryptos
    
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
        self._create_alias_mapping()


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
