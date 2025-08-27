#!/usr/bin/env python3
"""
加密货币匹配功能模块
负责检查公告是否影响配置的加密货币
"""

import logging
from typing import Set, Tuple, Optional
from config_manager import ConfigManager


class CryptoMatcher:
    """加密货币匹配器"""
    
    def __init__(self, config_manager: Optional[ConfigManager] = None, logger: Optional[logging.Logger] = None):
        self.config_manager = config_manager or ConfigManager()
        self.logger = logger or logging.getLogger(__name__)
        self.configured_cryptos = self.config_manager.load_configured_cryptos()
    
    def is_spot_related(self, announcement: dict) -> bool:
        """检查是否与spot相关"""
        title = announcement.get('title', '').lower()
        return 'spot' in title or '现货' in title
    
    def find_affected_cryptos(self, announcement_text: str) -> Set[str]:
        """在公告文本中查找受影响的加密货币"""
        if not self.configured_cryptos:
            return set()
        
        announcement_upper = announcement_text.upper()
        affected_cryptos = set()
        
        for crypto in self.configured_cryptos:
            crypto_upper = crypto.upper()
            # 检查加密货币符号是否在文本中
            if crypto_upper in announcement_upper:
                affected_cryptos.add(crypto)
        
        return affected_cryptos
    
    def check_announcement_impact(self, announcement: dict) -> Tuple[bool, Set[str]]:
        """检查公告是否影响配置的加密货币"""
        # 检查是否与spot相关
        if not self.is_spot_related(announcement):
            return False, set()
        
        # 获取公告文本
        title = announcement.get('title', '')
        
        # 查找受影响的加密货币
        affected_cryptos = self.find_affected_cryptos(title)
        
        is_affected = len(affected_cryptos) > 0
        
        if is_affected:
            self.logger.warning(f"🎯 发现受影响的加密货币: {sorted(affected_cryptos)}")
        
        return is_affected, affected_cryptos
    
    def reload_config(self):
        """重新加载配置"""
        self.configured_cryptos = self.config_manager.load_configured_cryptos()


# 兼容性函数，保持向后兼容
def load_configured_cryptos():
    """从 limits.json 加载配置的加密货币列表"""
    config_manager = ConfigManager()
    return config_manager.load_configured_cryptos()

def find_affected_cryptos(announcement_text, configured_cryptos):
    """在公告文本中查找受影响的加密货币"""
    matcher = CryptoMatcher()
    matcher.configured_cryptos = configured_cryptos
    return matcher.find_affected_cryptos(announcement_text)

def check_announcement_impact(announcement_text):
    """检查公告是否影响配置的加密货币"""
    announcement = {'title': announcement_text}
    matcher = CryptoMatcher()
    has_impact, affected_cryptos = matcher.check_announcement_impact(announcement)
    return has_impact, affected_cryptos


def test_crypto_matcher():
    """测试加密货币匹配器"""
    print("🧪 测试加密货币匹配器")
    print("="*50)
    
    matcher = CryptoMatcher()
    
    print(f"📋 配置的加密货币数量: {len(matcher.configured_cryptos)}")
    print(f"📋 配置的加密货币: {sorted(list(matcher.configured_cryptos)[:5])}...")  # 只显示前5个
    
    # 测试公告
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
        print(f"\n📢 测试公告 {i}: {announcement['title']}")
        is_affected, affected_cryptos = matcher.check_announcement_impact(announcement)
        print(f"   结果: {'🎯 有影响' if is_affected else '✅ 无影响'}")
        if affected_cryptos:
            print(f"   受影响的加密货币: {sorted(affected_cryptos)}")
    
    print("\n✅ 测试完成")


if __name__ == "__main__":
    test_crypto_matcher()
