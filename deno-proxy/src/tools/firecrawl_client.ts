import type {
  FirecrawlConfig,
  FirecrawlSearchParams,
  FirecrawlSearchResponse,
  FirecrawlScrapeParams,
  FirecrawlScrapeResponse,
  FirecrawlBatchScrapeParams,
} from "./types.ts";

/**
 * Firecrawl API 客户端
 * 封装对 Firecrawl API 的调用，包括搜索和抓取功能
 */
export class FirecrawlClient {
  constructor(private config: FirecrawlConfig) {}

  /**
   * 执行网络搜索
   */
  async search(params: FirecrawlSearchParams): Promise<FirecrawlSearchResponse> {
    const url = `${this.config.baseUrl}/search`;

    const body = {
      query: params.query,
      limit: params.limit,
      location: params.location,
      scrapeOptions: params.scrape_options,
    };

    return await this.makeRequest<FirecrawlSearchResponse>(url, body);
  }

  /**
   * 抓取单个 URL
   */
  async scrape(params: FirecrawlScrapeParams): Promise<FirecrawlScrapeResponse> {
    const url = `${this.config.baseUrl}/scrape`;

    const body = {
      url: params.url,
      formats: params.formats || ["markdown"],
      location: params.location,
    };

    return await this.makeRequest<FirecrawlScrapeResponse>(url, body);
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
