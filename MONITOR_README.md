# OKX Delist Spot 监控脚本

## 🎯 功能说明

这个监控脚本会**每5分钟**自动检查OKX是否有**今天的delist spot公告**，如果发现新公告就会立即发出警报。

## 🚀 快速启动

### 方法1: 使用启动脚本（推荐）
```bash
./start_monitor.sh
```

### 方法2: 直接运行Python脚本
```bash
python3 monitor_delist.py
```

## ⚙️ 配置要求

### 1. 环境变量配置
确保你的 `.env.local` 文件包含以下OKX API密钥：
```env
OKX_API_KEY=your_api_key_here
OKX_SECRET_KEY=your_secret_key_here
OKX_PASSPHRASE=your_passphrase_here
```

### 2. Python依赖
```bash
pip install requests python-dotenv
```

## 🔍 监控特性

- **⏰ 检查频率**: 每5分钟检查一次
- **🎯 监控内容**: 只关注delist spot相关公告
- **📅 时间范围**: 只检查今天的公告
- **🚨 警报方式**: 
  - 控制台显示详细信息
  - 播放系统提示音（macOS）
  - 可扩展其他警报方式

## 📱 警报示例

当发现新公告时，会显示如下警报：

```
================================================================================
🚨 警报！发现今天的Delist Spot公告！
================================================================================
📅 发布时间: 2025-06-30 16:00:00
📢 公告标题: OKX to delist X, BSV, GOG, DIA, BONE and OXT spot trading pairs
🔗 详细链接: https://www.okx.com/help/okx-to-delist-x-bsv-gog-dia-bone-and-oxt-spot-trading-pairs
⏰ 时间戳: 1751270400000
================================================================================
🔊 已播放系统提示音
```

## 🛠️ 自定义配置

### 修改检查间隔
在 `monitor_delist.py` 中修改：
```python
self.check_interval = 300  # 5分钟 = 300秒
```

### 添加更多警报方式
在 `send_alert` 方法中添加：
```python
# 发送邮件
# 发送钉钉/企业微信消息
# 发送推送通知
# 等等...
```

## 🚫 停止监控

按 `Ctrl+C` 即可停止监控服务。

## 📊 运行状态

监控运行时会显示：
```
🚀 OKX Delist Spot 监控启动
⏰ 检查间隔: 300秒 (5.0分钟)
🔑 API密钥: ✅ 已配置
🔑 密钥: ✅ 已配置
🔑 密码: ✅ 已配置

开始监控... (按 Ctrl+C 停止)

🔍 [2025-08-26 20:30:00] 开始检查delist公告...
✅ 没有发现新的今日spot delist公告
⏳ 等待 300 秒后再次检查...
```

## 🔧 故障排除

### 常见问题

1. **API认证失败**
   - 检查 `.env.local` 文件中的API密钥是否正确
   - 确认API密钥有足够的权限

2. **网络连接问题**
   - 检查网络连接
   - 确认可以访问OKX API

3. **Python依赖缺失**
   - 运行 `pip install requests python-dotenv`

4. **权限问题**
   - 确保脚本有执行权限：`chmod +x start_monitor.sh`

## 💡 使用建议

- **长期运行**: 建议在服务器或云主机上运行，确保24小时监控
- **日志记录**: 可以配合 `nohup` 或 `screen` 在后台运行
- **多实例**: 可以运行多个监控实例，提高可靠性

## 📝 更新日志

- **v1.0**: 基础监控功能，支持5分钟间隔检查
- **v1.1**: 添加系统提示音警报
- **v1.2**: 优化错误处理和日志输出
