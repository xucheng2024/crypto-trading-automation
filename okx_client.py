#!/usr/bin/env python3
"""
OKX API Client Wrapper Module
Responsible for interacting with OKX API, including balance queries and trading operations
"""

import os
import logging
from typing import Dict, Any, Optional, Tuple

# Initialize variables
OKX_AVAILABLE = False
OKX_VERSION = "unknown"
Funding = None
Trade = None
MarketData = None
PublicData = None
Account = None

# Try to import OKX SDK
try:
    import okx
    OKX_VERSION = getattr(okx, '__version__', 'unknown')
    logging.info(f"✅ OKX SDK imported successfully, version: {OKX_VERSION}")
    
    # Try to import various modules
    try:
        import okx.Funding as Funding
        logging.info("✅ Funding module imported successfully")
    except ImportError as e:
        logging.warning(f"⚠️ Funding module import failed: {e}")
        Funding = None
    
    try:
        import okx.Trade as Trade
        logging.info("✅ Trade module imported successfully")
    except ImportError as e:
        logging.warning(f"⚠️ Trade module import failed: {e}")
        Trade = None
    
    try:
        import okx.MarketData as MarketData
        logging.info("✅ MarketData module imported successfully")
    except ImportError as e:
        logging.warning(f"⚠️ MarketData module import failed: {e}")
        MarketData = None
    
    try:
        import okx.PublicData as PublicData
        logging.info("✅ PublicData module imported successfully")
    except ImportError as e:
        logging.warning(f"⚠️ PublicData module import failed: {e}")
        PublicData = None
    
    try:
        import okx.Account as Account
        logging.info("✅ Account module imported successfully")
    except ImportError as e:
        logging.warning(f"⚠️ Account module import failed: {e}")
        Account = None
    
    # Check if any modules are available
    if any([Funding, Trade, MarketData, Account, PublicData]):
        OKX_AVAILABLE = True
        logging.info("✅ OKX SDK partial modules available")
    else:
        logging.warning("⚠️ OKX SDK all modules unavailable")
        
except ImportError as e:
    logging.warning(f"⚠️ OKX SDK import failed: {e}")
    OKX_AVAILABLE = False

