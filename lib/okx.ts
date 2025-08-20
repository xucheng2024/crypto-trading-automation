import crypto from 'crypto';

export interface OKXConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  isTestnet?: boolean;
}

export interface OKXOrderParams {
  instId: string;        // Trading pair (e.g., "BTC-USDT")
  tdMode: 'cash' | 'cross' | 'isolated';
  side: 'buy' | 'sell';
  ordType: 'market' | 'limit' | 'post_only' | 'fok' | 'ioc';
  sz: string;            // Order size
  px?: string;           // Price (required for limit orders)
  clOrdId?: string;      // Client order ID
}

export interface OKXOrderResponse {
  code: string;
  msg: string;
  data: Array<{
    clOrdId: string;
    ordId: string;
    tag: string;
    sCode: string;
    sMsg: string;
  }>;
}

export interface OKXBalance {
  ccy: string;
  bal: string;
  frozenBal: string;
  availBal: string;
}

export class OKXClient {
  private config: OKXConfig;
  private baseUrl: string;

  constructor(config: OKXConfig) {
    this.config = config;
    this.baseUrl = config.isTestnet 
      ? 'https://www.okx.com' 
      : 'https://www.okx.com';
  }

  private generateSignature(timestamp: string, method: string, requestPath: string, body: string = ''): string {
    const message = timestamp + method + requestPath + body;
    return crypto
      .createHmac('sha256', this.config.secretKey)
      .update(message)
      .digest('base64');
  }

  private async makeRequest(
    endpoint: string, 
    method: 'GET' | 'POST' = 'GET', 
    body?: any
  ): Promise<any> {
    const timestamp = new Date().toISOString();
    const requestPath = `/api/v5${endpoint}`;
    const bodyString = body ? JSON.stringify(body) : '';
    
    const signature = this.generateSignature(timestamp, method, requestPath, bodyString);
    
    const headers: any = {
      'OK-ACCESS-KEY': this.config.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.config.passphrase,
      'Content-Type': 'application/json',
    };

    if (this.config.isTestnet) {
      headers['x-simulated-trading'] = '1';
    }

    try {
      const response = await fetch(this.baseUrl + requestPath, {
        method,
        headers,
        body: bodyString,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.code !== '0') {
        throw new Error(`OKX API Error: ${data.code} - ${data.msg}`);
      }

      return data;
    } catch (error) {
      console.error('OKX API request failed:', error);
      throw new Error(`OKX API request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Place a new order
  async placeOrder(orderParams: OKXOrderParams): Promise<OKXOrderResponse> {
    try {
      // Validate order parameters
      this.validateOrderParams(orderParams);
      
      console.log('Placing OKX order:', orderParams);

      const response = await this.makeRequest('/trade/order', 'POST', orderParams);
      return response;
    } catch (error) {
      console.error('Failed to place order:', error);
      throw error;
    }
  }

  // Cancel an existing order
  async cancelOrder(instId: string, ordId: string, clOrdId?: string): Promise<any> {
    try {
      const params: any = { instId, ordId };
      if (clOrdId) params.clOrdId = clOrdId;
      
      console.log('Cancelling OKX order:', { instId, ordId, clOrdId });

      const response = await this.makeRequest('/trade/cancel-order', 'POST', params);
      return response;
    } catch (error) {
      console.error('Failed to cancel order:', error);
      throw error;
    }
  }

  // Get order details
  async getOrder(instId: string, ordId: string, clOrdId?: string): Promise<any> {
    try {
      let endpoint = `/trade/order?instId=${instId}`;
      if (ordId) endpoint += `&ordId=${ordId}`;
      if (clOrdId) endpoint += `&clOrdId=${clOrdId}`;
      
      const response = await this.makeRequest(endpoint);
      return response;
    } catch (error) {
      console.error('Failed to get order:', error);
      throw error;
    }
  }

  // Get account balance
  async getBalance(ccy?: string): Promise<OKXBalance[]> {
    try {
      let endpoint = '/account/balance';
      if (ccy) endpoint += `?ccy=${ccy}`;
      
      const response = await this.makeRequest(endpoint);
      return response.data;
    } catch (error) {
      console.error('Failed to get balance:', error);
      throw error;
    }
  }

  // Get trading account positions
  async getPositions(instId?: string): Promise<any> {
    try {
      let endpoint = '/account/positions';
      if (instId) endpoint += `?instId=${instId}`;
      
      const response = await this.makeRequest(endpoint);
      return response.data;
    } catch (error) {
      console.error('Failed to get positions:', error);
      throw error;
    }
  }

  // Get market price for a trading pair
  async getMarketPrice(instId: string): Promise<number> {
    try {
      const response = await this.makeRequest(`/market/ticker?instId=${instId}`);
      if (response.data && response.data.length > 0) {
        return parseFloat(response.data[0].last);
      }
      throw new Error('No market data available');
    } catch (error) {
      console.error('Failed to get market price:', error);
      throw error;
    }
  }

  // Get order book for a trading pair
  async getOrderBook(instId: string, sz: number = 20): Promise<any> {
    try {
      const response = await this.makeRequest(`/market/books?instId=${instId}&sz=${sz}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get order book:', error);
      throw error;
    }
  }

  // Get recent trades
  async getRecentTrades(instId: string, limit: number = 100): Promise<any> {
    try {
      const response = await this.makeRequest(`/market/trades?instId=${instId}&limit=${limit}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get recent trades:', error);
      throw error;
    }
  }

  // Get account configuration
  async getAccountConfig(): Promise<any> {
    try {
      const response = await this.makeRequest('/account/config');
      return response.data;
    } catch (error) {
      console.error('Failed to get account config:', error);
      throw error;
    }
  }

  // Get pending orders
  async getPendingOrders(instId?: string): Promise<any> {
    try {
      let endpoint = '/trade/orders-pending';
      if (instId) endpoint += `?instId=${instId}`;
      
      const response = await this.makeRequest(endpoint);
      return response.data;
    } catch (error) {
      console.error('Failed to get pending orders:', error);
      throw error;
    }
  }

  // Validate order parameters
  private validateOrderParams(params: OKXOrderParams): void {
    if (!params.instId) throw new Error('instId is required');
    if (!params.tdMode) throw new Error('tdMode is required');
    if (!params.side) throw new Error('side is required');
    if (!params.ordType) throw new Error('ordType is required');
    if (!params.sz) throw new Error('sz is required');
    
    if (params.ordType === 'limit' && !params.px) {
      throw new Error('Price is required for limit orders');
    }
    
    if (parseFloat(params.sz) <= 0) {
      throw new Error('Order size must be positive');
    }
  }

  // Helper method to format trading pair
  static formatTradingPair(base: string, quote: string): string {
    return `${base.toUpperCase()}-${quote.toUpperCase()}`;
  }

  // Helper method to calculate order value
  static calculateOrderValue(size: number, price: number): number {
    return size * price;
  }

  // Helper method to check if the client is properly configured
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.makeRequest('/account/balance');
      return response.code === '0';
    } catch (error) {
      console.error('OKX connection test failed:', error);
      return false;
    }
  }
}
