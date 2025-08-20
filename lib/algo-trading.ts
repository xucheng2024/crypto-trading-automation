import { OKXClient } from './okx';

export interface CryptoConfig {
  limit: string;
  duration: string;
  expected_return: number;
  trade_count: number;
  trade_frequency: number;
  notes: string;
}

export interface TradingConfig {
  cryptocurrencies: Record<string, CryptoConfig>;
}

export interface TriggerOrderResult {
  symbol: string;
  success: boolean;
  orderId?: string;
  triggerPrice: number;
  amount: number;
  message: string;
  timestamp: string;
}

export class AlgoTradingService {
  private okxClient: OKXClient;
  private tradingConfig: TradingConfig;

  constructor(okxClient: OKXClient, tradingConfig: TradingConfig) {
    this.okxClient = okxClient;
    this.tradingConfig = tradingConfig;
  }

  /**
   * Main method to execute algorithmic buy orders
   * Gets all balance and places trigger orders for each crypto
   */
  async executeAlgoBuyOrders(): Promise<TriggerOrderResult[]> {
    console.log('🚀 Starting algorithmic buy order execution...');
    
    try {
      // Get all account balances
      const balances = await this.okxClient.getBalance();
      console.log('💰 Account balances retrieved:', balances);
      
      // Find USDT balance for buying
      const usdtBalance = balances.find(b => b.ccy === 'USDT');
      if (!usdtBalance || parseFloat(usdtBalance.availBal) <= 0) {
        throw new Error('No USDT balance available for trading');
      }
      
      const totalUsdtBalance = parseFloat(usdtBalance.availBal);
      console.log(`💵 Total USDT balance: $${totalUsdtBalance.toFixed(2)}`);
      
      // Get day's open prices for all cryptos
      const openPrices = await this.getDaysOpenPrices();
      console.log('📊 Day open prices retrieved:', openPrices);
      
      // Place trigger orders for each crypto using full balance
      const results: TriggerOrderResult[] = [];
      
      for (const [symbol, config] of Object.entries(this.tradingConfig.cryptocurrencies)) {
        try {
          console.log(`📈 Processing ${symbol} with limit ${config.limit}%...`);
          
          const result = await this.placeTriggerOrderForCrypto(
            symbol,
            config,
            totalUsdtBalance,
            openPrices[symbol]
          );
          
          results.push(result);
          
          // Add delay between orders to avoid rate limiting
          await this.delay(1000);
          
        } catch (error) {
          console.error(`❌ Failed to process ${symbol}:`, error);
          results.push({
            symbol,
            success: false,
            triggerPrice: 0,
            amount: totalUsdtBalance,
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      console.log('✅ Algorithmic buy order execution completed');
      return results;
      
    } catch (error) {
      console.error('💥 Algorithmic trading failed:', error);
      throw error;
    }
  }

  /**
   * Place trigger order for a specific cryptocurrency
   * Uses the full balance amount for each crypto
   */
  private async placeTriggerOrderForCrypto(
    symbol: string,
    config: CryptoConfig,
    balanceAmount: number,
    dayOpenPrice: number
  ): Promise<TriggerOrderResult> {
    try {
      // Calculate trigger price: day's open price × (limit/100)
      const limitPercentage = parseFloat(config.limit) / 100;
      const triggerPrice = dayOpenPrice * limitPercentage;
      
      console.log(`🎯 ${symbol} - Day open: $${dayOpenPrice}, Limit: ${config.limit}%, Trigger: $${triggerPrice.toFixed(4)}`);
      
      // Calculate amount to buy (in crypto units)
      const cryptoAmount = balanceAmount / triggerPrice;
      
      // Place the trigger order
      const orderParams = {
        instId: this.formatTradingPair(symbol),
        tdMode: 'cash' as const,
        side: 'buy' as const,
        ordType: 'limit' as const,
        sz: cryptoAmount.toFixed(8), // Crypto amount with 8 decimal precision
        px: triggerPrice.toFixed(4), // Trigger price
        clOrdId: `algo_buy_${symbol}_${Date.now()}`,
      };
      
      console.log(`📝 Placing order for ${symbol}:`, orderParams);
      
      const response = await this.okxClient.placeOrder(orderParams);
      
      if (response.data && response.data.length > 0) {
        const orderData = response.data[0];
        
        console.log(`✅ Trigger order placed for ${symbol}: Order ID ${orderData.ordId}`);
        
        return {
          symbol,
          success: true,
          orderId: orderData.ordId,
          triggerPrice,
          amount: cryptoAmount,
          message: `Trigger order placed successfully at $${triggerPrice.toFixed(4)}`,
          timestamp: new Date().toISOString(),
        };
      } else {
        throw new Error('No order data received from OKX');
      }
      
    } catch (error) {
      console.error(`❌ Failed to place trigger order for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Get day's open prices for all cryptocurrencies in the config
   */
  private async getDaysOpenPrices(): Promise<Record<string, number>> {
    const openPrices: Record<string, number> = {};
    
    try {
      // For now, we'll use current market price as day's open
      // In production, you might want to get actual day's open from OKX API
      for (const symbol of Object.keys(this.tradingConfig.cryptocurrencies)) {
        try {
          const instId = this.formatTradingPair(symbol);
          const currentPrice = await this.okxClient.getMarketPrice(instId);
          openPrices[symbol] = currentPrice;
          
          console.log(`📊 ${symbol} current price: $${currentPrice}`);
          
          // Add small delay to avoid rate limiting
          await this.delay(200);
          
        } catch (error) {
          console.error(`❌ Failed to get price for ${symbol}:`, error);
          // Use a fallback price or skip this crypto
          openPrices[symbol] = 0;
        }
      }
      
      return openPrices;
      
    } catch (error) {
      console.error('❌ Failed to get day open prices:', error);
      throw error;
    }
  }

  /**
   * Format trading pair symbol
   */
  private formatTradingPair(symbol: string): string {
    return symbol.includes('-') ? symbol : `${symbol}-USDT`;
  }

  /**
   * Delay helper to avoid rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get summary of all trigger orders
   */
  async getTriggerOrdersSummary(): Promise<{
    totalOrders: number;
    successfulOrders: number;
    failedOrders: number;
    totalValue: number;
    orders: TriggerOrderResult[];
  }> {
    try {
      const results = await this.executeAlgoBuyOrders();
      
      const successfulOrders = results.filter(r => r.success);
      const failedOrders = results.filter(r => !r.success);
      const totalValue = successfulOrders.reduce((sum, order) => sum + (order.amount * order.triggerPrice), 0);
      
      return {
        totalOrders: results.length,
        successfulOrders: successfulOrders.length,
        failedOrders: failedOrders.length,
        totalValue,
        orders: results,
      };
      
    } catch (error) {
      console.error('❌ Failed to get trigger orders summary:', error);
      throw error;
    }
  }
}
