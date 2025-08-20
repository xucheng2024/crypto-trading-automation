declare module 'opossum' {
  export default class CircuitBreaker<T = any> {
    constructor(
      fn: (...args: any[]) => Promise<T>,
      options?: {
        timeout?: number;
        errorThresholdPercentage?: number;
        resetTimeout?: number;
        volumeThreshold?: number;
        name?: string;
        group?: string;
        rollingCountTimeout?: number;
        rollingCountBuckets?: number;
        rollingPercentilesEnabled?: boolean;
        capacity?: number;
        allowWarmUp?: boolean;
        volumeThreshold?: number;
        errorFilter?: (error: any) => boolean;
        cache?: boolean;
        cacheTTL?: number;
        cacheKey?: (...args: any[]) => string;
        fallback?: (...args: any[]) => any;
        monitor?: any;
        trigger?: any;
        bucket?: any;
        rollingCount?: any;
        rollingPercentiles?: any;
        stats?: any;
        warmUp?: any;
        healthCheck?: (...args: any[]) => Promise<boolean>;
        healthCheckInterval?: number;
      }
    );

    fire(...args: any[]): Promise<T>;
    fallback(fn: (...args: any[]) => any): CircuitBreaker<T>;
    on(event: string, listener: (...args: any[]) => void): CircuitBreaker<T>;
    once(event: string, listener: (...args: any[]) => void): CircuitBreaker<T>;
    removeListener(event: string, listener: (...args: any[]) => void): CircuitBreaker<T>;
    removeAllListeners(event?: string): CircuitBreaker<T>;
    listeners(event: string): Function[];
    listenerCount(event: string): number;
    eventNames(): string[];
    open(): void;
    close(): void;
    halfOpen(): void;
    isOpen(): boolean;
    isClosed(): boolean;
    isHalfOpen(): boolean;
    stats: any;
  }
}
