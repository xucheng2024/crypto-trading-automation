import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Database = {
  public: {
    Tables: {
      trades: {
        Row: {
          id: string;
          symbol: string;
          side: 'buy' | 'sell';
          amount: number;
          price: number;
          status: 'pending' | 'filled' | 'cancelled';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          symbol: string;
          side: 'buy' | 'sell';
          amount: number;
          price: number;
          status?: 'pending' | 'filled' | 'cancelled';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          symbol?: string;
          side?: 'buy' | 'sell';
          amount?: number;
          price?: number;
          status?: 'pending' | 'filled' | 'cancelled';
          updated_at?: string;
        };
      };
      portfolio: {
        Row: {
          id: string;
          symbol: string;
          amount: number;
          avg_price: number;
          updated_at: string;
        };
        Insert: {
          id?: string;
          symbol: string;
          amount: number;
          avg_price: number;
          updated_at?: string;
        };
        Update: {
          id?: string;
          symbol?: string;
          amount?: number;
          avg_price?: number;
          updated_at?: string;
        };
      };
    };
  };
};
