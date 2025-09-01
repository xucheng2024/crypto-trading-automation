#!/usr/bin/env python3
"""
Protection Operation Management Module
Responsible for executing complete protection workflow: cancel orders, sell balances, clean configuration, recreate trigger orders
"""

import subprocess
import sys
import logging
from typing import Set, Optional, Tuple
from okx_client import OKXClient


class ProtectionManager:
    """Protection Operation Manager"""
    
    def __init__(self, 
                 okx_client: Optional[OKXClient] = None, 
                 logger: Optional[logging.Logger] = None):
        self.okx_client = okx_client or OKXClient()
        self.logger = logger or logging.getLogger(__name__)
    
    def execute_cancellation_scripts(self) -> bool:
        """Execute order cancellation scripts"""
        self.logger.info("🚨 Starting automatic order cancellation...")
        
        # Script paths
        scripts = [
            ("cancel_pending_triggers.py", "Cancel all pending trigger orders"),
            ("cancel_pending_limits.py", "Cancel all pending limit orders")
        ]
        
        success_count = 0
        
        for script_name, description in scripts:
            try:
                self.logger.info(f"Executing script: {script_name} - {description}")
                
                # Execute script
                result = subprocess.run(
                    [sys.executable, script_name],
                    capture_output=True,
                    text=True,
                    timeout=300  # 5 minute timeout
                )
                
                if result.returncode == 0:
                    self.logger.info(f"✅ {script_name} executed successfully")
                    if result.stdout:
                        self.logger.debug(f"Script output: {result.stdout}")
                    success_count += 1
                else:
                    self.logger.error(f"❌ {script_name} execution failed (exit code: {result.returncode})")
                    if result.stderr:
                        self.logger.error(f"Error message: {result.stderr}")
                    if result.stdout:
                        self.logger.debug(f"Script output: {result.stdout}")
                        
            except subprocess.TimeoutExpired:
                self.logger.error(f"⏰ {script_name} execution timeout (exceeded 5 minutes)")
            except FileNotFoundError:
                self.logger.error(f"❌ Script file not found: {script_name}")
            except Exception as e:
                self.logger.error(f"❌ Error occurred while executing {script_name}: {e}")
        
        self.logger.info(f"📊 Order cancellation script execution completed: {success_count}/{len(scripts)} successful")
        
        if success_count == len(scripts):
            self.logger.info("✅ All order cancellation scripts executed successfully")
        else:
            self.logger.warning("⚠️ Some order cancellation scripts failed, please check logs")
        
        return success_count == len(scripts)
    
    def handle_affected_balances(self, affected_cryptos: Set[str]) -> Tuple[int, int]:
        """Handle affected balances, return (successful sells, total sells)"""
        if not self.okx_client.is_available() or not affected_cryptos:
            return 0, 0
        
        # Check affected balances
        affected_balances = self.okx_client.get_affected_balances(affected_cryptos)
        
        if not affected_balances:
            self.logger.info("✅ No balances found for affected cryptocurrencies, no selling needed")
            return 0, 0
        
        self.logger.info(f"🎯 Found {len(affected_balances)} affected cryptocurrencies with balances, starting market sell...")
        
        # Execute batch selling
        successful_sells, total_sells = self.okx_client.sell_affected_balances(affected_balances)
        
        self.logger.info(f"📊 Market sell completed: {successful_sells}/{total_sells} successful")
        
        return successful_sells, total_sells
    

    
    def execute_full_protection(self, affected_cryptos: Set[str]) -> dict:
        """Execute complete protection workflow"""
        if not affected_cryptos:
            self.logger.info("ℹ️ No affected cryptocurrencies, skipping protection operations")
            return {'status': 'skipped', 'reason': 'no_affected_cryptos'}
        
        self.logger.warning(f"🚨 Starting complete protection workflow, affected cryptocurrencies: {sorted(affected_cryptos)}")
        
        results = {
            'status': 'completed',
            'affected_cryptos': list(affected_cryptos),
            'cancellation_success': False,
            'sell_results': {'successful': 0, 'total': 0}
        }
        
        try:
            # Step 1: Cancel all pending orders
            self.logger.info("📋 Step 1: Cancel all pending orders")
            results['cancellation_success'] = self.execute_cancellation_scripts()
            
            # Step 2: Check and sell affected balances
            self.logger.info("💰 Step 2: Check and sell affected balances")
            successful_sells, total_sells = self.handle_affected_balances(affected_cryptos)
            results['sell_results'] = {'successful': successful_sells, 'total': total_sells}
            
            self.logger.info("🎉 Complete protection workflow executed")
            
        except Exception as e:
            self.logger.error(f"❌ Protection workflow failed: {e}")
            results['status'] = 'failed'
            results['error'] = str(e)
        
        return results
    
    def print_protection_summary(self, results: dict):
        """Print protection operation summary"""
        print("\n" + "="*80)
        print("📊 Protection Operation Execution Summary")
        print("="*80)
        
        if results['status'] == 'skipped':
            print("ℹ️ Protection skipped - no affected cryptocurrencies")
            return
        
        print(f"🎯 Affected cryptocurrencies: {results['affected_cryptos']}")
        print(f"📋 Order cancellation: {'✅ Successful' if results['cancellation_success'] else '❌ Failed'}")
        
        sell_results = results['sell_results']
        if sell_results['total'] > 0:
            print(f"💰 Balance selling: {sell_results['successful']}/{sell_results['total']} successful")
        else:
            print("💰 Balance selling: ✅ No selling needed")
        
        if results['status'] == 'failed':
            print(f"❌ Execution failed: {results.get('error', 'Unknown error')}")
        else:
            print("🎉 Protection workflow executed")
        
        print("="*80)


def test_protection_manager():
    """Test protection manager (does not perform actual operations)"""
    print("🧪 Testing protection manager")
    print("="*50)
    
    manager = ProtectionManager()
    
    print(f"🔗 OKX Client: {'Available' if manager.okx_client.is_available() else 'Unavailable'}")
    
    # Simulate affected cryptocurrencies
    affected_cryptos = {'BTC', 'ETH'}
    print(f"🎯 Simulate affected cryptocurrencies: {sorted(affected_cryptos)}")
    
    # Note: Protection operations are not actually executed here, only the structure is tested
    print("ℹ️ In a test environment, actual protection operations are not executed")
    
    print("✅ Test completed")


if __name__ == "__main__":
    test_protection_manager()
