"""
去重/幂等机制工具模块
防止定时任务重试导致的重复执行
"""
import json
import time
import hashlib
from datetime import datetime, timedelta
from typing import Dict, Set, Optional
import logging

logger = logging.getLogger(__name__)

class DeduplicationManager:
    """去重管理器"""
    
    def __init__(self, ttl_hours: int = 48):
        """
        初始化去重管理器
        
        Args:
            ttl_hours (int): 去重记录存活时间（小时）
        """
        self.ttl_hours = ttl_hours
        self.processed_actions: Dict[str, float] = {}  # action_id -> timestamp
        self.cleanup_threshold = 1000  # 清理阈值
        
    def _generate_action_id(self, action_type: str, **kwargs) -> str:
        """
        生成动作ID
        
        Args:
            action_type (str): 动作类型
            **kwargs: 动作参数
            
        Returns:
            str: 动作ID
        """
        # 创建包含所有参数的字符串
        params_str = f"{action_type}:{json.dumps(kwargs, sort_keys=True)}"
        # 生成MD5哈希
        return hashlib.md5(params_str.encode()).hexdigest()
    
    def _cleanup_expired(self):
        """清理过期的记录"""
        if len(self.processed_actions) < self.cleanup_threshold:
            return
            
        current_time = time.time()
        expired_keys = [
            key for key, timestamp in self.processed_actions.items()
            if current_time - timestamp > self.ttl_hours * 3600
        ]
        
        for key in expired_keys:
            del self.processed_actions[key]
            
        logger.info(f"Cleaned up {len(expired_keys)} expired deduplication records")
    
    def is_processed(self, action_type: str, **kwargs) -> bool:
        """
        检查动作是否已处理
        
        Args:
            action_type (str): 动作类型
            **kwargs: 动作参数
            
        Returns:
            bool: 是否已处理
        """
        action_id = self._generate_action_id(action_type, **kwargs)
        current_time = time.time()
        
        # 检查是否存在且未过期
        if action_id in self.processed_actions:
            timestamp = self.processed_actions[action_id]
            if current_time - timestamp <= self.ttl_hours * 3600:
                logger.info(f"Action already processed: {action_type} - {action_id}")
                return True
            else:
                # 过期了，删除记录
                del self.processed_actions[action_id]
        
        return False
    
    def mark_processed(self, action_type: str, **kwargs) -> str:
        """
        标记动作为已处理
        
        Args:
            action_type (str): 动作类型
            **kwargs: 动作参数
            
        Returns:
            str: 动作ID
        """
        action_id = self._generate_action_id(action_type, **kwargs)
        self.processed_actions[action_id] = time.time()
        
        # 定期清理
        self._cleanup_expired()
        
        logger.info(f"Marked action as processed: {action_type} - {action_id}")
        return action_id
    
    def get_run_key(self, cron_expression: str, timestamp: Optional[str] = None) -> str:
        """
        生成运行键，用于Cloudflare Worker去重
        
        Args:
            cron_expression (str): cron表达式
            timestamp (str, optional): 时间戳，如果为None则使用当前时间
            
        Returns:
            str: 运行键
        """
        if timestamp is None:
            timestamp = datetime.utcnow().strftime("%Y%m%d%H%M")
        
        return f"run:{cron_expression}:{timestamp}"

# 全局去重管理器实例
_dedup_manager = None

def get_dedup_manager() -> DeduplicationManager:
    """获取全局去重管理器实例"""
    global _dedup_manager
    if _dedup_manager is None:
        _dedup_manager = DeduplicationManager()
    return _dedup_manager

def is_action_processed(action_type: str, **kwargs) -> bool:
    """检查动作是否已处理的便捷函数"""
    return get_dedup_manager().is_processed(action_type, **kwargs)

def mark_action_processed(action_type: str, **kwargs) -> str:
    """标记动作为已处理的便捷函数"""
    return get_dedup_manager().mark_processed(action_type, **kwargs)
