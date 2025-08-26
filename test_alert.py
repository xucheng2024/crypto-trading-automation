#!/usr/bin/env python3
"""
测试急促警报效果 - 模拟发现新的delist spot公告时的急促警报
"""

import os
import time

def continuous_alert():
    """持续警报效果 - 更急促"""
    print("🔊 持续警报中... 按 Ctrl+C 停止警报")
    
    alert_count = 0
    try:
        while True:
            # 播放系统提示音（macOS）
            os.system('afplay /System/Library/Sounds/Glass.aiff')
            alert_count += 1
            
            # 每3次提示音后显示计数（更频繁的反馈）
            if alert_count % 3 == 0:
                print(f"🔊 已播放 {alert_count} 次警报音... 按 Ctrl+C 停止")
            
            # 等待0.8秒后继续（更急促的间隔）
            time.sleep(0.8)
            
    except KeyboardInterrupt:
        print(f"\n🛑 警报已停止，总共播放了 {alert_count} 次")
        return alert_count

def test_continuous_alert():
    """测试急促警报效果"""
    print("🧪 测试急促警报效果")
    print("=" * 60)
    print("这个脚本将模拟监控脚本发现新公告时的急促警报效果")
    print("警报会更急促，每0.8秒响一次，直到你按 Ctrl+C 停止")
    print("=" * 60)
    
    input("按回车键开始急促警报测试...")
    
    # 模拟警报触发
    print("\n" + "="*80)
    print("🚨 警报！发现今天的Delist Spot公告！")
    print("="*80)
    print("📅 发布时间: 2025-08-26 21:00:00")
    print("📢 公告标题: OKX to delist TEST, DEMO, SAMPLE spot trading pairs")
    print("🔗 详细链接: https://www.okx.com/help/test-delist-announcement")
    print("⏰ 时间戳: 1753632000000")
    print("="*80)
    
    print("\n🔊 即将开始急促警报...")
    time.sleep(2)
    
    # 开始急促警报
    total_alerts = continuous_alert()
    
    print(f"\n🎯 急促警报测试完成！")
    print(f"📊 总共播放了 {total_alerts} 次警报音")
    print("💡 在实际监控中，当发现新公告时会急促警报直到你处理")

if __name__ == "__main__":
    test_continuous_alert()