class OKXClient:
    """OKX API Client Wrapper"""
    
    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger or logging.getLogger(__name__)
        self.api_key = os.getenv('OKX_API_KEY', '')
        self.secret_key = os.getenv('OKX_SECRET_KEY', '')
        self.passphrase = os.getenv('OKX_PASSPHRASE', '')
        
        self.funding_api = None
        self.trade_api = None
        self.market_api = None
        self.account_api = None
        self.public_api = None
        
        self._init_clients()
    
    def _init_clients(self):
        """Initialize OKX API clients"""
        if not OKX_AVAILABLE:
            self.logger.warning("⚠️ OKX SDK not installed, related features will be disabled")
            return
        
        try:
            # Get trading environment setting
            testnet = os.getenv('OKX_TESTNET', 'false')
            okx_flag = "1" if testnet.lower() == "true" else "0"
            
            # Initialize Market API (public data, no authentication required)
            if MarketData:
                try:
                    self.market_api = MarketData.MarketAPI(
                        flag=okx_flag,
                        debug=False
                    )
                    self.logger.info("✅ Market API initialized successfully")
                except Exception as e:
                    self.logger.warning(f"⚠️ Market API initialization failed: {e}")
            
            # Initialize Public API (for get_instruments - tickSz, lotSz, minSz)
            if PublicData:
                try:
                    self.public_api = PublicData.PublicAPI(
                        flag=okx_flag,
                        debug=False
                    )
                    self.logger.info("✅ Public API initialized successfully")
                except Exception as e:
                    self.logger.warning(f"⚠️ Public API initialization failed: {e}")
            
            # Check authentication API credentials
            if all([self.api_key, self.secret_key, self.passphrase]):
                if Funding:
                    try:
                        # Initialize Funding API (for balance check)
                        self.funding_api = Funding.FundingAPI(
                            api_key=self.api_key,
                            api_secret_key=self.secret_key,
                            passphrase=self.passphrase,
                            flag=okx_flag,
                            debug=False
                        )
                        self.logger.info("✅ Funding API initialized successfully")
                    except Exception as e:
                        self.logger.warning(f"⚠️ Funding API initialization failed: {e}")
                
                if Trade:
                    try:
                        # Initialize Trade API (for market sell)
                        self.trade_api = Trade.TradeAPI(
                            api_key=self.api_key,
                            api_secret_key=self.secret_key,
                            passphrase=self.passphrase,
                            flag=okx_flag,
                            debug=False
                        )
                        self.logger.info("✅ Trade API initialized successfully")
                    except Exception as e:
                        self.logger.warning(f"⚠️ Trade API initialization failed: {e}")
                
                if Account:
                    try:
                        # Initialize Account API (for trading account balance)
                        self.account_api = Account.AccountAPI(
                            api_key=self.api_key,
                            api_secret_key=self.secret_key,
                            passphrase=self.passphrase,
                            flag=okx_flag,
                            debug=False
                        )
                        self.logger.info("✅ Account API initialized successfully")
                    except Exception as e:
                        self.logger.warning(f"⚠️ Account API initialization failed: {e}")
                
                # Check if any APIs are available
                available_apis = []
                if self.funding_api: available_apis.append("Funding")
                if self.trade_api: available_apis.append("Trade")
                if self.account_api: available_apis.append("Account")
                
                if available_apis:
                    self.logger.info(f"✅ OKX API client initialized successfully (Environment: {'Demo' if okx_flag == '1' else 'Live'}, Available APIs: {', '.join(available_apis)})")
                else:
                    self.logger.warning("⚠️ All authenticated API initializations failed")
            else:
                self.logger.warning("⚠️ OKX API credentials incomplete, authentication features will be disabled")
                if self.market_api:
                    self.logger.info("✅ OKX Market API initialized successfully (only public data)")
            
        except Exception as e:
            self.logger.error(f"❌ Failed to initialize OKX API client: {e}")
            self.funding_api = None
            self.trade_api = None
            self.market_api = None
            self.public_api = None
    
    def is_available(self) -> bool:
        """Check if OKX client is available"""
        return self.funding_api is not None and self.trade_api is not None
    
    def get_funding_api(self):
        """Get Funding API instance"""
        return self.funding_api
    
    def get_trade_api(self):
        """Get Trade API instance"""
        return self.trade_api
    
    def get_market_api(self):
        """Get Market API instance"""
        return self.market_api
    
    def get_public_api(self):
        """Get Public API instance (for instruments, etc.)"""
        return self.public_api
    
    def get_account_api(self):
        """Get Account API instance"""
        return self.account_api
    
    def is_market_available(self) -> bool:
        """Check if Market API is available (no authentication required)"""
        return self.market_api is not None
    
    def get_affected_balances(self, affected_cryptos: set) -> Dict[str, Dict[str, float]]:
        """Check balance of affected cryptocurrencies (trading account)"""
        if not affected_cryptos:
            return {}
        
        if not self.account_api:
            self.logger.warning("⚠️ Account API not initialized, cannot check trading account balance")
            return {}
        
        self.logger.info(f"🔍 Checking trading account balance for affected cryptocurrencies: {sorted(affected_cryptos)}")
        
        affected_balances = {}
        
        try:
            # Get all trading account balances at once
            result = self.account_api.get_account_balance()
            self.logger.info(f"🔎 Trading account balance returned (ALL): {result}")
            if not result or result.get('code') != '0':
                self.logger.warning(f"⚠️ Failed to get trading account balance: {result}")
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
                    self.logger.warning(f"🎯 Found affected trading balance: {ccy} = {avail}")
            
            if affected_balances:
                self.logger.warning(f"📊 Found {len(affected_balances)} affected cryptocurrencies with balances in the trading account")
            else:
                self.logger.info("✅ No affected cryptocurrencies with balances in the trading account")
        except Exception as e:
            self.logger.error(f"❌ Error occurred while checking trading account balance: {e}")
        
        return affected_balances
    
    def execute_market_sell(self, crypto: str, available_balance: float) -> bool:
        """Execute market sell operation"""
        if not self.trade_api:
            self.logger.error(f"❌ Trade API not initialized, cannot sell {crypto}")
            return False
        
        try:
            # Construct trading pair (crypto + USDT)
            inst_id = f"{crypto}-USDT"
            
            self.logger.info(f"🔄 Executing market sell: {crypto} (quantity: {available_balance})")
            
            # Execute market sell order
            result = self.trade_api.place_order(
                instId=inst_id,
                tdMode="cash",      # Cash trading mode
                side="sell",        # Sell
                ordType="market",   # Market order
                sz=str(available_balance),  # Sell quantity (base currency)
                tgtCcy="base_ccy"   # Explicitly specify selling by base currency quantity
            )
            
            if result.get('code') == '0':
                order_data = result.get('data', [{}])[0]
                order_id = order_data.get('ordId', 'N/A')
                self.logger.info(f"✅ Market sell successful: {crypto} Order ID: {order_id}")
                return True
            else:
                error_msg = result.get('msg', 'Unknown error')
                self.logger.error(f"❌ Market sell failed: {crypto} - {error_msg}")
                return False
                
        except Exception as e:
            self.logger.error(f"❌ Error occurred while executing market sell: {crypto} - {e}")
            return False
    
    def sell_affected_balances(self, affected_balances: Dict[str, Dict[str, float]]) -> Tuple[int, int]:
        """Batch sell affected balances, return (successful sells, total sells)"""
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
    """Test OKX client (does not actually call API)"""
    print("🧪 Testing OKX client")
    print("="*50)
    
    client = OKXClient()
    
    print(f"📋 Client availability: {client.is_available()}")
    print(f"🔑 API Key: {'Configured' if client.api_key else 'Not configured'}")
    print(f"🔧 SDK availability: {'Available' if OKX_AVAILABLE else 'Unavailable'}")
    
    # Simulate testing affected cryptocurrencies
    affected_cryptos = {'BTC', 'ETH'}
    print(f"🎯 Testing affected cryptocurrencies: {sorted(affected_cryptos)}")
    
    # If client is not available, this is normal (in test environment)
    if not client.is_available():
        print("ℹ️ Client is not available, this is normal in the test environment")
    
    print("✅ Testing complete")


if __name__ == "__main__":
    test_okx_client()
