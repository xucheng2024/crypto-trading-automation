#!/usr/bin/env python3
"""
Test OKX signature generation and private endpoint
"""
import hmac
import hashlib
import base64
import time
import requests
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv('../.env.local')

def generate_okx_signature(timestamp, method, request_path, body, secret_key):
    """Generate OKX signature according to official documentation"""
    pre_hash_string = timestamp + method + request_path + body
    print(f"Pre-hash string: {pre_hash_string}")
    
    signature = hmac.new(
        secret_key.encode('utf-8'),
        pre_hash_string.encode('utf-8'),
        hashlib.sha256
    ).digest()
    
    signature_b64 = base64.b64encode(signature).decode('utf-8')
    return signature_b64

def test_okx_announcements():
    """Test OKX announcements private endpoint"""
    
    # Get API credentials
    api_key = os.environ.get('OKX_API_KEY', '')
    secret_key = os.environ.get('OKX_SECRET_KEY', '')
    passphrase = os.environ.get('OKX_PASSPHRASE', '')
    
    if not all([api_key, secret_key, passphrase]):
        print("❌ Missing API credentials")
        return
    
    print(f"✅ API Key: {api_key[:10]}...")
    print(f"✅ Secret Key: {secret_key[:10]}...")
    print(f"✅ Passphrase: {passphrase[:10]}...")
    
    # Prepare request
    method = 'GET'
    request_path = '/api/v5/support/announcements'
    body = ''
    timestamp = time.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    
    print(f"\n📝 Request Details:")
    print(f"   Method: {method}")
    print(f"   Path: {request_path}")
    print(f"   Timestamp: {timestamp}")
    
    # Generate signature
    signature = generate_okx_signature(timestamp, method, request_path, body, secret_key)
    print(f"   Signature: {signature[:20]}...")
    
    # Build headers
    headers = {
        'OK-ACCESS-KEY': api_key,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': passphrase,
        'x-simulated-trading': '1'
    }
    
    print(f"\n🔐 Headers:")
    for key, value in headers.items():
        if key == 'OK-ACCESS-SIGN':
            print(f"   {key}: {value[:20]}...")
        else:
            print(f"   {key}: {value}")
    
    # Make request
    url = "https://www.okx.com/api/v5/support/announcements"
    print(f"\n🌐 Making request to: {url}")
    
    try:
        response = requests.get(url, headers=headers)
        print(f"📡 Response Status: {response.status_code}")
        print(f"📡 Response Headers: {dict(response.headers)}")
        print(f"📡 Response Body: {response.text[:500]}")
        
        if response.status_code == 200:
            data = response.json()
            if data.get('code') == '0':
                print("✅ SUCCESS! Private endpoint working!")
                print(f"   Total pages: {data['data'][0]['totalPage']}")
                print(f"   First announcement: {data['data'][0]['details'][0]['title']}")
            else:
                print(f"❌ OKX API error: {data}")
        else:
            print(f"❌ Request failed: {response.status_code}")
            
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    print("🚀 Testing OKX Private Endpoint Authentication")
    print("=" * 50)
    test_okx_announcements()
