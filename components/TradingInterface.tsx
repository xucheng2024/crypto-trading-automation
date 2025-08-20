'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { OrderFormData } from '@/types/trading';
import { TrendingUp, TrendingDown } from 'lucide-react';

const orderSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required'),
  amount: z.number().positive('Amount must be positive'),
  price: z.number().positive('Price must be positive'),
});

interface TradingInterfaceProps {
  onTrade: () => void;
}

export default function TradingInterface({ onTrade }: TradingInterfaceProps) {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'buy' | 'sell'>('buy');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<OrderFormData>({
    resolver: zodResolver(orderSchema),
  });

  const onSubmit = async (data: OrderFormData) => {
    setLoading(true);
    try {
      const response = await fetch('/api/trading', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: activeTab === 'buy' ? 'place_order' : 'sell',
          ...data,
          side: activeTab,
        }),
      });

      const result = await response.json();

      if (result.success) {
        toast.success(
          `${activeTab === 'buy' ? 'Order placed' : 'Sold'} ${data.amount} ${data.symbol}`
        );
        reset();
        onTrade();
      } else {
        toast.error(result.error || 'Operation failed');
      }
    } catch (error) {
      console.error('Trading error:', error);
      toast.error('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="flex space-x-1 mb-6">
        <button
          onClick={() => setActiveTab('buy')}
          className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
            activeTab === 'buy'
              ? 'bg-secondary text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <TrendingUp className="inline w-4 h-4 mr-2" />
          Buy
        </button>
        <button
          onClick={() => setActiveTab('sell')}
          className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
            activeTab === 'sell'
              ? 'bg-danger text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <TrendingDown className="inline w-4 h-4 mr-2" />
          Sell
        </button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Symbol
          </label>
          <input
            type="text"
            {...register('symbol')}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
            placeholder="BTC, ETH, etc."
          />
          {errors.symbol && (
            <p className="text-sm text-red-600 mt-1">{errors.symbol.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Amount
          </label>
          <input
            type="number"
            step="0.0001"
            {...register('amount', { valueAsNumber: true })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
            placeholder="0.0000"
          />
          {errors.amount && (
            <p className="text-sm text-red-600 mt-1">{errors.amount.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Price per unit
          </label>
          <input
            type="number"
            step="0.01"
            {...register('price', { valueAsNumber: true })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
            placeholder="0.00"
          />
          {errors.price && (
            <p className="text-sm text-red-600 mt-1">{errors.price.message}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={loading}
          className={`w-full py-3 px-4 rounded-lg font-medium text-white transition-colors ${
            activeTab === 'buy'
              ? 'bg-secondary hover:bg-green-600 disabled:bg-gray-400'
              : 'bg-danger hover:bg-red-600 disabled:bg-gray-400'
          }`}
        >
          {loading ? 'Processing...' : `${activeTab === 'buy' ? 'Place Buy Order' : 'Sell Now'}`}
        </button>
      </form>
    </div>
  );
}
