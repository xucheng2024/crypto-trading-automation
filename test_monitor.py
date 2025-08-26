#!/usr/bin/env python3
"""
测试OKX Delist Spot监控功能
"""

from monitor_delist import OKXDelistMonitor

def test_monitor():
    """测试监控功能"""
    print("🧪 测试OKX Delist Spot监控功能")
    print("=" * 50)
    
    # 创建监控实例
    monitor = OKXDelistMonitor()
    
    # 测试配置检查
    print("🔑 配置检查:")
    print(f"  API密钥: {'✅' if monitor.api_key else '❌'}")
    print(f"  密钥: {'✅' if monitor.secret_key else '❌'}")
    print(f"  密码: {'✅' if monitor.passphrase else '❌'}")
    
    if not all([monitor.api_key, monitor.secret_key, monitor.passphrase]):
        print("\n❌ 配置不完整，无法进行API测试")
        return
    
    print("\n🔍 测试API连接...")
    
    # 测试获取公告
    try:
        announcements = monitor.fetch_delist_announcements(page=1)
        if announcements:
            print(f"✅ 成功获取 {len(announcements)} 条公告")
            
            # 显示前3条公告
            print("\n📋 最新公告预览:")
            for i, ann in enumerate(announcements[:3]):
                print(f"  {i+1}. {ann['title']}")
                
            # 检查是否有今天的spot公告
            today_spot_count = 0
            for ann in announcements:
                if monitor.is_today_announcement(ann) and monitor.is_spot_related(ann):
                    today_spot_count += 1
            
            print(f"\n📅 今日spot delist公告数量: {today_spot_count}")
            
        else:
            print("❌ 无法获取公告数据")
            
    except Exception as e:
        print(f"❌ API测试失败: {e}")
    
    print("\n✅ 测试完成")

if __name__ == "__main__":
    test_monitor()
