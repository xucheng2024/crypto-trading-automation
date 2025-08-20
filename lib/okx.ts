import * as crypto from 'crypto';
import CircuitBreaker from 'opossum';
import axios from 'axios';
import axiosRetry from 'axios-retry';

export interface OKXConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  isTestnet?: boolean;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export interface OKXMarketOrderParams {
  instId: string;                    // Instrument ID, e.g. BTC-USDT
  tdMode: 'cash'; // Trade mode
  side: 'sell';             // Order side
  ordType: 'market'; // Order type
  sz: string;                       // eg.sell 0.1 BTC
  px?: string;                      // Order price (required for limit orders)
  clOrdId?: string;                 // Client Order ID
}

export interface OKXTriggerOrderParams {
  instId: string;
  tdMode: 'cash';
  side: 'buy';
  ordType: 'trigger';
  sz: string;                      // eg.buy 1000 USDT
  triggerPx: string;
  orderPx: string;
}

export interface OKXAlgoOrderResponse {
  code: string;
  msg: string;
  data: Array<{
    algoClOrdId: string;  // Client-supplied Algo ID
    algoId: string;       // Algo ID
    clOrdId?: string;     // Client Order ID (Deprecated)
    sCode: string;        // Event execution result code, 0 means success
    sMsg: string;         // Rejection message if unsuccessful
    tag?: string;         // Order tag (optional)
  }>;
}

export interface OKXMarketOrderResponse {
  code: string;
  msg: string;
  data: Array<{
    ordId: string;      // Order ID
    clOrdId: string;    // Client Order ID as assigned by the client
    tag: string;        // Order tag
    ts: string;         // Timestamp when order processing finished (milliseconds)
    sCode: string;      // Event execution result code, 0 means success
    sMsg: string;       // Rejection or success message
  }>;
  inTime?: string;      // Timestamp when request received (microseconds)
  outTime?: string;     // Timestamp when response sent (microseconds)
}

export class OKXClient {
  private config: OKXConfig;
  private baseUrl: string;
  private readonly defaultTimeout: number = 10000;
  private readonly defaultMaxRetries: number = 3;
  private readonly defaultRetryDelay: number = 1000;

