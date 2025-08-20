'use client';

import { PortfolioData } from '@/types/trading';
import { DollarSign } from 'lucide-react';

interface PortfolioOverviewProps {
  portfolio: PortfolioData | null;
}

export default function PortfolioOverview({
  portfolio,
}: PortfolioOverviewProps) {
  if (!portfolio) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Portfolio Overview
        </h2>
        <div className="text-gray-500">No portfolio data available</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Total Value Card */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-600">Total Portfolio Value</p>
            <p className="text-2xl font-bold text-gray-900">
              ${portfolio.total_value.toFixed(2)}
            </p>
          </div>
          <DollarSign className="h-8 w-8 text-primary" />
        </div>
      </div>

      {/* Holdings List */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Holdings</h3>
        {portfolio.holdings.length === 0 ? (
          <p className="text-gray-500 text-sm">No holdings yet</p>
        ) : (
          <div className="space-y-3">
            {portfolio.holdings.map((holding) => (
              <div
                key={holding.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div>
                  <p className="font-medium text-gray-900">{holding.symbol}</p>
                  <p className="text-sm text-gray-600">
                    {holding.amount.toFixed(4)} @ ${holding.avg_price.toFixed(2)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-gray-900">
                    ${holding.current_value?.toFixed(2)}
                  </p>
                  <p className="text-sm text-gray-600">
                    {holding.amount.toFixed(4)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
