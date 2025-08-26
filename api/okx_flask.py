from flask import Flask, request, jsonify
from okx.api import Account, Trade, Market
import os
from dotenv import load_dotenv
import json
import datetime
import requests

# 加载环境变量
load_dotenv('../.env.local')

app = Flask(__name__)

# 初始化OKX客户端
def get_okx_trade():
    return Trade(
        key=os.environ.get('DEMO_OKX_API_KEY', ''),
        secret=os.environ.get('DEMO_OKX_SECRET_KEY', ''),
        passphrase=os.environ.get('DEMO_OKX_PASSPHRASE', ''),
        flag="1"  # demo trading
    )

def get_okx_account():
    return Account(
        key=os.environ.get('DEMO_OKX_API_KEY', ''),
        secret=os.environ.get('DEMO_OKX_SECRET_KEY', ''),
        passphrase=os.environ.get('DEMO_OKX_PASSPHRASE', ''),
        flag="1"  # demo trading
    )

@app.route('/api/okx/place-order', methods=['POST'])
def place_order():
    """下单"""
    try:
        data = request.get_json()
        
        # 验证必要参数
        required_fields = ['instId', 'tdMode', 'side', 'ordType', 'sz']
        for field in required_fields:
            if field not in data:
                return jsonify({
                    'success': False,
                    'error': f'Missing required field: {field}'
                }), 400
        
        trade = get_okx_trade()
        
        # 这里需要根据OKX Python SDK的具体方法来实现
        # 暂时返回占位符
        return jsonify({
            'success': False,
            'error': 'Method not implemented yet - need to find correct OKX SDK method',
            'received_data': data
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/okx/cancel-order', methods=['POST'])
def cancel_order():
    """取消订单"""
    try:
        data = request.get_json()
        
        # 验证必要参数
        if 'ordId' not in data or 'instId' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required fields: ordId, instId'
            }), 400
        
        trade = get_okx_trade()
        
        # 这里需要根据OKX Python SDK的具体方法来实现
        # 暂时返回占位符
        return jsonify({
            'success': False,
            'error': 'Method not implemented yet - need to find correct OKX SDK method',
            'received_data': data
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/okx/sell', methods=['POST'])
def sell():
    """卖出"""
    try:
        data = request.get_json()
        
        # 验证必要参数
        required_fields = ['instId', 'tdMode', 'sz']
        for field in required_fields:
            if field not in data:
                return jsonify({
                    'success': False,
                    'error': f'Missing required field: {field}'
                }), 400
        
        trade = get_okx_trade()
        
        # 这里需要根据OKX Python SDK的具体方法来实现
        # 暂时返回占位符
        return jsonify({
            'success': False,
            'error': 'Method not implemented yet - need to find correct OKX SDK method',
            'received_data': data
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/okx/health', methods=['GET'])
def health_check():
    """健康检查"""
    return jsonify({
        'success': True,
        'message': 'OKX Trading API is running',
        'endpoints': [
            '/api/okx/place-order - 下单',
            '/api/okx/cancel-order - 取消订单', 
            '/api/okx/sell - 卖出',
            '/api/okx/announcements - 获取公告'
        ]
    })

@app.route('/api/okx/announcements', methods=['GET'])
def get_announcements():
    """Get OKX announcements using OKX SDK built-in signature methods"""
    try:
        ann_type = request.args.get('annType', '')
        page = request.args.get('page', '1')
        
        # Prepare parameters
        api_params = {}
        if ann_type: api_params['annType'] = ann_type
        if page: api_params['page'] = page
        
        # Build request path with query parameters (GET params are part of requestPath, not body)
        request_path = '/api/v5/support/announcements'
        if api_params:
            query_string = '&'.join([f"{k}={v}" for k, v in api_params.items()])
            request_path = f"{request_path}?{query_string}"
        
        # Get API credentials
        api_key = os.environ.get('OKX_API_KEY', '')
        secret_key = os.environ.get('OKX_SECRET_KEY', '')
        passphrase = os.environ.get('OKX_PASSPHRASE', '')
        
        if not all([api_key, secret_key, passphrase]):
            return jsonify({'success': False, 'error': 'Missing API credentials'}), 500
        
        # Initialize OKX Market client (we only need it for signature methods)
        market = Market(
            key=api_key,
            secret=secret_key,
            passphrase=passphrase,
            flag="0"  # Use live trading flag (not demo)
        )
        
        # Generate timestamp in ISO 8601 format (UTC) - same as OKX SDK
        timestamp = datetime.datetime.utcnow().isoformat("T", "milliseconds") + 'Z'
        
        # Use OKX SDK built-in methods to generate signature
        pre_hash_string = market._pre_hash(timestamp, 'GET', request_path, '')
        signature = market._get_sign(pre_hash_string, secret_key)
        signature_str = signature.decode('utf-8')  # _get_sign returns bytes
        
        print(f"Pre-hash string: {pre_hash_string}")
        print(f"Signature: {signature_str[:20]}...")
        
        # Use OKX SDK built-in method to generate headers
        headers = market._get_header(api_key, signature_str, passphrase, "0", timestamp)
        
        print(f"Headers: {dict(headers)}")
        
        # Make request to OKX API
        url = "https://www.okx.com/api/v5/support/announcements"
        response = requests.get(url, params=api_params, headers=headers)
        
        print(f"Response status: {response.status_code}")
        print(f"Response body: {response.text[:500]}")
        
        if response.status_code == 200:
            data = response.json()
            if data.get('code') == '0':
                return jsonify({
                    'success': True, 
                    'message': 'Using OKX SDK built-in signature methods',
                    'data': data
                })
            else:
                return jsonify({'success': False, 'error': f'OKX API error: {data}'}), 400
        else:
            return jsonify({'success': False, 'error': f'Request failed: {response.status_code} - {response.text}'}), 400
            
    except Exception as e:
        print(f"Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
