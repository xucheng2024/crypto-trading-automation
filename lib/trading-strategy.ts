import { OKXClient } from './okx';

export interface TradingCondition {
  symbol: string;
  condition: 'price_above' | 'price_below' | 'rsi_oversold' | 'rsi_overbought';
  value: number;
  action: 'buy' | 'sell';
  amount: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
}

export interface StrategyResult {
  success: boolean;
  action: string;
  symbol: string;
  amount: number;
  price: number;
  orderId?: string;
  message: string;
  timestamp: string;
}

export class TradingStrategyService {
  private okxClient: OKXClient;

  constructor(okxClient: OKXClient) {
    this.okxClient = okxClient;
  }

  async executeStrategy(conditions: TradingCondition[]): Promise<StrategyResult[]> {
    const results: StrategyResult[] = [];
    
    for (const condition of conditions) {
      try {
        console.log(`Executing strategy for ${condition.symbol}:`, condition);
        
        const result = await this.executeCondition(condition);
        results.push(result);
        
        // Add delay between trades to avoid rate limiting
        await this.delay(1000);
      } catch (error) {
        console.error(`Failed to execute strategy for ${condition.symbol}:`, error);
        results.push({
          success: false,
          action: condition.action,
          symbol: condition.symbol,
          amount: condition.amount,
          price: 0,
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    }
    
    return results;
  }

  private async executeCondition(condition: TradingCondition): Promise<StrategyResult> {
    try {
      // Check if condition is met
      const shouldExecute = await this.checkCondition(condition);
      
      if (!shouldExecute) {
        return {
          success: true,
          action: condition.action,
          symbol: condition.symbol,
          amount: condition.amount,
          price: 0,
          message: 'Condition not met, skipping trade',
          timestamp: new Date().toISOString(),
        };
      }

      // Execute the trade
      const result = await this.executeTrade(condition);
      
      return {
        success: true,
        action: condition.action,
        symbol: condition.symbol,
        amount: condition.amount,
        price: result.price,
        orderId: result.orderId,
        message: result.message,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to execute condition: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async checkCondition(condition: TradingCondition): Promise<boolean> {
    try {
      const instId = this.formatTradingPair(condition.symbol);
      
      switch (condition.condition) {
        case 'price_above':
        case 'price_below':
          const currentPrice = await this.okxClient.getMarketPrice(instId);
          if (condition.condition === 'price_above') {
            return currentPrice > condition.value;
          } else {
            return currentPrice < condition.value;
          }
        
        case 'rsi_oversold':
        case 'rsi_overbought':
          // For RSI conditions, you would need to implement technical analysis
          // This is a placeholder - implement based on your RSI calculation
          console.log(`RSI condition check not implemented for ${condition.symbol}`);
          return false;
        
        default:
          return false;
      }
    } catch (error) {
      console.error(`Failed to check condition for ${condition.symbol}:`, error);
      return false;
    }
  }

  private async executeTrade(condition: TradingCondition): Promise<{ price: number; orderId?: string; message: string }> {
    try {
      const instId = this.formatTradingPair(condition.symbol);
      
      if (condition.orderType === 'market') {
        // Execute market order
        const orderParams = {
          instId,
          tdMode: 'cash' as const,
          side: condition.action,
          ordType: 'market' as const,
          sz: condition.amount.toString(),
          clOrdId: `strategy_${condition.action}_${Date.now()}`,
        };

        const response = await this.okxClient.placeOrder(orderParams);
        
        if (response.data && response.data.length > 0) {
          const orderData = response.data[0];
          const marketPrice = await this.okxClient.getMarketPrice(instId);
          
          return {
            price: marketPrice,
            orderId: orderData.ordId,
            message: `Market ${condition.action} executed successfully`,
          };
        } else {
          throw new Error('No order data received from OKX');
        }
      } else {
        // Execute limit order
        if (!condition.limitPrice) {
          throw new Error('Limit price is required for limit orders');
        }
        
        const orderParams = {
          instId,
          tdMode: 'cash' as const,
          side: condition.action,
          ordType: 'limit' as const,
          sz: condition.amount.toString(),
          px: condition.limitPrice.toString(),
          clOrdId: `strategy_limit_${condition.action}_${Date.now()}`,
        };

        const response = await this.okxClient.placeOrder(orderParams);
        
        if (response.data && response.data.length > 0) {
          const orderData = response.data[0];
          
          return {
            price: condition.limitPrice,
            orderId: orderData.ordId,
            message: `Limit ${condition.action} order placed successfully`,
          };
        } else {
          throw new Error('No order data received from OKX');
        }
      }
    } catch (error) {
      throw new Error(`Failed to execute trade: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private formatTradingPair(symbol: string): string {
    return symbol.includes('-') ? symbol : `${symbol}-USDT`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper method to get current market data for analysis
  async getMarketData(symbol: string) {
    try {
      const instId = this.formatTradingPair(symbol);
      const price = await this.okxClient.getMarketPrice(instId);
      const balance = await this.okxClient.getBalance();
      const positions = await this.okxClient.getPositions(instId);
      
      return {
        symbol,
        currentPrice: price,
        balance,
        positions,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`Failed to get market data for ${symbol}:`, error);
      throw error;
    }
  }

  // Method to check if we have sufficient balance for a trade
  async checkBalance(symbol: string, amount: number, action: 'buy' | 'sell'): Promise<boolean> {
    try {
      if (action === 'buy') {
        // Check USDT balance for buying
        const balance = await this.okxClient.getBalance('USDT');
        const usdtBalance = balance.find(b => b.ccy === 'USDT');
        if (!usdtBalance) return false;
        
        const currentPrice = await this.okxClient.getMarketPrice(this.formatTradingPair(symbol));
        const requiredAmount = amount * currentPrice;
        
        return parseFloat(usdtBalance.availBal) >= requiredAmount;
      } else {
        // Check crypto balance for selling
        const balance = await this.okxClient.getBalance(symbol);
        const cryptoBalance = balance.find(b => b.ccy === symbol);
        if (!cryptoBalance) return false;
        
        return parseFloat(cryptoBalance.availBal) >= amount;
      }
    } catch (error) {
      console.error(`Failed to check balance for ${symbol}:`, error);
      return false;
    }
  }
}
