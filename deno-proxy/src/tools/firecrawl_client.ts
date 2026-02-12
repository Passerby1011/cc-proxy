import type {
  FirecrawlConfig,
  FirecrawlSearchParams,
  FirecrawlSearchResponse,
  FirecrawlScrapeParams,
  FirecrawlScrapeResponse,
  FirecrawlBatchScrapeParams,
} from "./types.ts";
import { log } from "../logging.ts";

/**
 * 缓存条目接口
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * Firecrawl API 客户端
 * 封装对 Firecrawl API 的调用，包括搜索和抓取功能
 * 支持短期缓存以避免重复调用
 */
export class FirecrawlClient {
  // 搜索缓存：key = query, value = 搜索结果
  private static searchCache = new Map<string, CacheEntry<FirecrawlSearchResponse>>();
  
  // 抓取缓存：key = url, value = 抓取结果
  private static scrapeCache = new Map<string, CacheEntry<FirecrawlScrapeResponse>>();
  
  // 缓存过期时间（毫秒）- 默认 30 秒
  private static readonly CACHE_TTL = 30000;
  
  // 最大缓存条目数
  private static readonly MAX_CACHE_SIZE = 100;

  constructor(private config: FirecrawlConfig) {
    // 启动缓存清理定时器（每分钟清理一次过期缓存）
    this.startCacheCleanup();
  }

