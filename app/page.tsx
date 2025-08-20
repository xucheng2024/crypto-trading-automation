'use client';

import React, { useState } from 'react';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  const [balance, setBalance] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [positions, setPositions] = useState<any>(null);
  const [ticker, setTicker] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callFlaskApi = async (endpoint: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/okx/${endpoint}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Something went wrong');
      }
      return data;
    } catch (err: any) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleGetBalance = async () => {
    const result = await callFlaskApi('balance');
    if (result?.success) {
      setBalance(result.data);
    }
  };

  const handleGetConfig = async () => {
    const result = await callFlaskApi('config');
    if (result?.success) {
      setConfig(result.data);
    }
  };

  const handleGetPositions = async () => {
    const result = await callFlaskApi('positions');
    if (result?.success) {
      setPositions(result.data);
    }
  };

  const handleGetTicker = async () => {
    const result = await callFlaskApi('ticker?instId=BTC-USDT');
    if (result?.success) {
      setTicker(result.data);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 原有的Dashboard组件 */}
      <Dashboard />
      
      {/* OKX Flask API测试区域 */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-2xl font-bold mb-6 text-gray-800">🚀 OKX Trading via Flask API</h2>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <button 
              onClick={handleGetBalance} 
              disabled={loading}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '⏳' : '💰 Balance'}
            </button>
            
            <button 
              onClick={handleGetConfig} 
              disabled={loading}
              className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '⏳' : '⚙️ Config'}
            </button>
            
            <button 
              onClick={handleGetPositions} 
              disabled={loading}
              className="px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '⏳' : '📊 Positions'}
            </button>
            
            <button 
              onClick={handleGetTicker} 
              disabled={loading}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '⏳' : '📈 Ticker'}
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-300 rounded-lg">
              <p className="text-red-700">❌ Error: {error}</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {balance && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <h3 className="font-semibold text-lg mb-2 text-gray-700">💰 Account Balance</h3>
                <pre className="text-sm overflow-auto bg-white p-3 rounded border">{JSON.stringify(balance, null, 2)}</pre>
              </div>
            )}

            {config && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <h3 className="font-semibold text-lg mb-2 text-gray-700">⚙️ Account Config</h3>
                <pre className="text-sm overflow-auto bg-white p-3 rounded border">{JSON.stringify(config, null, 2)}</pre>
              </div>
            )}

            {positions && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <h3 className="font-semibold text-lg mb-2 text-gray-700">📊 Positions</h3>
                <pre className="text-sm overflow-auto bg-white p-3 rounded border">{JSON.stringify(positions, null, 2)}</pre>
              </div>
            )}

            {ticker && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <h3 className="font-semibold text-lg mb-2 text-gray-700">📈 BTC-USDT Ticker</h3>
                <pre className="text-sm overflow-auto bg-white p-3 rounded border">{JSON.stringify(ticker, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
