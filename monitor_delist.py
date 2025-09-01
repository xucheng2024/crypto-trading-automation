#!/usr/bin/env python3
"""
OKX Delist Spot Monitoring Script (Refactored Version)
Checks every 5 minutes for today's delist spot announcements
If found, issues alerts and executes protection operations
"""

import requests
import time
import os
import sys
import logging
import logging.handlers
import hmac
import hashlib
import base64
from datetime import datetime, timedelta
from typing import Set, List, Dict, Any

# Load environment variables first
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    def load_dotenv():
        pass
    load_dotenv()

# Import our modules
from config_manager import ConfigManager
from crypto_matcher import CryptoMatcher
from protection_manager import ProtectionManager
from blacklist_manager import BlacklistManager


class OKXDelistMonitor:
    """OKX Delist Monitor (Refactored Version)"""
    
    def __init__(self):
        # API configuration
        self.api_key = os.environ.get('OKX_API_KEY', '')
        self.secret_key = os.environ.get('OKX_SECRET_KEY', '')
        self.passphrase = os.environ.get('OKX_PASSPHRASE', '')
        self.base_url = "https://www.okx.com/api/v5/support/announcements"
        
        # Monitoring configuration
        self.check_interval = 600  # 10 minutes = 600 seconds (match crontab)
        self._found_announcements = False  # Track if announcements were found
        
        # Setup logging
        self.setup_logging()
        
        # Initialize managers
        self.config_manager = ConfigManager(logger=self.logger)
        self.crypto_matcher = CryptoMatcher(self.config_manager, self.logger)
        self.protection_manager = ProtectionManager(self.config_manager, logger=self.logger)
        self.blacklist_manager = BlacklistManager(logger=self.logger)
        
        self.logger.info("🚀 OKX Delist Monitor initialization completed")
    
    def setup_logging(self):
        """Setup logging system"""
        # Create logs directory
        os.makedirs('logs', exist_ok=True)
        
        # Set log filename
        log_filename = f"monitor_delist_{datetime.now().strftime('%Y%m%d')}.log"
        log_path = os.path.join('logs', log_filename)
        
        # Configure logging (with rotation)
        self.logger = logging.getLogger(__name__)
        self.logger.setLevel(logging.INFO)
        
        # Clear existing handlers
        self.logger.handlers.clear()
        
        # Create formatter
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        
        # File handler (with rotation, max 10MB, keep 5 backups)
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, 
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5,
            encoding='utf-8'
        )
        file_handler.setFormatter(formatter)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        
        # Add handlers
        self.logger.addHandler(file_handler)
        self.logger.addHandler(console_handler)
    
    def generate_signature(self, timestamp: str, method: str, request_path: str, body: str = '') -> str:
        """Generate OKX API signature"""
        pre_hash_string = timestamp + method + request_path + body
        signature = hmac.new(
            self.secret_key.encode('utf-8'),
            pre_hash_string.encode('utf-8'),
            hashlib.sha256
        ).digest()
        return base64.b64encode(signature).decode('utf-8')
    
    def get_headers(self, timestamp: str, signature: str) -> Dict[str, str]:
        """Generate request headers"""
        return {
            'OK-ACCESS-KEY': self.api_key,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': self.passphrase,
            'Content-Type': 'application/json'
        }
    
    def fetch_delist_announcements(self, page: int = 1) -> List[Dict[str, Any]]:
        """Fetch delist announcements"""
        max_retries = 3
        base_delay = 60  # 1 minute base delay
        
        for attempt in range(max_retries):
            try:
                # Build request path
                request_path = f'/api/v5/support/announcements?annType=announcements-delistings&page={page}'
                
                # Generate timestamp and signature
                timestamp = datetime.utcnow().isoformat("T", "milliseconds") + 'Z'
                signature = self.generate_signature(timestamp, 'GET', request_path)
                headers = self.get_headers(timestamp, signature)
                
                # Send request
                response = requests.get(self.base_url, params={
                    'annType': 'announcements-delistings',
                    'page': page
                }, headers=headers, timeout=10)
                
                if response.status_code == 200:
                    data = response.json()
                    if data.get('code') == '0':
                        # Check if there's actual announcement data
                        if 'data' in data and len(data['data']) > 0 and 'details' in data['data'][0]:
                            self.logger.info(f"📢 Found {len(data['data'])} announcement(s)")
                            return data['data'][0]['details']
                        else:
                            self.logger.info("ℹ️ No announcement details found in API response")
                            return []
                    else:
                        self.logger.error(f"❌ OKX API error: {data}")
                        return []
                elif response.status_code == 429:
                    # Rate limit hit - exponential backoff
                    delay = base_delay * (2 ** attempt)
                    self.logger.warning(f"⚠️ Rate limit (429) | Attempt {attempt + 1}/{max_retries} | Wait {delay}s")
                    if attempt < max_retries - 1:
                        time.sleep(delay)
                        continue
                    else:
                        self.logger.error(f"❌ Rate limit exceeded after {max_retries} attempts")
                        return []
                else:
                    self.logger.error(f"❌ Request failed: {response.status_code}")
                    return []
                    
            except Exception as e:
                self.logger.error(f"❌ Fetch failed (attempt {attempt + 1}): {e}")
                if attempt < max_retries - 1:
                    time.sleep(base_delay)
                    continue
                else:
                    return []
        
        return []
    
    def is_today_announcement(self, announcement: Dict[str, Any]) -> bool:
        """Check if it's a today's announcement"""
        try:
            # Parse timestamp
            timestamp = int(announcement['pTime']) / 1000
            announcement_date = datetime.fromtimestamp(timestamp)
            today = datetime.now()
            
            # Check if it's today
            return (announcement_date.year == today.year and 
                   announcement_date.month == today.month and 
                   announcement_date.day == today.day)
        except:
            return False
    
    def send_protection_alert(self, announcement: Dict[str, Any], affected_cryptos: Set[str]):
        """Send protection alert and execute protection operations"""
        timestamp = int(announcement['pTime']) / 1000
        date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        announcement_id = f"{announcement['title']}_{announcement['pTime']}"
        
        print("\n" + "="*80)
        print("🚨 Alert! Delist announcement affecting configured cryptocurrencies found!")
        print("="*80)
        print(f"📅 Announcement Date: {date}")
        print(f"📢 Announcement Title: {announcement['title']}")
        print(f"🎯 Affected Cryptocurrencies: {sorted(affected_cryptos)}")
        print(f"🔗 Detailed Link: {announcement['url']}")
        print(f"⏰ Timestamp: {announcement['pTime']}")
        print("="*80)
        
        # Execute protection operations
        self.logger.warning(f"🚨 Delist announcement affecting configured cryptocurrencies detected: {announcement['title']}")
        self.logger.warning(f"🎯 Affected Cryptocurrencies: {sorted(affected_cryptos)}")
        
        results = self.protection_manager.execute_full_protection(affected_cryptos)
        self.protection_manager.print_protection_summary(results)
        
        # Add affected cryptocurrencies to blacklist
        if affected_cryptos:
            reason = f"Delisted due to OKX announcement: {announcement['title']}"
            notes = f"Announcement URL: {announcement['url']}, Timestamp: {announcement['pTime']}"
            
            added_count = self.blacklist_manager.add_multiple_to_blacklist(
                affected_cryptos, 
                reason, 
                blacklist_type='delisted',
                notes=notes
            )
            
            if added_count > 0:
                print(f"\n🚫 Added {added_count} affected cryptocurrencies to blacklist")
                self.logger.info(f"🚫 Added {added_count} affected cryptocurrencies to blacklist")
            else:
                print("\n⚠️ Failed to add affected cryptocurrencies to blacklist")
                self.logger.warning("⚠️ Failed to add affected cryptocurrencies to blacklist")
        
        # Mark announcement as processed
        self.blacklist_manager.mark_announcement_processed(
            announcement_id=announcement_id,
            title=announcement['title'],
            url=announcement['url'],
            p_time=int(announcement['pTime']),
            affected_cryptos=affected_cryptos,
            protection_executed=True,
            notes=f"Protection executed for {len(affected_cryptos)} cryptocurrencies"
        )
        
        # Recreate algo triggers after protection operations
        self.logger.info("🔄 Recreating algo triggers after protection operations...")
        try:
            import subprocess
            result = subprocess.run(['python', 'create_algo_triggers.py'], 
                                  capture_output=True, text=True, timeout=300)
            if result.returncode == 0:
                self.logger.info("✅ Algo triggers recreated successfully")
                print("\n✅ Algo triggers recreated successfully")
            else:
                self.logger.error(f"❌ Failed to recreate algo triggers: {result.stderr}")
                print(f"\n❌ Failed to recreate algo triggers: {result.stderr}")
        except subprocess.TimeoutExpired:
            self.logger.error("❌ Algo trigger recreation timed out")
            print("\n❌ Algo trigger recreation timed out")
        except Exception as e:
            self.logger.error(f"❌ Error recreating algo triggers: {e}")
            print(f"\n❌ Error recreating algo triggers: {e}")
    
    def send_info_alert(self, announcement: Dict[str, Any]):
        """Send information alert (does not execute protection operations)"""
        timestamp = int(announcement['pTime']) / 1000
        date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        announcement_id = f"{announcement['title']}_{announcement['pTime']}"
        
        print("\n" + "="*60)
        print("ℹ️  Delist Spot announcement found")
        print("="*60)
        print(f"📅 Announcement Date: {date}")
        print(f"📢 Announcement Title: {announcement['title']}")
        print(f"🔗 Detailed Link: {announcement['url']}")
        print(f"⏰ Timestamp: {announcement['pTime']}")
        print("="*60)
        
        self.logger.info(f"ℹ️ Delist Spot announcement found: {announcement['title']}")
        
        # Mark announcement as processed (info only, no protection)
        self.blacklist_manager.mark_announcement_processed(
            announcement_id=announcement_id,
            title=announcement['title'],
            url=announcement['url'],
            p_time=int(announcement['pTime']),
            affected_cryptos=None,
            protection_executed=False,
            notes="Info alert only - no protection executed"
        )
    

    
    def check_for_new_announcements(self):
        """Check for new announcements"""
        self.logger.info(f"🔍 [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting delist announcement check...")
        
        try:
            # Fetch announcements from page 1
            announcements = self.fetch_delist_announcements(page=1)
            
            if not announcements:
                self.logger.info("ℹ️ No announcements found - ending check")
                self._found_announcements = False
                return
            
            # Check for today's delist spot announcements
            today_spot_announcements = []
            today_affected_announcements = []
            
            for ann in announcements:
                if self.is_today_announcement(ann):
                    # Generate unique ID (using title and timestamp)
                    announcement_id = f"{ann['title']}_{ann['pTime']}"
                    
                    # Check if it's a new announcement (using database)
                    if not self.blacklist_manager.is_announcement_processed(announcement_id):
                        # Check if it's a spot-related announcement
                        if self.crypto_matcher.is_spot_related(ann):
                            today_spot_announcements.append(ann)
                            
                            # Also check if it affects configured cryptocurrencies
                            is_affected, affected_cryptos = self.crypto_matcher.check_announcement_impact(ann)
                            if is_affected:
                                # Filter out cryptocurrencies that are already blacklisted
                                non_blacklisted_cryptos = set()
                                already_blacklisted = set()
                                
                                for crypto in affected_cryptos:
                                    if self.blacklist_manager.is_blacklisted(crypto):
                                        already_blacklisted.add(crypto)
                                    else:
                                        non_blacklisted_cryptos.add(crypto)
                                
                                # Log blacklisted cryptos
                                if already_blacklisted:
                                    self.logger.info(f"🚫 Skipping already blacklisted cryptocurrencies: {sorted(already_blacklisted)}")
                                
                                # Only process non-blacklisted cryptos
                                if non_blacklisted_cryptos:
                                    ann['affected_cryptos'] = non_blacklisted_cryptos
                                    today_affected_announcements.append(ann)
                                else:
                                    self.logger.info(f"ℹ️ All affected cryptocurrencies are already blacklisted, skipping protection operations")
            
            # Play alert sound for all new delist spot announcements
            if today_spot_announcements:
                self.logger.warning(f"🔊 Found {len(today_spot_announcements)} new delist spot announcements!")
                self._found_announcements = True

                
                # Then process announcements affecting configured cryptocurrencies
                if today_affected_announcements:
                    self.logger.warning(f"🎯 Among them {len(today_affected_announcements)} affect configured cryptocurrencies!")
                    for ann in today_affected_announcements:
                        self.send_protection_alert(ann, ann['affected_cryptos'])
                else:
                    self.logger.info("✅ These spot announcements do not affect your configured cryptocurrencies")
                    for ann in today_spot_announcements:
                        self.send_info_alert(ann)
            else:
                self.logger.info("✅ No new delist spot announcements found")
                self._found_announcements = False
                
        except Exception as e:
            self.logger.error(f"❌ Error during check: {e}")
            self._found_announcements = False
    
    def run_monitor(self):
        """Run monitoring (continuous mode)"""
        self.logger.info("🚀 OKX Delist Spot Monitoring started (continuous mode)")
        self.logger.info(f"⏰ Check interval: {self.check_interval} seconds ({self.check_interval/60:.0f} minutes)")
        self.logger.info(f"🔑 API Key: {'✅ Configured' if self.api_key else '❌ Not Configured'}")
        self.logger.info(f"🔑 Secret Key: {'✅ Configured' if self.secret_key else '❌ Not Configured'}")
        self.logger.info(f"🔑 Passphrase: {'✅ Configured' if self.passphrase else '❌ Not Configured'}")
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            self.logger.error("❌ Environment variables not fully configured, please check .env file")
            return
        
        # Display configuration statistics
        stats = self.config_manager.get_config_stats()
        self.logger.info(f"📋 Monitoring {stats.get('total_cryptos', 0)} configured cryptocurrencies")
        
        print("\nStarting monitoring... (Press Ctrl+C to stop)")
        
        try:
            while True:
                self.check_for_new_announcements()
                self.logger.info(f"⏳ Waiting {self.check_interval} seconds before next check...")
                time.sleep(self.check_interval)
                
        except KeyboardInterrupt:
            self.logger.info("\n🛑 Monitoring stopped")
        except Exception as e:
            self.logger.error(f"\n❌ Monitoring error: {e}")
    
    def run_once(self):
        """Run a single check (for crontab)"""
        self.logger.info("🚀 OKX Delist Spot Monitoring started (single run mode)")
        self.logger.info(f"🔑 API Key: {'✅ Configured' if self.api_key else '❌ Not Configured'}")
        self.logger.info(f"🔑 Secret Key: {'✅ Configured' if self.secret_key else '❌ Not Configured'}")
        self.logger.info(f"🔑 Passphrase: {'✅ Configured' if self.passphrase else '❌ Not Configured'}")
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            self.logger.error("❌ Environment variables not fully configured, please check .env file")
            return
        
        # Display configuration statistics
        stats = self.config_manager.get_config_stats()
        self.logger.info(f"📋 Monitoring {stats.get('total_cryptos', 0)} configured cryptocurrencies")
        
        # Perform a single check
        self.check_for_new_announcements()
        
        # Check if we found any announcements to determine exit status
        if not hasattr(self, '_found_announcements') or not self._found_announcements:
            self.logger.info("✅ No announcements found - program exiting normally")
        else:
            self.logger.info("✅ Single check completed, program exiting")


def main():
    """Main function"""
    try:
        monitor = OKXDelistMonitor()
        
        # Check for command line arguments to switch mode
        if len(sys.argv) > 1 and sys.argv[1] == "--continuous":
            # Continuous run mode (use when manually started)
            monitor.run_monitor()
        else:
            # Single run mode (default, for crontab)
            monitor.run_once()
            
    except Exception as e:
        print(f"❌ Program startup failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
