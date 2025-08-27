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
import subprocess
import sys
import logging
import shutil
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
try:
    from okx import Funding, Trade
except ImportError:
    print("⚠️ 警告: 未安装 okx SDK，无法执行余额检查和市价卖出功能")
    Funding = None
    Trade = None

class OKXDelistMonitor:
    def __init__(self):
        self.api_key = os.environ.get('OKX_API_KEY', '')
        self.secret_key = os.environ.get('OKX_SECRET_KEY', '')
        self.passphrase = os.environ.get('OKX_PASSPHRASE', '')
        self.base_url = "https://www.okx.com/api/v5/support/announcements"
        self.check_interval = 300  # 5分钟 = 300秒
        self.known_announcements = set()  # 记录已知的公告ID
        
        # 设置日志
        self.setup_logging()
        
        # 加载配置的加密货币列表
        self.configured_cryptos = self.load_configured_cryptos()
        
        # 初始化 OKX API 客户端
        self.init_okx_clients()
    
    def setup_logging(self):
        """设置日志系统"""
        # 创建logs目录
        os.makedirs('logs', exist_ok=True)
        
        # 设置日志文件名
        log_filename = f"monitor_delist_{datetime.now().strftime('%Y%m%d')}.log"
        log_path = os.path.join('logs', log_filename)
        
        # 配置日志
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler(log_path, encoding='utf-8'),
                logging.StreamHandler()
            ]
        )
        
        self.logger = logging.getLogger(__name__)
    
    def load_configured_cryptos(self):
        """从 limits.json 加载配置的加密货币列表"""
        try:
            with open('limits.json', 'r', encoding='utf-8') as f:
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
            self.logger.warning("⚠️ limits.json 文件未找到，将监控所有 delist 公告")
            return set()
        except json.JSONDecodeError as e:
            self.logger.error(f"❌ limits.json 格式错误: {e}")
            return set()
        except Exception as e:
            self.logger.error(f"❌ 加载 limits.json 失败: {e}")
            return set()
    
    def find_affected_cryptos(self, announcement_text):
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
    
    def init_okx_clients(self):
        """初始化 OKX API 客户端"""
        if not all([self.api_key, self.secret_key, self.passphrase]):
            self.logger.warning("⚠️ OKX API 凭证不完整，余额检查和市价卖出功能将被禁用")
            self.funding_api = None
            self.trade_api = None
            return
        
        if Funding is None or Trade is None:
            self.logger.warning("⚠️ OKX SDK 未安装，余额检查和市价卖出功能将被禁用")
            self.funding_api = None
            self.trade_api = None
            return
        
        try:
            # 获取交易环境设置
            testnet = os.getenv('OKX_TESTNET', 'true')
            okx_flag = "1" if testnet.lower() == "true" else "0"
            
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
            
            self.logger.info(f"✅ OKX API 客户端初始化成功 (环境: {'Demo' if okx_flag == '1' else 'Live'})")
            
        except Exception as e:
            self.logger.error(f"❌ 初始化 OKX API 客户端失败: {e}")
            self.funding_api = None
            self.trade_api = None
    
    def check_affected_balances(self, affected_cryptos):
        """检查受影响加密货币的余额"""
        if not self.funding_api or not affected_cryptos:
            return {}
        
        self.logger.info(f"🔍 检查受影响加密货币的余额: {sorted(affected_cryptos)}")
        
        affected_balances = {}
        
        try:
            # 获取所有余额
            result = self.funding_api.get_balances()
            
            if result.get('code') == '0':
                balances = result.get('data', [])
                
                for balance_info in balances:
                    ccy = balance_info.get('ccy', '')
                    available_bal = float(balance_info.get('availBal', '0'))
                    
                    # 检查是否是受影响的加密货币且有可用余额
                    if ccy in affected_cryptos and available_bal > 0:
                        affected_balances[ccy] = {
                            'availBal': available_bal,
                            'bal': float(balance_info.get('bal', '0')),
                            'frozenBal': float(balance_info.get('frozenBal', '0'))
                        }
                        self.logger.warning(f"🎯 发现受影响的余额: {ccy} = {available_bal}")
                
                if affected_balances:
                    self.logger.warning(f"📊 总共发现 {len(affected_balances)} 个受影响的加密货币有余额")
                else:
                    self.logger.info("✅ 受影响的加密货币均无余额")
                    
            else:
                self.logger.error(f"❌ 获取余额失败: {result}")
                
        except Exception as e:
            self.logger.error(f"❌ 检查余额时发生错误: {e}")
        
        return affected_balances
    
    def execute_market_sell(self, crypto, available_balance):
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
    
    def cleanup_limits_config(self, affected_cryptos):
        """从 limits.json 中移除受影响的加密货币配置"""
        if not affected_cryptos:
            return True
        
        try:
            # 备份原始配置文件
            backup_filename = f"limits_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            import shutil
            shutil.copy('limits.json', backup_filename)
            self.logger.info(f"📋 已备份原始配置到: {backup_filename}")
            
            # 读取当前配置
            with open('limits.json', 'r', encoding='utf-8') as f:
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
                
                with open('limits.json', 'w', encoding='utf-8') as f:
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
    
    def recreate_algo_triggers(self):
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
    
    def check_affected_cryptos(self, announcement):
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
    
    def execute_cancellation_scripts(self):
        """执行取消订单脚本"""
        self.logger.info("🚨 开始执行自动取消订单...")
        print("\n🚨 开始执行自动取消订单...")
        print("="*60)
        
        # 脚本路径
        scripts = [
            ("cancel_pending_triggers.py", "取消所有待处理的触发订单"),
            ("cancel_pending_limits.py", "取消所有待处理的限价订单")
        ]
        
        success_count = 0
        
        for script_name, description in scripts:
            try:
                self.logger.info(f"执行脚本: {script_name} - {description}")
                print(f"\n🔄 执行: {description}")
                print(f"📄 脚本: {script_name}")
                
                # 执行脚本
                result = subprocess.run(
                    [sys.executable, script_name],
                    capture_output=True,
                    text=True,
                    timeout=300  # 5分钟超时
                )
                
                if result.returncode == 0:
                    self.logger.info(f"✅ {script_name} 执行成功")
                    print(f"✅ {script_name} 执行成功")
                    if result.stdout:
                        self.logger.debug(f"脚本输出: {result.stdout}")
                        print(f"📋 输出:\n{result.stdout}")
                    success_count += 1
                else:
                    self.logger.error(f"❌ {script_name} 执行失败 (退出码: {result.returncode})")
                    print(f"❌ {script_name} 执行失败 (退出码: {result.returncode})")
                    if result.stderr:
                        self.logger.error(f"错误信息: {result.stderr}")
                        print(f"🚫 错误信息:\n{result.stderr}")
                    if result.stdout:
                        self.logger.debug(f"脚本输出: {result.stdout}")
                        print(f"📋 输出:\n{result.stdout}")
                        
            except subprocess.TimeoutExpired:
                self.logger.error(f"⏰ {script_name} 执行超时 (超过5分钟)")
                print(f"⏰ {script_name} 执行超时 (超过5分钟)")
            except FileNotFoundError:
                self.logger.error(f"❌ 找不到脚本文件: {script_name}")
                print(f"❌ 找不到脚本文件: {script_name}")
            except Exception as e:
                self.logger.error(f"❌ 执行 {script_name} 时发生错误: {e}")
                print(f"❌ 执行 {script_name} 时发生错误: {e}")
        
        self.logger.info(f"📊 取消订单脚本执行完成: {success_count}/{len(scripts)} 成功")
        print("\n" + "="*60)
        print(f"📊 取消订单脚本执行完成: {success_count}/{len(scripts)} 成功")
        
        if success_count == len(scripts):
            self.logger.info("✅ 所有订单取消脚本已成功执行")
            print("✅ 所有订单取消脚本已成功执行")
        else:
            self.logger.warning("⚠️ 部分订单取消脚本执行失败，请检查日志")
            print("⚠️  部分订单取消脚本执行失败，请检查日志")
        
        return success_count == len(scripts)
    
    def send_alert(self, announcement):
        """发送警报"""
        timestamp = int(announcement['pTime']) / 1000
        date = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        affected_cryptos = announcement.get('affected_cryptos', set())
        
        print("\n" + "="*80)
        print("🚨 警报！发现影响配置加密货币的Delist公告！")
        print("="*80)
        print(f"📅 发布时间: {date}")
        print(f"📢 公告标题: {announcement['title']}")
        print(f"🎯 受影响的加密货币: {sorted(affected_cryptos)}")
        print(f"🔗 详细链接: {announcement['url']}")
        print(f"⏰ 时间戳: {announcement['pTime']}")
        print("="*80)
        
        # 只有在有受影响的加密货币时才执行保护操作
        if affected_cryptos:
            self.logger.warning(f"🚨 检测到影响加密货币的Delist公告: {announcement['title']}")
            self.logger.warning(f"🎯 受影响的加密货币: {sorted(affected_cryptos)}")
            print(f"\n🚨 检测到受影响的加密货币: {sorted(affected_cryptos)}，开始执行保护操作...")
            
            # 步骤1: 取消所有待处理订单
            print("\n📋 步骤1: 取消所有待处理订单")
            cancellation_success = self.execute_cancellation_scripts()
            
            if cancellation_success:
                self.logger.info("✅ 订单取消操作已完成")
                print("✅ 订单取消操作已完成")
            else:
                self.logger.error("⚠️ 订单取消操作可能存在问题，请手动检查")
                print("⚠️  订单取消操作可能存在问题，请手动检查")
            
            # 步骤2: 检查并卖出受影响的余额
            print("\n💰 步骤2: 检查并卖出受影响的余额")
            affected_balances = self.check_affected_balances(affected_cryptos)
            
            if affected_balances:
                print(f"🎯 发现 {len(affected_balances)} 个受影响的加密货币有余额，开始市价卖出...")
                
                sell_results = {}
                for crypto, balance_info in affected_balances.items():
                    available_bal = balance_info['availBal']
                    print(f"🔄 正在卖出 {crypto}: {available_bal}")
                    
                    success = self.execute_market_sell(crypto, available_bal)
                    sell_results[crypto] = success
                    
                    if success:
                        print(f"✅ {crypto} 市价卖出成功")
                    else:
                        print(f"❌ {crypto} 市价卖出失败")
                
                # 汇总卖出结果
                successful_sells = sum(1 for success in sell_results.values() if success)
                total_sells = len(sell_results)
                
                self.logger.info(f"📊 市价卖出完成: {successful_sells}/{total_sells} 成功")
                print(f"\n📊 市价卖出汇总: {successful_sells}/{total_sells} 成功")
                
                if successful_sells == total_sells:
                    print("✅ 所有受影响的加密货币已成功卖出")
                else:
                    print("⚠️  部分加密货币卖出失败，请手动检查")
            else:
                self.logger.info("✅ 受影响的加密货币均无余额，无需卖出")
                print("✅ 受影响的加密货币均无余额，无需卖出")
            
            # 步骤3: 清理配置并重新创建触发订单
            print("\n🧹 步骤3: 清理配置并重新创建触发订单")
            
            # 清理 limits.json 配置
            cleanup_success = self.cleanup_limits_config(affected_cryptos)
            
            if cleanup_success:
                print("✅ limits.json 配置清理完成")
                
                # 重新创建算法触发订单
                recreate_success = self.recreate_algo_triggers()
                
                if recreate_success:
                    self.logger.info("✅ 算法触发订单重新创建成功")
                    print("✅ 算法触发订单重新创建成功")
                else:
                    self.logger.error("❌ 算法触发订单重新创建失败")
                    print("❌ 算法触发订单重新创建失败")
            else:
                self.logger.error("❌ limits.json 配置清理失败")
                print("❌ limits.json 配置清理失败")
            
            print("\n🎉 完整保护流程执行完成")
            
        else:
            self.logger.info("ℹ️ 无受影响的加密货币，跳过保护操作")
            print("\nℹ️ 无受影响的加密货币，跳过保护操作")
        
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
            
            # 检查是否有今天的受影响加密货币相关公告
            today_affected_announcements = []
            
            for ann in announcements:
                if self.is_today_announcement(ann):
                    # 检查是否影响配置的加密货币
                    is_affected, affected_cryptos = self.check_affected_cryptos(ann)
                    
                    if is_affected:
                        # 生成唯一ID（使用标题和时间戳）
                        announcement_id = f"{ann['title']}_{ann['pTime']}"
                        
                        # 检查是否是新公告
                        if announcement_id not in self.known_announcements:
                            ann['affected_cryptos'] = affected_cryptos  # 保存受影响的加密货币
                            today_affected_announcements.append(ann)
                            self.known_announcements.add(announcement_id)
            
            if today_affected_announcements:
                print(f"🎯 发现 {len(today_affected_announcements)} 条影响配置加密货币的新公告！")
                for ann in today_affected_announcements:
                    self.send_alert(ann)
            else:
                print("✅ 没有发现影响配置加密货币的新公告")
                
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
