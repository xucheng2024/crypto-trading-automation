#!/usr/bin/env python3
"""
OKX Delist Spot 监控脚本 (重构版)
每5分钟检查是否有今天的delist spot公告
如果有就发出警报并执行保护操作
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

# 导入我们的模块
from config_manager import ConfigManager
from crypto_matcher import CryptoMatcher
from protection_manager import ProtectionManager


class OKXDelistMonitor:
    """OKX Delist 监控器 (重构版)"""
    
    def __init__(self):
        # API 配置
        self.api_key = os.environ.get('OKX_API_KEY', '')
        self.secret_key = os.environ.get('OKX_SECRET_KEY', '')
        self.passphrase = os.environ.get('OKX_PASSPHRASE', '')
        self.base_url = "https://www.okx.com/api/v5/support/announcements"
        
        # 监控配置
        self.check_interval = 600  # 10分钟 = 600秒 (match crontab)
        self.known_announcements = set()  # 记录已知的公告ID
        
        # 设置日志
        self.setup_logging()
        
        # 初始化管理器
        self.config_manager = ConfigManager(logger=self.logger)
        self.crypto_matcher = CryptoMatcher(self.config_manager, self.logger)
        self.protection_manager = ProtectionManager(self.config_manager, logger=self.logger)
        
        self.logger.info("🚀 OKX Delist Monitor 初始化完成")
    
    def setup_logging(self):
        """设置日志系统"""
        # 创建logs目录
        os.makedirs('logs', exist_ok=True)
        
        # 设置日志文件名
        log_filename = f"monitor_delist_{datetime.now().strftime('%Y%m%d')}.log"
        log_path = os.path.join('logs', log_filename)
        
        # 配置日志 (带轮转)
        self.logger = logging.getLogger(__name__)
        self.logger.setLevel(logging.INFO)
        
        # 清除现有handlers
        self.logger.handlers.clear()
        
        # 创建formatter
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        
        # 文件handler (带轮转，最大10MB，保留5个备份)
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, 
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5,
            encoding='utf-8'
        )
        file_handler.setFormatter(formatter)
        
        # 控制台handler
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        
        # 添加handlers
        self.logger.addHandler(file_handler)
        self.logger.addHandler(console_handler)
    
    def generate_signature(self, timestamp: str, method: str, request_path: str, body: str = '') -> str:
        """生成OKX API签名"""
        pre_hash_string = timestamp + method + request_path + body
        signature = hmac.new(
            self.secret_key.encode('utf-8'),
            pre_hash_string.encode('utf-8'),
            hashlib.sha256
        ).digest()
        return base64.b64encode(signature).decode('utf-8')
    
    def get_headers(self, timestamp: str, signature: str) -> Dict[str, str]:
        """生成请求头"""
        return {
            'OK-ACCESS-KEY': self.api_key,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': self.passphrase,
            'Content-Type': 'application/json'
        }
    
    def fetch_delist_announcements(self, page: int = 1) -> List[Dict[str, Any]]:
        """获取delist公告"""
        max_retries = 3
        base_delay = 60  # 1 minute base delay
        
        for attempt in range(max_retries):
            try:
                # 构建请求路径
                request_path = f'/api/v5/support/announcements?annType=announcements-delistings&page={page}'
                
                # 生成时间戳和签名
                timestamp = datetime.utcnow().isoformat("T", "milliseconds") + 'Z'
                signature = self.generate_signature(timestamp, 'GET', request_path)
                headers = self.get_headers(timestamp, signature)
                
                # 发送请求
                response = requests.get(self.base_url, params={
                    'annType': 'announcements-delistings',
                    'page': page
                }, headers=headers, timeout=10)
                
                if response.status_code == 200:
                    data = response.json()
                    if data.get('code') == '0':
                        return data['data'][0]['details']
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
        """检查是否是今天的公告"""
        try:
            # 解析时间戳
            timestamp = int(announcement['pTime']) / 1000
            announcement_date = datetime.fromtimestamp(timestamp)
            today = datetime.now()
            
            # 检查是否是今天
            return (announcement_date.year == today.year and 
                   announcement_date.month == today.month and 
                   announcement_date.day == today.day)
        except:
            return False
    
    def send_protection_alert(self, announcement: Dict[str, Any], affected_cryptos: Set[str]):
        """发送保护警报并执行保护操作"""
        timestamp = int(announcement['pTime']) / 1000
        date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        
        print("\n" + "="*80)
        print("🚨 警报！发现影响配置加密货币的Delist公告！")
        print("="*80)
        print(f"📅 发布时间: {date}")
        print(f"📢 公告标题: {announcement['title']}")
        print(f"🎯 受影响的加密货币: {sorted(affected_cryptos)}")
        print(f"🔗 详细链接: {announcement['url']}")
        print(f"⏰ 时间戳: {announcement['pTime']}")
        print("="*80)
        
        # 执行保护操作
        self.logger.warning(f"🚨 检测到影响加密货币的Delist公告: {announcement['title']}")
        self.logger.warning(f"🎯 受影响的加密货币: {sorted(affected_cryptos)}")
        
        results = self.protection_manager.execute_full_protection(affected_cryptos)
        self.protection_manager.print_protection_summary(results)
    
    def send_info_alert(self, announcement: Dict[str, Any]):
        """发送信息警报（不执行保护操作）"""
        timestamp = int(announcement['pTime']) / 1000
        date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        
        print("\n" + "="*60)
        print("ℹ️  发现Delist Spot公告")
        print("="*60)
        print(f"📅 发布时间: {date}")
        print(f"📢 公告标题: {announcement['title']}")
        print(f"🔗 详细链接: {announcement['url']}")
        print(f"⏰ 时间戳: {announcement['pTime']}")
        print("="*60)
        
        self.logger.info(f"ℹ️ 发现Delist Spot公告: {announcement['title']}")
    
    def play_alert_sound(self):
        """播放警报声音"""
        print("\n🔊 持续警报中... 按回车键停止警报")
        
        # 持续播放系统提示音
        alert_count = 0
        while True:
            try:
                # 播放系统提示音（macOS）
                os.system('afplay /System/Library/Sounds/Glass.aiff')
                alert_count += 1
                
                # 每3次提示音后显示计数
                if alert_count % 3 == 0:
                    print(f"🔊 已播放 {alert_count} 次警报音... 按回车键停止")
                
                # 等待0.8秒后继续
                time.sleep(0.8)
                
            except KeyboardInterrupt:
                print("\n🛑 警报已停止")
                break
            except Exception as e:
                self.logger.warning(f"❌ 播放提示音失败: {e}")
                break
        
        print("✅ 警报结束")
    
    def check_for_new_announcements(self):
        """检查新公告"""
        self.logger.info(f"🔍 [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 开始检查delist公告...")
        
        try:
            # 获取第1页公告
            announcements = self.fetch_delist_announcements(page=1)
            
            if not announcements:
                self.logger.error("❌ 无法获取公告数据")
                return
            
            # 检查是否有今天的delist spot公告
            today_spot_announcements = []
            today_affected_announcements = []
            
            for ann in announcements:
                if self.is_today_announcement(ann):
                    # 生成唯一ID（使用标题和时间戳）
                    announcement_id = f"{ann['title']}_{ann['pTime']}"
                    
                    # 检查是否是新公告
                    if announcement_id not in self.known_announcements:
                        # 检查是否是spot相关的公告
                        if self.crypto_matcher.is_spot_related(ann):
                            today_spot_announcements.append(ann)
                            self.known_announcements.add(announcement_id)
                            
                            # 同时检查是否影响配置的加密货币
                            is_affected, affected_cryptos = self.crypto_matcher.check_announcement_impact(ann)
                            if is_affected:
                                ann['affected_cryptos'] = affected_cryptos
                                today_affected_announcements.append(ann)
            
            # 对所有新的delist spot公告播放警报声
            if today_spot_announcements:
                self.logger.warning(f"🔊 发现 {len(today_spot_announcements)} 条新的delist spot公告！")
                # 先播放警报声
                self.play_alert_sound()
                
                # 然后处理影响配置加密货币的公告
                if today_affected_announcements:
                    self.logger.warning(f"🎯 其中 {len(today_affected_announcements)} 条影响配置加密货币！")
                    for ann in today_affected_announcements:
                        self.send_protection_alert(ann, ann['affected_cryptos'])
                else:
                    self.logger.info("✅ 这些spot公告不影响你配置的加密货币")
                    for ann in today_spot_announcements:
                        self.send_info_alert(ann)
            else:
                self.logger.info("✅ 没有发现新的delist spot公告")
                
        except Exception as e:
            self.logger.error(f"❌ 检查过程中出错: {e}")
    
    def run_monitor(self):
        """运行监控（持续运行模式）"""
        self.logger.info("🚀 OKX Delist Spot 监控启动 (持续运行模式)")
        self.logger.info(f"⏰ 检查间隔: {self.check_interval}秒 ({self.check_interval/60:.0f}分钟)")
        self.logger.info(f"🔑 API密钥: {'✅ 已配置' if self.api_key else '❌ 未配置'}")
        self.logger.info(f"🔑 密钥: {'✅ 已配置' if self.secret_key else '❌ 未配置'}")
        self.logger.info(f"🔑 密码: {'✅ 已配置' if self.passphrase else '❌ 未配置'}")
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            self.logger.error("❌ 环境变量配置不完整，请检查.env文件")
            return
        
        # 显示配置统计
        stats = self.config_manager.get_config_stats()
        self.logger.info(f"📋 监控 {stats.get('total_cryptos', 0)} 个配置的加密货币")
        
        print("\n开始监控... (按 Ctrl+C 停止)")
        
        try:
            while True:
                self.check_for_new_announcements()
                self.logger.info(f"⏳ 等待 {self.check_interval} 秒后再次检查...")
                time.sleep(self.check_interval)
                
        except KeyboardInterrupt:
            self.logger.info("\n🛑 监控已停止")
        except Exception as e:
            self.logger.error(f"\n❌ 监控运行出错: {e}")
    
    def run_once(self):
        """运行一次检查（适用于crontab）"""
        self.logger.info("🚀 OKX Delist Spot 监控启动 (单次运行模式)")
        self.logger.info(f"🔑 API密钥: {'✅ 已配置' if self.api_key else '❌ 未配置'}")
        self.logger.info(f"🔑 密钥: {'✅ 已配置' if self.secret_key else '❌ 未配置'}")
        self.logger.info(f"🔑 密码: {'✅ 已配置' if self.passphrase else '❌ 未配置'}")
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            self.logger.error("❌ 环境变量配置不完整，请检查.env文件")
            return
        
        # 显示配置统计
        stats = self.config_manager.get_config_stats()
        self.logger.info(f"📋 监控 {stats.get('total_cryptos', 0)} 个配置的加密货币")
        
        # 执行一次检查
        self.check_for_new_announcements()
        self.logger.info("✅ 单次检查完成，程序退出")


def main():
    """主函数"""
    try:
        monitor = OKXDelistMonitor()
        
        # 检查是否有命令行参数来切换模式
        if len(sys.argv) > 1 and sys.argv[1] == "--continuous":
            # 持续运行模式（手动启动时使用）
            monitor.run_monitor()
        else:
            # 单次运行模式（默认，适用于crontab）
            monitor.run_once()
            
    except Exception as e:
        print(f"❌ 程序启动失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
