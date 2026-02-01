"""
统一时间工具模块
所有时间处理统一使用UTC，避免时区问题
"""

from datetime import datetime, timezone, timedelta
from typing import Optional


def get_utc_now() -> datetime:
    """获取当前UTC时间"""
    return datetime.now(timezone.utc)


def get_utc_now_naive() -> datetime:
    """获取当前UTC时间（naive datetime，用于兼容旧代码）"""
    return datetime.utcnow()


def timestamp_to_utc_datetime(timestamp_ms: int) -> datetime:
    """将毫秒时间戳转换为UTC datetime"""
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)


def timestamp_to_utc_datetime_naive(timestamp_ms: int) -> datetime:
    """将毫秒时间戳转换为UTC datetime（naive，用于兼容旧代码）"""
    return datetime.utcfromtimestamp(timestamp_ms / 1000)


def timestamp_to_datetime(timestamp_ms: int) -> datetime:
    """将毫秒时间戳转换为UTC datetime（别名，推荐使用）"""
    return timestamp_to_utc_datetime(timestamp_ms)


def datetime_to_timestamp_ms(dt: datetime) -> int:
    """将datetime转换为毫秒时间戳"""
    if dt.tzinfo is None:
        # Naive datetime，假设是UTC
        return int(dt.timestamp() * 1000)
    # Aware datetime
    return int(dt.timestamp() * 1000)


def get_today_start_utc() -> datetime:
    """获取今天00:00:00 UTC时间（naive datetime）"""
    now_utc = datetime.utcnow()
    return datetime(now_utc.year, now_utc.month, now_utc.day, 0, 0, 0)


def get_today_start_utc_timestamp_ms() -> int:
    """获取今天00:00:00 UTC的毫秒时间戳"""
    today_start = get_today_start_utc()
    return datetime_to_timestamp_ms(today_start)


def get_today_start_sgt_timestamp_ms() -> int:
    """获取今天00:00:00 新加坡时间(SGT) 对应的 UTC 毫秒时间戳。用于「当日」按新加坡日判断。"""
    sgt = timezone(timedelta(hours=8))
    now_sgt = datetime.now(timezone.utc).astimezone(sgt)
    today_sgt = now_sgt.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(today_sgt.timestamp() * 1000)


def format_datetime_utc(dt: Optional[datetime], format_str: str = '%Y-%m-%d %H:%M:%S UTC') -> str:
    """格式化datetime为UTC时间字符串"""
    if dt is None:
        return 'N/A'
    if dt.tzinfo is None:
        # Naive datetime，假设是UTC
        return dt.strftime(format_str)
    # Aware datetime，转换为UTC
    return dt.astimezone(timezone.utc).strftime(format_str)


def get_singapore_time(utc_dt: Optional[datetime] = None) -> datetime:
    """获取新加坡时间（UTC+8）"""
    if utc_dt is None:
        utc_dt = get_utc_now()
    elif utc_dt.tzinfo is None:
        # Naive datetime，假设是UTC，转换为aware
        utc_dt = utc_dt.replace(tzinfo=timezone.utc)
    
    sgt_tz = timezone(timedelta(hours=8))
    return utc_dt.astimezone(sgt_tz)


def format_datetime_sgt(dt: Optional[datetime], format_str: str = '%Y-%m-%d %H:%M:%S SGT') -> str:
    """格式化datetime为新加坡时间字符串"""
    if dt is None:
        return 'N/A'
    sgt_dt = get_singapore_time(dt)
    return sgt_dt.strftime(format_str)


def get_log_filename(prefix: str, extension: str = '.log') -> str:
    """生成日志文件名（使用UTC日期，格式：prefix_YYYYMMDD.extension）"""
    now_utc = datetime.utcnow()
    return f"{prefix}_{now_utc.strftime('%Y%m%d')}{extension}"


def is_within_hours(announcement_time: datetime, hours: int = 24, reference_time: Optional[datetime] = None) -> bool:
    """检查时间是否在指定小时内（UTC时间）
    
    Args:
        announcement_time: 公告时间
        hours: 小时数（默认24小时）
        reference_time: 参考时间（默认当前UTC时间）
    
    Returns:
        bool: 是否在指定小时内
    """
    if reference_time is None:
        reference_time = get_utc_now_naive()
    
    # 如果都是naive datetime，直接比较
    if announcement_time.tzinfo is None and reference_time.tzinfo is None:
        time_diff = reference_time - announcement_time
        return time_diff <= timedelta(hours=hours)
    
    # 如果有timezone信息，统一转换为UTC naive进行比较
    if announcement_time.tzinfo is not None:
        announcement_time = announcement_time.astimezone(timezone.utc).replace(tzinfo=None)
    if reference_time.tzinfo is not None:
        reference_time = reference_time.astimezone(timezone.utc).replace(tzinfo=None)
    
    time_diff = reference_time - announcement_time
    return time_diff <= timedelta(hours=hours)

