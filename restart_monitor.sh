#!/bin/bash

# OKX Delist Spot 监控重启脚本
# 用于crontab定时重启监控服务

# 设置工作目录
cd "$(dirname "$0")"

# 加载conda环境
source ~/miniconda3/etc/profile.d/conda.sh
conda activate base

# 日志文件
LOG_FILE="monitor_restart.log"

# 记录重启时间
echo "$(date '+%Y-%m-%d %H:%M:%S') - 开始重启监控服务..." >> "$LOG_FILE"

# 1. 停止现有的监控进程
echo "$(date '+%Y-%m-%d %H:%M:%S') - 停止现有监控进程..." >> "$LOG_FILE"

# 查找并杀死监控进程
PIDS=$(ps aux | grep "monitor_delist.py" | grep -v grep | awk '{print $2}')

if [ -n "$PIDS" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - 找到监控进程: $PIDS" >> "$LOG_FILE"
    
    for PID in $PIDS; do
        echo "$(date '+%Y-%m-%d %H:%M:%S') - 杀死进程 $PID" >> "$LOG_FILE"
        kill -9 "$PID" 2>/dev/null
    done
    
    # 等待进程完全停止
    sleep 3
    
    # 再次检查是否还有进程
    REMAINING_PIDS=$(ps aux | grep "monitor_delist.py" | grep -v grep | awk '{print $2}')
    if [ -n "$REMAINING_PIDS" ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - 警告: 仍有进程未停止: $REMAINING_PIDS" >> "$LOG_FILE"
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') - 所有监控进程已停止" >> "$LOG_FILE"
    fi
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - 未找到运行中的监控进程" >> "$LOG_FILE"
fi
start
# 2. 启动新的监控服务
echo "$(date '+%Y-%m-%d %H:%M:%S') - 启动新的监控服务..." >> "$LOG_FILE"

# 启动监控服务（后台运行）
nohup /Users/mac/miniconda3/bin/python monitor_delist.py > "monitor_$(date +%Y%m%d).log" 2>&1 &

# 获取新进程ID
NEW_PID=$!
echo "$(date '+%Y-%m-%d %H:%M:%S') - 监控服务已启动，进程ID: $NEW_PID" >> "$LOG_FILE"

# 等待几秒检查服务是否正常启动
sleep 5

# 检查进程是否还在运行
if ps -p $NEW_PID > /dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - 监控服务启动成功，进程ID: $NEW_PID" >> "$LOG_FILE"
    echo "$(date '+%Y-%m-%d %H:%M:%S') - 重启完成" >> "$LOG_FILE"
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - 错误: 监控服务启动失败" >> "$LOG_FILE"
    exit 1
fi
