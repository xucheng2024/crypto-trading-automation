#!/usr/bin/env python3
"""
OKX API 客户端封装模块
负责与 OKX API 的交互，包括余额查询和交易操作
"""

import os
import logging
from typing import Dict, Any, Optional, Tuple
try:
    from okx import Funding, Trade, MarketData, Account
    OKX_AVAILABLE = True
except ImportError:
    OKX_AVAILABLE = False
    Funding = None
    Trade = None
    MarketData = None
    Account = None


class OKXClient:
    """OKX API 客户端封装"""
    
    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger or logging.getLogger(__name__)
        self.api_key = os.getenv('OKX_API_KEY', '')
        self.secret_key = os.getenv('OKX_SECRET_KEY', '')
        self.passphrase = os.getenv('OKX_PASSPHRASE', '')
        
        self.funding_api = None
        self.trade_api = None
        self.market_api = None
        self.account_api = None
        
        self._init_clients()
    
    def _init_clients(self):
        """初始化 OKX API 客户端"""
        if not OKX_AVAILABLE:
            self.logger.warning("⚠️ OKX SDK 未安装，相关功能将被禁用")
            return
        
        try:
            # 获取交易环境设置
            testnet = os.getenv('OKX_TESTNET', 'false')
            okx_flag = "1" if testnet.lower() == "true" else "0"
            
            # 初始化 Market API (公共数据，不需要认证)
            self.market_api = MarketData.MarketAPI(
                flag=okx_flag,
                debug=False
            )
            
            # 检查认证API凭证
            if all([self.api_key, self.secret_key, self.passphrase]):
                # 初始化 Funding API (用于检查余额)
                self.funding_api = Funding.FundingAPI(
                    api_key=self.api_key,
                    api_secret_key=self.secret_key,
                    passphrase=self.passphrase,
                    flag=okx_flag,
                    debug=False
                )
                
                # 初始化 Trade API (用于市价卖出)
                self.trade_api = Trade.TradeAPI(
                    api_key=self.api_key,
                    api_secret_key=self.secret_key,
                    passphrase=self.passphrase,
                    flag=okx_flag,
                    debug=False
                )
                
                # 初始化 Account API (用于交易账户余额)
                try:
                    self.account_api = Account.AccountAPI(
                        api_key=self.api_key,
                        api_secret_key=self.secret_key,
                        passphrase=self.passphrase,
                        flag=okx_flag,
                        debug=False
                    )
                except Exception as e:
                    self.logger.warning(f"⚠️ 初始化 Account API 失败: {e}")
                self.logger.info(f"✅ OKX API 客户端初始化成功 (环境: {'Demo' if okx_flag == '1' else 'Live'})")
            else:
                self.logger.warning("⚠️ OKX API 凭证不完整，认证功能将被禁用")
                self.logger.info(f"✅ OKX Market API 初始化成功 (环境: {'Demo' if okx_flag == '1' else 'Live'})")
            
        except Exception as e:
            self.logger.error(f"❌ 初始化 OKX API 客户端失败: {e}")
            self.funding_api = None
            self.trade_api = None
            self.market_api = None
    
    def is_available(self) -> bool:
        """检查 OKX 客户端是否可用"""
        return self.funding_api is not None and self.trade_api is not None
    
    def get_funding_api(self):
        """获取 Funding API 实例"""
        return self.funding_api
    
    def get_trade_api(self):
        """获取 Trade API 实例"""
        return self.trade_api
    
    def get_market_api(self):
        """获取 Market API 实例"""
        return self.market_api
    
    def get_account_api(self):
        """获取 Account API 实例"""
        return self.account_api
    
    def is_market_available(self) -> bool:
        """检查 Market API 是否可用（不需要认证）"""
        return self.market_api is not None
    
    def get_affected_balances(self, affected_cryptos: set) -> Dict[str, Dict[str, float]]:
        """检查受影响加密货币的余额（交易账户）"""
        if not affected_cryptos:
            return {}
        
        if not self.account_api:
            self.logger.warning("⚠️ Account API 未初始化，无法检查交易账户余额")
            return {}
        
        self.logger.info(f"🔍 检查受影响加密货币的交易账户余额: {sorted(affected_cryptos)}")
        
        affected_balances = {}
        
        try:
            # 一次性获取所有交易账户余额
            result = self.account_api.get_account_balance()
            self.logger.info(f"🔎 交易账户余额返回(ALL): {result}")
            if not result or result.get('code') != '0':
                self.logger.warning(f"⚠️ 获取交易账户余额失败: {result}")
                return {}
            data = result.get('data', [])
            if not data:
                return {}
            details = data[0].get('details', [])
            for detail in details:
                ccy = detail.get('ccy')
                if not ccy or ccy not in affected_cryptos:
                    continue
                avail = float(detail.get('availBal', 0))
                if avail > 0:
                    affected_balances[ccy] = {'availBal': avail}
                    self.logger.warning(f"🎯 发现受影响的交易余额: {ccy} = {avail}")
            
            if affected_balances:
                self.logger.warning(f"📊 共发现 {len(affected_balances)} 个受影响币种在交易账户有余额")
            else:
                self.logger.info("✅ 受影响的加密货币在交易账户均无余额")
        except Exception as e:
            self.logger.error(f"❌ 检查交易账户余额时发生错误: {e}")
        
        return affected_balances
    
    def execute_market_sell(self, crypto: str, available_balance: float) -> bool:
        """执行市价卖出操作"""
        if not self.trade_api:
            self.logger.error(f"❌ Trade API 未初始化，无法卖出 {crypto}")
            return False
        
        try:
            # 构造交易对 (crypto + USDT)
            inst_id = f"{crypto}-USDT"
            
            self.logger.info(f"🔄 执行市价卖出: {crypto} (数量: {available_balance})")
            
            # 执行市价卖出订单
            result = self.trade_api.place_order(
                instId=inst_id,
                tdMode="cash",      # 现货交易模式
                side="sell",        # 卖出
                ordType="market",   # 市价订单
                sz=str(available_balance),  # 卖出数量（基础货币）
                tgtCcy="base_ccy"   # 明确指定按基础货币数量卖出
            )
            
            if result.get('code') == '0':
                order_data = result.get('data', [{}])[0]
                order_id = order_data.get('ordId', 'N/A')
                self.logger.info(f"✅ 市价卖出成功: {crypto} 订单ID: {order_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                self.logger.error(f"❌ 市价卖出失败: {crypto} - {error_msg}")
                return False
                
        except Exception as e:
            self.logger.error(f"❌ 执行市价卖出时发生错误: {crypto} - {e}")
            return False
    
    def sell_affected_balances(self, affected_balances: Dict[str, Dict[str, float]]) -> Tuple[int, int]:
        """批量卖出受影响的余额，返回(成功数量, 总数量)"""
        if not affected_balances:
            return 0, 0
        
        sell_results = {}
        for crypto, balance_info in affected_balances.items():
            available_bal = balance_info['availBal']
            success = self.execute_market_sell(crypto, available_bal)
            sell_results[crypto] = success
        
        successful_sells = sum(1 for success in sell_results.values() if success)
        total_sells = len(sell_results)
        
        return successful_sells, total_sells


def test_okx_client():
    """测试 OKX 客户端（不实际调用 API）"""
    print("🧪 测试 OKX 客户端")
    print("="*50)
    
    client = OKXClient()
    
    print(f"📋 客户端可用性: {client.is_available()}")
    print(f"🔑 API 密钥: {'已配置' if client.api_key else '未配置'}")
    print(f"🔧 SDK 可用性: {'可用' if OKX_AVAILABLE else '不可用'}")
    
    # 模拟测试受影响的加密货币
    affected_cryptos = {'BTC', 'ETH'}
    print(f"🎯 测试受影响的加密货币: {sorted(affected_cryptos)}")
    
    # 如果客户端不可用，这是正常的（在测试环境中）
    if not client.is_available():
        print("ℹ️ 客户端不可用，这在测试环境中是正常的")
    
    print("✅ 测试完成")


if __name__ == "__main__":
    test_okx_client()
