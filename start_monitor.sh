#!/bin/bash

# OKX Delist Spot 监控启动脚本

echo "🚀 启动 OKX Delist Spot 监控服务..."
echo "⏰ 监控间隔: 5分钟"
echo "🔍 监控内容: 今日delist spot公告"
echo ""

# 检查Python环境
if ! command -v python3 &> /dev/null; then
    echo "❌ 错误: 未找到Python3，请先安装Python3"
    exit 1
fi

# 检查依赖
echo "📦 检查Python依赖..."
python3 -c "import requests, hmac, hashlib, base64" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "❌ 错误: 缺少必要的Python依赖，请先运行: pip install requests"
    exit 1
fi

# 检查环境变量文件
if [ ! -f ".env.local" ]; then
    echo "❌ 错误: 未找到.env.local文件，请先配置OKX API密钥"
    exit 1
fi

echo "✅ 环境检查通过"
echo ""

# 启动监控
echo "🔍 开始监控..."
echo "💡 提示: 按 Ctrl+C 可以停止监控"
echo ""

python3 monitor_delist.py
