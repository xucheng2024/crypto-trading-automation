"""
HTTP健壮性工具模块
提供带重试和超时的HTTP会话，解决网络毛刺导致的偶发失败
"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import logging

logger = logging.getLogger(__name__)

def make_session():
    """
    创建带重试和超时的HTTP会话
    
    Returns:
        requests.Session: 配置好的会话对象
    """
    session = requests.Session()
    
    # 配置重试策略
    retry_strategy = Retry(
        total=3,                    # 总重试次数
        read=3,                     # 读取重试次数
        connect=3,                  # 连接重试次数
        backoff_factor=0.6,         # 重试间隔倍数
        status_forcelist=(429, 500, 502, 503, 504),  # 强制重试的HTTP状态码
        allowed_methods=("GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"),  # 允许重试的方法
        raise_on_status=False       # 不立即抛出状态异常，让重试机制处理
    )
    
    # 为HTTPS和HTTP都配置适配器
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    
    # 设置默认超时
    session.timeout = 10
    
    logger.info("Created robust HTTP session with retry strategy")
    return session

def safe_request(method, url, session=None, timeout=10, **kwargs):
    """
    安全的HTTP请求，带重试和超时处理
    
    Args:
        method (str): HTTP方法
        url (str): 请求URL
        session (requests.Session, optional): 会话对象，如果为None则创建新的
        timeout (int): 超时时间（秒）
        **kwargs: 其他requests参数
        
    Returns:
        requests.Response: 响应对象
        
    Raises:
        requests.RequestException: 请求异常
    """
    if session is None:
        session = make_session()
    
    try:
        logger.info(f"Making {method} request to {url}")
        response = session.request(method, url, timeout=timeout, **kwargs)
        response.raise_for_status()
        logger.info(f"Request successful: {response.status_code}")
        return response
    except requests.RequestException as e:
        logger.error(f"Request failed: {method} {url} - {str(e)}")
        raise

# 全局会话实例，避免重复创建
_global_session = None

def get_global_session():
    """获取全局会话实例"""
    global _global_session
    if _global_session is None:
        _global_session = make_session()
    return _global_session
