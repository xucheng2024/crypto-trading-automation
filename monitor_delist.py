#!/usr/bin/env python3
"""
OKX Delist Spot 监控脚本
每5分钟检查是否有今天的delist spot公告
如果有就发出警报
"""

import requests
import time
import json
from datetime import datetime, timedelta
import os
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # If dotenv is not available, try to load from environment directly
    def load_dotenv():
        pass
    load_dotenv()

import hmac
import hashlib
import base64

class OKXDelistMonitor:
    def __init__(self):
        self.api_key = os.environ.get('OKX_API_KEY', '')
        self.secret_key = os.environ.get('OKX_SECRET_KEY', '')
        self.passphrase = os.environ.get('OKX_PASSPHRASE', '')
        self.base_url = "https://www.okx.com/api/v5/support/announcements"
        self.check_interval = 300  # 5分钟 = 300秒
        self.known_announcements = set()  # 记录已知的公告ID
        
    def generate_signature(self, timestamp, method, request_path, body=''):
        """生成OKX API签名"""
        pre_hash_string = timestamp + method + request_path + body
        signature = hmac.new(
            self.secret_key.encode('utf-8'),
            pre_hash_string.encode('utf-8'),
            hashlib.sha256
        ).digest()
        return base64.b64encode(signature).decode('utf-8')
    
    def get_headers(self, timestamp, signature):
        """生成请求头"""
        return {
            'OK-ACCESS-KEY': self.api_key,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': self.passphrase,
            'Content-Type': 'application/json'
        }
    
    def fetch_delist_announcements(self, page=1):
        """获取delist公告"""
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
                    print(f"❌ OKX API错误: {data}")
                    return []
            else:
                print(f"❌ 请求失败: {response.status_code}")
                return []
                
        except Exception as e:
            print(f"❌ 获取公告失败: {e}")
            return []
    
    def is_today_announcement(self, announcement):
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
    
    def is_spot_related(self, announcement):
        """检查是否与spot相关"""
        title = announcement['title'].lower()
        return 'spot' in title or '现货' in title
    
    def send_alert(self, announcement):
        """发送警报"""
        timestamp = int(announcement['pTime']) / 1000
        date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        
        print("\n" + "="*80)
        print("🚨 警报！发现今天的Delist Spot公告！")
        print("="*80)
        print(f"📅 发布时间: {date}")
        print(f"📢 公告标题: {announcement['title']}")
        print(f"🔗 详细链接: {announcement['url']}")
        print(f"⏰ 时间戳: {announcement['pTime']}")
        print("="*80)
        
        # 可以在这里添加其他警报方式，比如：
        # - 发送邮件
        # - 发送钉钉/企业微信消息
        # - 播放声音
        # - 发送推送通知
        
        # 持续警报直到用户确认
        print("\n🔊 持续警报中... 按回车键停止警报")
        
        # 持续播放系统提示音 - 更急促的警报
        alert_count = 0
        while True:
            try:
                # 播放系统提示音（macOS）
                os.system('afplay /System/Library/Sounds/Glass.aiff')
                alert_count += 1
                
                # 每3次提示音后显示计数（更频繁的反馈）
                if alert_count % 3 == 0:
                    print(f"🔊 已播放 {alert_count} 次警报音... 按回车键停止")
                
                # 等待0.8秒后继续（更急促的间隔）
                time.sleep(0.8)
                
            except KeyboardInterrupt:
                print("\n🛑 警报已停止")
                break
            except Exception as e:
                print(f"❌ 播放提示音失败: {e}")
                break
        
        print("✅ 警报结束")
    
    def check_for_new_announcements(self):
        """检查新公告"""
        print(f"\n🔍 [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 开始检查delist公告...")
        
        try:
            # 获取第1页公告
            announcements = self.fetch_delist_announcements(page=1)
            
            if not announcements:
                print("❌ 无法获取公告数据")
                return
            
            # 检查是否有今天的spot相关公告
            today_spot_announcements = []
            
            for ann in announcements:
                if self.is_today_announcement(ann) and self.is_spot_related(ann):
                    # 生成唯一ID（使用标题和时间戳）
                    announcement_id = f"{ann['title']}_{ann['pTime']}"
                    
                    # 检查是否是新公告
                    if announcement_id not in self.known_announcements:
                        today_spot_announcements.append(ann)
                        self.known_announcements.add(announcement_id)
            
            if today_spot_announcements:
                print(f"🎯 发现 {len(today_spot_announcements)} 条新的今日spot delist公告！")
                for ann in today_spot_announcements:
                    self.send_alert(ann)
            else:
                print("✅ 没有发现新的今日spot delist公告")
                
        except Exception as e:
            print(f"❌ 检查过程中出错: {e}")
    
    def run_monitor(self):
        """运行监控"""
        print("🚀 OKX Delist Spot 监控启动")
        print(f"⏰ 检查间隔: {self.check_interval}秒 ({self.check_interval/60:.1f}分钟)")
        print(f"🔑 API密钥: {'✅ 已配置' if self.api_key else '❌ 未配置'}")
        print(f"🔑 密钥: {'✅ 已配置' if self.secret_key else '❌ 未配置'}")
        print(f"🔑 密码: {'✅ 已配置' if self.passphrase else '❌ 未配置'}")
        
        if not all([self.api_key, self.secret_key, self.passphrase]):
            print("❌ 环境变量配置不完整，请检查.env.local文件")
            return
        
        print("\n开始监控... (按 Ctrl+C 停止)")
        
        try:
            while True:
                self.check_for_new_announcements()
                print(f"⏳ 等待 {self.check_interval} 秒后再次检查...")
                time.sleep(self.check_interval)
                
        except KeyboardInterrupt:
            print("\n\n🛑 监控已停止")
        except Exception as e:
            print(f"\n❌ 监控运行出错: {e}")

if __name__ == "__main__":
    monitor = OKXDelistMonitor()
    monitor.run_monitor()
