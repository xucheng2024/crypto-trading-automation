'use client';

import { useState, useEffect } from 'react';
import PortfolioOverview from './PortfolioOverview';
import TradingInterface from './TradingInterface';
import TradeHistory from './TradeHistory';
import { PortfolioData, Trade } from '@/types/trading';

export default function Dashboard() {
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [portfolioRes, tradesRes] = await Promise.all([
        fetch('/api/portfolio'),
        fetch('/api/trading'),
      ]);

      const portfolioData = await portfolioRes.json();
      const tradesData = await tradesRes.json();

      setPortfolio(portfolioData);
      setTrades(tradesData.trades || []);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <h1 className="text-2xl font-bold text-gray-900">
            Crypto Trading Dashboard
          </h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Portfolio Overview */}
          <div className="lg:col-span-1">
            <PortfolioOverview portfolio={portfolio} onUpdate={fetchData} />
          </div>

          {/* Trading Interface */}
          <div className="lg:col-span-2">
            <TradingInterface onTrade={fetchData} />
          </div>
        </div>

        {/* Trade History */}
        <div className="mt-8">
          <TradeHistory trades={trades} />
        </div>
      </main>
    </div>
  );
}
