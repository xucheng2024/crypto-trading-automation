export interface Trade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  status: 'pending' | 'filled' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface PortfolioItem {
  id: string;
  symbol: string;
  amount: number;
  avg_price: number;
  updated_at: string;
  current_value?: number;
}

export interface PortfolioData {
  holdings: PortfolioItem[];
  total_value: number;
}

export interface TradingFormData {
  symbol: string;
  amount: number;
  price: number;
  side: 'buy' | 'sell';
}

export interface OrderFormData {
  symbol: string;
  amount: number;
  price: number;
}