  constructor(config: OKXConfig) {
    this.config = config;
    
    // Use different base URL for demo trading if needed
    if (config.isTestnet) {
      this.baseUrl = 'https://www.okx.com';  // Demo trading uses same URL but with x-simulated-trading header
      console.log('🔧 Demo trading mode - using www.okx.com with simulated trading header');
    } else {
      this.baseUrl = 'https://www.okx.com';  // Production trading
      console.log('🔧 Production trading mode - using www.okx.com');
    }
    
    axiosRetry(axios, { 
      retries: config.maxRetries || this.defaultMaxRetries,
      retryDelay: (retryCount) => {
        const delay = (config.retryDelay || this.defaultRetryDelay) * Math.pow(2, retryCount - 1);
        console.log(`Retry attempt ${retryCount}, waiting ${delay}ms...`);
        return delay;
      },
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
               (error.response && error.response.status >= 500) || false;
      }
    });
  }

  private generateSignature(timestamp: string, method: string, requestPath: string, body: string = ''): string {
    // OKX API signature format: timestamp + method + requestPath + body
    // All inputs must be exactly as they appear in the request
    
    // Ensure method is uppercase
    const upperMethod = method.toUpperCase();
    
    // Ensure body is string (empty string for GET requests)
    const bodyStr = body || '';
    
    // Construct the message exactly as OKX expects
    const message = timestamp + upperMethod + requestPath + bodyStr;
    
    console.log('🔐 Signature Debug:', {
      timestamp,
      method: upperMethod,
      requestPath,
      body: bodyStr || '(empty)',
      message,
      messageLength: message.length,
      secretKeyLength: this.config.secretKey.length
    });
    
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
    // OKX API requires timestamp in ISO 8601 format with millisecond precision
    // Must be within 30 seconds of server time
    const timestamp = new Date().toISOString();
    
    // requestPath must include path + query parameters (without domain)
    const requestPath = `/api/v5${endpoint}`;
    
    // Body must be byte-identical - use exact same string for signature and request
    const bodyString = body ? JSON.stringify(body) : '';
    
    console.log('📡 Request Debug:', {
      endpoint,
      method,
      timestamp,
      requestPath,
      bodyString: bodyString || '(empty)',
      serverTime: Date.now(),
      isoTimestamp: timestamp
    });
    
    // Method must be uppercase for signature
    const signature = this.generateSignature(timestamp, method.toUpperCase(), requestPath, bodyString);
    
    // OKX API requires specific header order for signature validation
    // All four private headers must be present and consistent
    const headers: any = {
      'OK-ACCESS-KEY': this.config.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,  // Must match timestamp used in signature
      'OK-ACCESS-PASSPHRASE': this.config.passphrase,
      'Content-Type': 'application/json',
    };

    // Add simulated trading header for testnet
    if (this.config.isTestnet) {
      headers['x-simulated-trading'] = '1';
      console.log('🔧 Testnet mode enabled - adding x-simulated-trading header');
    }

    console.log('📋 Request Headers:', {
      'OK-ACCESS-KEY': `${this.config.apiKey.substring(0, 8)}...`,
      'OK-ACCESS-SIGN': `${signature.substring(0, 16)}...`,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': `${this.config.passphrase.substring(0, 8)}...`,
      'Content-Type': headers['Content-Type'],
      'x-simulated-trading': headers['x-simulated-trading'] || 'not set',
      'isTestnet': this.config.isTestnet,
      'timestampConsistency': 'OK' // Verify timestamp is same in signature and header
    });

    if (this.config.isTestnet) {
      headers['x-simulated-trading'] = '1';
    }

    try {
      // Ensure request body is exactly the same as used in signature
      const response = await axios({
        method,
        url: this.baseUrl + requestPath,
        headers,
        data: bodyString, // Must be byte-identical to bodyString used in signature
        timeout: this.config.timeout || this.defaultTimeout,
      });

      const data = response.data;
      
      if (data.code !== '0') {
        throw new Error(`OKX API Error: ${data.code} - ${data.msg}`);
      }

      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new Error('Request timeout - OKX API is not responding');
        }
        if (error.response) {
          // Try to get detailed error from OKX API response
          const responseData = error.response.data;
          console.error('❌ OKX API Error Response:', {
            status: error.response.status,
            statusText: error.response.statusText,
            data: responseData,
            headers: error.response.headers
          });
          
          if (responseData && responseData.code && responseData.msg) {
            throw new Error(`OKX API Error ${responseData.code}: ${responseData.msg}`);
          }
          throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
        }
        if (error.request) {
          throw new Error('Network error - no response received from OKX API');
        }
      }
      
      console.error('OKX API request failed:', error);
      throw new Error(`OKX API request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private createCircuitBreaker<T>(operation: () => Promise<T>): CircuitBreaker {
    return new CircuitBreaker(operation, {
      timeout: this.config.timeout || this.defaultTimeout,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }



  // Place algo order (trigger, conditional, oco, trailing)
  async placeAlgoOrder(algoParams: OKXTriggerOrderParams): Promise<OKXAlgoOrderResponse> {
    try {
      console.log('Placing OKX algo order:', algoParams);

      const circuitBreaker = this.createCircuitBreaker(() => 
        this.makeRequest('/trade/order-algo', 'POST', algoParams)
      );

      circuitBreaker.on('open', () => console.log('Circuit breaker opened for placeAlgoOrder'));
      circuitBreaker.on('close', () => console.log('Circuit breaker closed for placeAlgoOrder'));

      return await circuitBreaker.fire();
    } catch (error) {
      console.error('Failed to place algo order:', error);
      throw error;
    }
  }

  // Cancel algo trigger order
  async cancelAlgoTriggerOrder(instId: string, algoId: string, algoClOrdId?: string): Promise<any> {
    try {
      const params: any = { instId, algoId };
      if (algoClOrdId) params.algoClOrdId = algoClOrdId;
      
      console.log('Cancelling OKX algo trigger order:', { instId, algoId, algoClOrdId });

      const circuitBreaker = this.createCircuitBreaker(() => 
        this.makeRequest('/trade/cancel-algos', 'POST', params)
      );

      circuitBreaker.on('open', () => console.log('Circuit breaker opened for cancelAlgoTriggerOrder'));
      circuitBreaker.on('close', () => console.log('Circuit breaker closed for cancelAlgoTriggerOrder'));

      return await circuitBreaker.fire();
    } catch (error) {
      console.error('Failed to cancel algo trigger order:', error);
      throw error;
    }
  }

  // Get algo orders list
  async getAlgoOrdersList(instId?: string): Promise<any> {
    try {
      let endpoint = '/trade/orders-algo-pending';
      if (instId) endpoint += `?instId=${instId}`;
      
      const response = await this.makeRequest(endpoint);
      return response.data;
    } catch (error) {
      console.error('Failed to get algo orders list:', error);
      throw error;
    }
  }

  // Get algo order details
  async getAlgoOrderDetail(instId: string, algoId: string): Promise<any> {
    try {
      const endpoint = `/trade/order-algo?instId=${instId}&algoId=${algoId}`;
      
      const response = await this.makeRequest(endpoint);
      return response.data;
    } catch (error) {
      console.error('Failed to get algo order detail:', error);
      throw error;
    }
  }

  // Get pending orders (regular orders)
  async getPendingOrders(): Promise<any> {
    try {
      const response = await this.makeRequest('/trade/orders-pending');
      return response.data;
    } catch (error) {
      console.error('Failed to get pending orders:', error);
      throw error;
    }
  }

  // Cancel a regular order
  async cancelOrder(instId: string, ordId: string, clOrdId?: string): Promise<any> {
    try {
      const params: any = { instId, ordId };
      if (clOrdId) params.clOrdId = clOrdId;
      
      console.log('Cancelling OKX order:', { instId, ordId, clOrdId });

      const circuitBreaker = this.createCircuitBreaker(() => 
        this.makeRequest('/trade/cancel-order', 'POST', params)
      );

      circuitBreaker.on('open', () => console.log('Circuit breaker opened for cancelOrder'));
      circuitBreaker.on('close', () => console.log('Circuit breaker closed for cancelOrder'));

      return await circuitBreaker.fire();
    } catch (error) {
      console.error('Failed to cancel order:', error);
      throw error;
    }
  }

  // Place a regular order (market, limit, etc.)
  async placeOrder(orderParams: OKXMarketOrderParams): Promise<OKXMarketOrderResponse> {
    try {
      console.log('Placing OKX order:', orderParams);

      const circuitBreaker = this.createCircuitBreaker(() => 
        this.makeRequest('/trade/order', 'POST', orderParams)
      );

      circuitBreaker.on('open', () => console.log('Circuit breaker opened for placeOrder'));
      circuitBreaker.on('close', () => console.log('Circuit breaker closed for placeOrder'));

      return await circuitBreaker.fire();
    } catch (error) {
      console.error('Failed to place order:', error);
      throw error;
    }
  }




  // Get account balance
  async getBalance(ccy?: string): Promise<any[]> {
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

  // Get candlestick data (no authentication required)
  async getCandlesticks(instId: string, bar: string = '1D', limit: number = 100): Promise<any[]> {
    try {
      const response = await this.makeRequest(`/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
      if (response.data && response.data.length > 0) {
        return response.data;
      }
      throw new Error('No candlestick data available');
    } catch (error) {
      console.error('Failed to get candlestick data:', error);
      throw error;
    }
  }

  // Get all market tickers (no authentication required)
  async getAllMarketTickers(instType?: 'SPOT' | 'SWAP' | 'FUTURES' | 'OPTION'): Promise<any[]> {
    try {
      let endpoint = '/market/tickers';
      if (instType) endpoint += `?instType=${instType}`;
      
      const response = await this.makeRequest(endpoint);
      return response.data;
    } catch (error) {
      console.error('Failed to get all market tickers:', error);
      throw error;
    }
  }

  // Get market ticker for a trading pair (no authentication required)
  async getMarketTicker(instId: string): Promise<any> {
    try {
      const response = await this.makeRequest(`/market/ticker?instId=${instId}`);
      if (response.data && response.data.length > 0) {
        return response.data[0];
      }
      throw new Error('No market data available');
    } catch (error) {
      console.error('Failed to get market ticker:', error);
      throw error;
    }
  }


  // Test connection
  async testConnection(): Promise<boolean> {
    try {
      // Use a simple endpoint that requires authentication to test connection
      const response = await this.makeRequest('/account/balance');
      return response.code === '0';
    } catch (error) {
      console.error('OKX connection test failed:', error);
      return false;
    }
  }
}
