#!/usr/bin/env python3
"""
配置管理模块
负责加载、清理和备份 limits.json 配置文件
"""

import json
import shutil
import logging
from datetime import datetime
from typing import Set, Dict, Any, Optional


class ConfigManager:
    """配置文件管理器"""
    
    def __init__(self, config_file: str = 'limits.json', logger: Optional[logging.Logger] = None):
        self.config_file = config_file
        self.logger = logger or logging.getLogger(__name__)
    
    def load_configured_cryptos(self) -> Set[str]:
        """从 limits.json 加载配置的加密货币列表"""
        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # 提取所有加密货币对，去掉 -USDT 后缀得到基础货币符号
            crypto_pairs = list(data.get('crypto_configs', {}).keys())
            base_cryptos = set()
            
            for pair in crypto_pairs:
                if '-USDT' in pair:
                    base_crypto = pair.replace('-USDT', '')
                    base_cryptos.add(base_crypto)
            
            self.logger.info(f"📋 加载了 {len(base_cryptos)} 个配置的加密货币: {sorted(base_cryptos)}")
            return base_cryptos
            
        except FileNotFoundError:
            self.logger.warning(f"⚠️ {self.config_file} 文件未找到，将监控所有 delist 公告")
            return set()
        except json.JSONDecodeError as e:
            self.logger.error(f"❌ {self.config_file} 格式错误: {e}")
            return set()
        except Exception as e:
            self.logger.error(f"❌ 加载 {self.config_file} 失败: {e}")
            return set()
    
    def backup_config(self) -> str:
        """备份配置文件，返回备份文件名"""
        backup_filename = f"limits_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        try:
            shutil.copy(self.config_file, backup_filename)
            self.logger.info(f"📋 已备份原始配置到: {backup_filename}")
            return backup_filename
        except Exception as e:
            self.logger.error(f"❌ 备份配置文件失败: {e}")
            raise
    
    def remove_cryptos_from_config(self, affected_cryptos: Set[str]) -> bool:
        """从配置中移除受影响的加密货币"""
        if not affected_cryptos:
            return True
        
        try:
            # 备份原始配置文件
            self.backup_config()
            
            # 读取当前配置
            with open(self.config_file, 'r', encoding='utf-8') as f:
                limits_config = json.load(f)
            
            # 统计移除前的配置数量
            original_count = len(limits_config.get('crypto_configs', {}))
            
            # 移除受影响的加密货币配置
            removed_cryptos = []
            crypto_configs = limits_config.get('crypto_configs', {})
            
            for crypto in affected_cryptos:
                pair_key = f"{crypto}-USDT"
                if pair_key in crypto_configs:
                    del crypto_configs[pair_key]
                    removed_cryptos.append(crypto)
                    self.logger.info(f"🗑️  已从配置中移除: {pair_key}")
            
            # 更新配置并保存
            if removed_cryptos:
                limits_config['crypto_configs'] = crypto_configs
                
                with open(self.config_file, 'w', encoding='utf-8') as f:
                    json.dump(limits_config, f, indent=2, ensure_ascii=False)
                
                new_count = len(crypto_configs)
                self.logger.info(f"✅ 配置清理完成: {original_count} -> {new_count} ({len(removed_cryptos)} 个已移除)")
                self.logger.info(f"📋 已移除的加密货币: {removed_cryptos}")
                
                return True
            else:
                self.logger.info("ℹ️ 配置中没有找到需要移除的加密货币")
                return True
                
        except Exception as e:
            self.logger.error(f"❌ 清理配置文件失败: {e}")
            return False
    
    def get_config_stats(self) -> Dict[str, Any]:
        """获取配置文件统计信息"""
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
            self.logger.error(f"❌ 获取配置统计信息失败: {e}")
            return {}


def test_config_manager():
    """测试配置管理器功能"""
    import tempfile
    import os
    
    # 创建临时测试配置
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
        # 测试配置管理器
        config_manager = ConfigManager(test_file)
        
        print("🧪 测试配置管理器")
        print("="*50)
        
        # 测试加载配置
        cryptos = config_manager.load_configured_cryptos()
        print(f"📋 加载的加密货币: {sorted(cryptos)}")
        
        # 测试统计信息
        stats = config_manager.get_config_stats()
        print(f"📊 配置统计: {stats}")
        
        # 测试移除配置
        affected = {'BTC', 'XRP'}
        success = config_manager.remove_cryptos_from_config(affected)
        print(f"🗑️  移除操作成功: {success}")
        
        # 验证移除结果
        remaining_cryptos = config_manager.load_configured_cryptos()
        print(f"📋 剩余加密货币: {sorted(remaining_cryptos)}")
        
        if remaining_cryptos == {'ETH'}:
            print("✅ 测试通过")
        else:
            print("❌ 测试失败")
            
    finally:
        # 清理测试文件
        if os.path.exists(test_file):
            os.remove(test_file)
        # 清理可能的备份文件
        for file in os.listdir('.'):
            if file.startswith('limits_backup_') and file.endswith('.json'):
                os.remove(file)


if __name__ == "__main__":
    test_config_manager()
