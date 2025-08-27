#!/usr/bin/env python3
"""
保护操作管理模块
负责执行完整的保护流程：取消订单、卖出余额、清理配置、重新创建触发订单
"""

import subprocess
import sys
import logging
from typing import Set, Optional, Tuple
from config_manager import ConfigManager
from okx_client import OKXClient


class ProtectionManager:
    """保护操作管理器"""
    
    def __init__(self, 
                 config_manager: Optional[ConfigManager] = None, 
                 okx_client: Optional[OKXClient] = None, 
                 logger: Optional[logging.Logger] = None):
        self.config_manager = config_manager or ConfigManager()
        self.okx_client = okx_client or OKXClient()
        self.logger = logger or logging.getLogger(__name__)
    
    def execute_cancellation_scripts(self) -> bool:
        """执行取消订单脚本"""
        self.logger.info("🚨 开始执行自动取消订单...")
        
        # 脚本路径
        scripts = [
            ("cancel_pending_triggers.py", "取消所有待处理的触发订单"),
            ("cancel_pending_limits.py", "取消所有待处理的限价订单")
        ]
        
        success_count = 0
        
        for script_name, description in scripts:
            try:
                self.logger.info(f"执行脚本: {script_name} - {description}")
                
                # 执行脚本
                result = subprocess.run(
                    [sys.executable, script_name],
                    capture_output=True,
                    text=True,
                    timeout=300  # 5分钟超时
                )
                
                if result.returncode == 0:
                    self.logger.info(f"✅ {script_name} 执行成功")
                    if result.stdout:
                        self.logger.debug(f"脚本输出: {result.stdout}")
                    success_count += 1
                else:
                    self.logger.error(f"❌ {script_name} 执行失败 (退出码: {result.returncode})")
                    if result.stderr:
                        self.logger.error(f"错误信息: {result.stderr}")
                    if result.stdout:
                        self.logger.debug(f"脚本输出: {result.stdout}")
                        
            except subprocess.TimeoutExpired:
                self.logger.error(f"⏰ {script_name} 执行超时 (超过5分钟)")
            except FileNotFoundError:
                self.logger.error(f"❌ 找不到脚本文件: {script_name}")
            except Exception as e:
                self.logger.error(f"❌ 执行 {script_name} 时发生错误: {e}")
        
        self.logger.info(f"📊 取消订单脚本执行完成: {success_count}/{len(scripts)} 成功")
        
        if success_count == len(scripts):
            self.logger.info("✅ 所有订单取消脚本已成功执行")
        else:
            self.logger.warning("⚠️ 部分订单取消脚本执行失败，请检查日志")
        
        return success_count == len(scripts)
    
    def handle_affected_balances(self, affected_cryptos: Set[str]) -> Tuple[int, int]:
        """处理受影响的余额，返回(成功数量, 总数量)"""
        if not self.okx_client.is_available() or not affected_cryptos:
            return 0, 0
        
        # 检查受影响的余额
        affected_balances = self.okx_client.get_affected_balances(affected_cryptos)
        
        if not affected_balances:
            self.logger.info("✅ 受影响的加密货币均无余额，无需卖出")
            return 0, 0
        
        self.logger.info(f"🎯 发现 {len(affected_balances)} 个受影响的加密货币有余额，开始市价卖出...")
        
        # 执行批量卖出
        successful_sells, total_sells = self.okx_client.sell_affected_balances(affected_balances)
        
        self.logger.info(f"📊 市价卖出完成: {successful_sells}/{total_sells} 成功")
        
        return successful_sells, total_sells
    
    def recreate_algo_triggers(self) -> bool:
        """重新运行 create_algo_triggers.py 脚本"""
        try:
            self.logger.info("🔄 开始重新创建算法触发订单...")
            
            # 执行 create_algo_triggers.py 脚本
            result = subprocess.run(
                [sys.executable, 'create_algo_triggers.py'],
                capture_output=True,
                text=True,
                timeout=300  # 5分钟超时
            )
            
            if result.returncode == 0:
                self.logger.info("✅ create_algo_triggers.py 执行成功")
                if result.stdout:
                    self.logger.debug(f"脚本输出: {result.stdout}")
                return True
            else:
                self.logger.error(f"❌ create_algo_triggers.py 执行失败 (退出码: {result.returncode})")
                if result.stderr:
                    self.logger.error(f"错误信息: {result.stderr}")
                if result.stdout:
                    self.logger.debug(f"脚本输出: {result.stdout}")
                return False
                
        except subprocess.TimeoutExpired:
            self.logger.error("⏰ create_algo_triggers.py 执行超时 (超过5分钟)")
            return False
        except FileNotFoundError:
            self.logger.error("❌ 找不到脚本文件: create_algo_triggers.py")
            return False
        except Exception as e:
            self.logger.error(f"❌ 执行 create_algo_triggers.py 时发生错误: {e}")
            return False
    
    def execute_full_protection(self, affected_cryptos: Set[str]) -> dict:
        """执行完整的保护流程"""
        if not affected_cryptos:
            self.logger.info("ℹ️ 无受影响的加密货币，跳过保护操作")
            return {'status': 'skipped', 'reason': 'no_affected_cryptos'}
        
        self.logger.warning(f"🚨 开始执行完整保护流程，受影响的加密货币: {sorted(affected_cryptos)}")
        
        results = {
            'status': 'completed',
            'affected_cryptos': list(affected_cryptos),
            'cancellation_success': False,
            'sell_results': {'successful': 0, 'total': 0},
            'cleanup_success': False,
            'recreate_success': False
        }
        
        try:
            # 步骤1: 取消所有待处理订单
            self.logger.info("📋 步骤1: 取消所有待处理订单")
            results['cancellation_success'] = self.execute_cancellation_scripts()
            
            # 步骤2: 检查并卖出受影响的余额
            self.logger.info("💰 步骤2: 检查并卖出受影响的余额")
            successful_sells, total_sells = self.handle_affected_balances(affected_cryptos)
            results['sell_results'] = {'successful': successful_sells, 'total': total_sells}
            
            # 步骤3: 清理配置并重新创建触发订单
            self.logger.info("🧹 步骤3: 清理配置并重新创建触发订单")
            
            # 清理 limits.json 配置
            results['cleanup_success'] = self.config_manager.remove_cryptos_from_config(affected_cryptos)
            
            if results['cleanup_success']:
                # 重新创建算法触发订单
                results['recreate_success'] = self.recreate_algo_triggers()
            
            self.logger.info("🎉 完整保护流程执行完成")
            
        except Exception as e:
            self.logger.error(f"❌ 保护流程执行失败: {e}")
            results['status'] = 'failed'
            results['error'] = str(e)
        
        return results
    
    def print_protection_summary(self, results: dict):
        """打印保护操作摘要"""
        print("\n" + "="*80)
        print("📊 保护操作执行摘要")
        print("="*80)
        
        if results['status'] == 'skipped':
            print("ℹ️ 跳过保护操作 - 无受影响的加密货币")
            return
        
        print(f"🎯 受影响的加密货币: {results['affected_cryptos']}")
        print(f"📋 订单取消: {'✅ 成功' if results['cancellation_success'] else '❌ 失败'}")
        
        sell_results = results['sell_results']
        if sell_results['total'] > 0:
            print(f"💰 余额卖出: {sell_results['successful']}/{sell_results['total']} 成功")
        else:
            print("💰 余额卖出: ✅ 无需卖出")
        
        print(f"🧹 配置清理: {'✅ 成功' if results['cleanup_success'] else '❌ 失败'}")
        print(f"🔄 重新创建触发订单: {'✅ 成功' if results['recreate_success'] else '❌ 失败'}")
        
        if results['status'] == 'failed':
            print(f"❌ 执行失败: {results.get('error', 'Unknown error')}")
        else:
            print("🎉 保护流程执行完成")
        
        print("="*80)


def test_protection_manager():
    """测试保护管理器（不实际执行操作）"""
    print("🧪 测试保护管理器")
    print("="*50)
    
    manager = ProtectionManager()
    
    print(f"📋 配置管理器: {'可用' if manager.config_manager else '不可用'}")
    print(f"🔗 OKX 客户端: {'可用' if manager.okx_client.is_available() else '不可用'}")
    
    # 模拟受影响的加密货币
    affected_cryptos = {'BTC', 'ETH'}
    print(f"🎯 模拟受影响的加密货币: {sorted(affected_cryptos)}")
    
    # 注意：这里不实际执行保护操作，只测试结构
    print("ℹ️ 在测试环境中不执行实际的保护操作")
    
    print("✅ 测试完成")


if __name__ == "__main__":
    test_protection_manager()
