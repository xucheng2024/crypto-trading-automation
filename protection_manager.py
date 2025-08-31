#!/usr/bin/env python3
"""
Protection Operation Management Module
Responsible for executing complete protection workflow: cancel orders, sell balances, clean configuration, recreate trigger orders
"""

import subprocess
import sys
import logging
from typing import Set, Optional, Tuple
from config_manager import ConfigManager
from okx_client import OKXClient


class ProtectionManager:
    """Protection Operation Manager"""
    
    def __init__(self, 
                 config_manager: Optional[ConfigManager] = None, 
                 okx_client: Optional[OKXClient] = None, 
                 logger: Optional[logging.Logger] = None):
        self.config_manager = config_manager or ConfigManager()
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
    
    def recreate_algo_triggers(self) -> bool:
        """Re-run create_algo_triggers.py script"""
        try:
            self.logger.info("🔄 Starting to re-create algorithm trigger orders...")
            
            # Execute create_algo_triggers.py script
            result = subprocess.run(
                [sys.executable, 'create_algo_triggers.py'],
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )
            
            if result.returncode == 0:
                self.logger.info("✅ create_algo_triggers.py executed successfully")
                if result.stdout:
                    self.logger.debug(f"Script output: {result.stdout}")
                return True
            else:
                self.logger.error(f"❌ create_algo_triggers.py execution failed (exit code: {result.returncode})")
                if result.stderr:
                    self.logger.error(f"Error message: {result.stderr}")
                if result.stdout:
                    self.logger.debug(f"Script output: {result.stdout}")
                return False
                
        except subprocess.TimeoutExpired:
            self.logger.error("⏰ create_algo_triggers.py execution timeout (exceeded 5 minutes)")
            return False
        except FileNotFoundError:
            self.logger.error("❌ Script file not found: create_algo_triggers.py")
            return False
        except Exception as e:
            self.logger.error(f"❌ Error occurred while executing create_algo_triggers.py: {e}")
            return False
    
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
            'sell_results': {'successful': 0, 'total': 0},
            'cleanup_success': False,
            'recreate_success': False
        }
        
        try:
            # Step 1: Cancel all pending orders
            self.logger.info("📋 Step 1: Cancel all pending orders")
            results['cancellation_success'] = self.execute_cancellation_scripts()
            
            # Step 2: Check and sell affected balances
            self.logger.info("💰 Step 2: Check and sell affected balances")
            successful_sells, total_sells = self.handle_affected_balances(affected_cryptos)
            results['sell_results'] = {'successful': successful_sells, 'total': total_sells}
            
            # Step 3: Clean configuration and recreate trigger orders
            self.logger.info("🧹 Step 3: Clean configuration and recreate trigger orders")
            
            # Clean up limits.json configuration
            results['cleanup_success'] = self.config_manager.remove_cryptos_from_config(affected_cryptos)
            
            if results['cleanup_success']:
                # Recreate algorithm trigger orders
                results['recreate_success'] = self.recreate_algo_triggers()
            
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
        print(f"�� Order cancellation: {'✅ Successful' if results['cancellation_success'] else '❌ Failed'}")
        
        sell_results = results['sell_results']
        if sell_results['total'] > 0:
            print(f"�� Balance selling: {sell_results['successful']}/{sell_results['total']} successful")
        else:
            print("💰 Balance selling: ✅ No selling needed")
        
        print(f"🧹 Configuration cleanup: {'✅ Successful' if results['cleanup_success'] else '❌ Failed'}")
        print(f"🔄 Recreate trigger orders: {'✅ Successful' if results['recreate_success'] else '❌ Failed'}")
        
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
    
    print(f"📋 Config Manager: {'Available' if manager.config_manager else 'Unavailable'}")
    print(f"🔗 OKX Client: {'Available' if manager.okx_client.is_available() else 'Unavailable'}")
    
    # Simulate affected cryptocurrencies
    affected_cryptos = {'BTC', 'ETH'}
    print(f"🎯 Simulate affected cryptocurrencies: {sorted(affected_cryptos)}")
    
    # Note: Protection operations are not actually executed here, only the structure is tested
    print("ℹ️ In a test environment, actual protection operations are not executed")
    
    print("✅ Test completed")


if __name__ == "__main__":
    test_protection_manager()