  /**
   * 启动缓存清理定时器
   */
  private startCacheCleanup(): void {
    // 每分钟清理一次过期缓存
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 60000);
  }

  /**
   * 清理过期的缓存条目
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let searchCleaned = 0;
    let scrapeCleaned = 0;

    // 清理搜索缓存
    for (const [key, entry] of FirecrawlClient.searchCache.entries()) {
      if (now > entry.expiresAt) {
        FirecrawlClient.searchCache.delete(key);
        searchCleaned++;
      }
    }

    // 清理抓取缓存
    for (const [key, entry] of FirecrawlClient.scrapeCache.entries()) {
      if (now > entry.expiresAt) {
        FirecrawlClient.scrapeCache.delete(key);
        scrapeCleaned++;
      }
    }

    if (searchCleaned > 0 || scrapeCleaned > 0) {
      log("debug", "Cleaned up expired Firecrawl cache", {
        searchCleaned,
        scrapeCleaned,
        searchCacheSize: FirecrawlClient.searchCache.size,
        scrapeCacheSize: FirecrawlClient.scrapeCache.size,
      });
    }
  }

  /**
   * 限制缓存大小，删除最旧的条目
   */
  private static limitCacheSize<T>(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size > this.MAX_CACHE_SIZE) {
      // 按时间戳排序，删除最旧的条目
      const entries = Array.from(cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toDelete = entries.slice(0, cache.size - this.MAX_CACHE_SIZE);
      for (const [key] of toDelete) {
        cache.delete(key);
      }
    }
  }

  /**
   * 执行网络搜索（带缓存）
   */
  async search(params: FirecrawlSearchParams): Promise<FirecrawlSearchResponse> {
    // 生成缓存键（包含查询参数）
    const cacheKey = JSON.stringify({
      query: params.query,
      limit: params.limit,
      location: params.location,
    });

    // 检查缓存
    const cached = FirecrawlClient.searchCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && now < cached.expiresAt) {
      log("info", "🔄 Using cached Firecrawl search result", {
        query: params.query,
        age: now - cached.timestamp,
        cacheSize: FirecrawlClient.searchCache.size,
      });
      return cached.data;
    }

    // 执行实际搜索
    const url = `${this.config.baseUrl}/search`;
    const body = {
      query: params.query,
      limit: params.limit,
      location: params.location,
      scrapeOptions: params.scrape_options,
    };

    const result = await this.makeRequest<FirecrawlSearchResponse>(url, body);

    // 存入缓存
    FirecrawlClient.searchCache.set(cacheKey, {
      data: result,
      timestamp: now,
      expiresAt: now + FirecrawlClient.CACHE_TTL,
    });

    // 限制缓存大小
    FirecrawlClient.limitCacheSize(FirecrawlClient.searchCache);

    log("debug", "💾 Cached Firecrawl search result", {
      query: params.query,
      cacheSize: FirecrawlClient.searchCache.size,
    });

    return result;
  }

  /**
   * 抓取单个 URL（带缓存）
   */
  async scrape(params: FirecrawlScrapeParams): Promise<FirecrawlScrapeResponse> {
    // 生成缓存键（包含 URL 和格式）
    const cacheKey = JSON.stringify({
      url: params.url,
      formats: params.formats || ["markdown"],
      location: params.location,
    });

    // 检查缓存
    const cached = FirecrawlClient.scrapeCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && now < cached.expiresAt) {
      log("info", "🔄 Using cached Firecrawl scrape result", {
        url: params.url.substring(0, 100),
        age: now - cached.timestamp,
        cacheSize: FirecrawlClient.scrapeCache.size,
      });
      return cached.data;
    }

    // 执行实际抓取
    const url = `${this.config.baseUrl}/scrape`;
    const body = {
      url: params.url,
      formats: params.formats || ["markdown"],
      location: params.location,
    };

    const result = await this.makeRequest<FirecrawlScrapeResponse>(url, body);

    // 存入缓存
    FirecrawlClient.scrapeCache.set(cacheKey, {
      data: result,
      timestamp: now,
      expiresAt: now + FirecrawlClient.CACHE_TTL,
    });

    // 限制缓存大小
    FirecrawlClient.limitCacheSize(FirecrawlClient.scrapeCache);

    log("debug", "💾 Cached Firecrawl scrape result", {
      url: params.url.substring(0, 100),
      cacheSize: FirecrawlClient.scrapeCache.size,
    });

    return result;
  }

  /**
   * 批量抓取多个 URL
   */
  async batchScrape(params: FirecrawlBatchScrapeParams): Promise<FirecrawlScrapeResponse[]> {
    const url = `${this.config.baseUrl}/batch/scrape`;

    const body = {
      urls: params.urls,
      formats: params.formats || ["markdown"],
    };

    const response = await this.makeRequest<{ id: string }>(url, body);

    // 轮询批量任务状态
    const jobId = response.id;
    const pollInterval = params.pollInterval || 1000;
    const waitTimeout = params.waitTimeout || 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < waitTimeout) {
      const statusUrl = `${this.config.baseUrl}/batch/scrape/${jobId}`;
      const statusResponse = await this.makeRequest<{
        status: string;
        data: FirecrawlScrapeResponse[];
      }>(statusUrl, null, "GET");

      if (statusResponse.status === "completed") {
        return statusResponse.data;
      } else if (statusResponse.status === "failed") {
        throw new Error("Batch scrape job failed");
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error("Batch scrape job timeout");
  }

  /**
   * 发起 HTTP 请求，带重试机制
   */
  private async makeRequest<T>(
    url: string,
    body: unknown,
    method: "GET" | "POST" = "POST",
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const options: RequestInit = {
          method,
          headers: {
            "Authorization": `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        };

        if (body && method === "POST") {
          options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();

          // 429 错误（速率限制）需要重试
          if (response.status === 429) {
            const retryAfter = response.headers.get("Retry-After");
            const delay = retryAfter
              ? parseInt(retryAfter) * 1000
              : this.config.retryDelay;

            if (attempt < this.config.maxRetries) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
          }

          // 5xx 错误（服务端错误）可以重试
          if (response.status >= 500 && attempt < this.config.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.config.retryDelay)
            );
            continue;
          }

          throw new Error(
            `Firecrawl API error (${response.status}): ${errorText}`,
          );
        }

        const data = await response.json();
        return data as T;
      } catch (error) {
        lastError = error as Error;

        // 网络超时或网络错误，可以重试
        if (
          (error instanceof Error &&
            (error.name === "AbortError" || error.message.includes("fetch"))) &&
          attempt < this.config.maxRetries
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.retryDelay)
          );
          continue;
        }

        // 其他错误直接抛出
        throw error;
      }
    }

    throw lastError || new Error("Unknown error in Firecrawl API request");
  }
}
