/// <reference lib="deno.ns" />

export interface ChannelConfig {
  name: string; // 渠道名称，用于 channel+model 格式
  baseUrl: string;
  apiKey?: string;
  protocol?: "openai" | "anthropic"; // 渠道协议类型，默认为 openai
  autoTrigger?: boolean; // 渠道级拦截触发模式（可选，未设置则使用全局配置）
}

export interface ToolCallRetryConfig {
  enabled: boolean;              // 是否启用重试（默认 false）
  maxRetries: number;            // 最大重试次数（默认 1）
  timeout: number;               // 单次重试超时（默认 30000ms）
  strategy: 'correction';        // 固定使用修正提示策略
  keepAlive: boolean;            // 重试期间保持连接（默认 true）
  promptTemplate?: string;       // 自定义修正提示模板
}

export interface FirecrawlConfig {
  apiKey: string;                // Firecrawl API 密钥
  baseUrl: string;               // Firecrawl API 基础 URL
  timeout: number;               // 请求超时时间（ms）
  maxRetries: number;            // 最大重试次数
  retryDelay: number;            // 重试延迟（ms）
}

export interface WebToolsConfig {
  enableSearchIntercept: boolean;  // 是否启用 Web Search 拦截
  enableFetchIntercept: boolean;   // 是否启用 Web Fetch 拦截
  searchMode: "simple" | "smart";  // Web Search 工作模式
  autoTrigger: boolean;            // 是否自动触发（true=看到工具就执行，false=等AI调用）
  deepBrowseEnabled: boolean;      // 是否启用深入浏览（智能模式）
  deepBrowseCount: number;         // 深入浏览的页面数量（1-5）
  deepBrowsePageContentLimit: number; // 深入浏览每个页面内容字符数限制（默认 5000）
  maxSearchResults: number;        // 最大搜索结果数量
  maxFetchContentTokens: number;   // Web Fetch 内容最大 token 数
}

export interface ProxyConfig {
  port: number;
  host: string;
  channelConfigs: ChannelConfig[]; // 渠道配置，用于 channel+model 格式
  // 向后兼容的旧字段（如果未设置渠道配置则使用）
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamModelOverride?: string;
  clientApiKey?: string;
  requestTimeoutMs: number;
  aggregationIntervalMs: number;
  maxRequestsPerMinute: number;
  tokenMultiplier: number;
  autoPort: boolean;
  passthroughApiKey: boolean; // 是否将客户端 API key 透传给上游
  defaultProtocol: "openai" | "anthropic"; // 默认上游协议
  // Web UI 管理配置
  adminApiKey?: string;
  pgStoreDsn?: string;
  configFilePath?: string;
  // 工具调用重试配置
  toolCallRetry?: ToolCallRetryConfig;
  // Firecrawl 配置
  firecrawl?: FirecrawlConfig;
  // Web Search/Fetch 配置
  webTools?: WebToolsConfig;
}

/**
 * 存储层接口定义
 */
export interface ConfigStorage {
  load(): Promise<Partial<ProxyConfig>>;
  save(config: Partial<ProxyConfig>): Promise<void>;
  healthCheck(): Promise<boolean>;
}

// 解析 TOKEN_MULTIPLIER，兼容常见字符串形式：
// - "1.2" / "0.8"
// - "1.2x" / "x1.2"
// - "120%" （表示 1.2）
// - 带引号或空格的写法："'1.2'" / " 1.2 "
function parseTokenMultiplier(raw: string | undefined): number {
  if (!raw) return 1.0;

  let s = raw.trim();
  if (!s) return 1.0;

  // 去掉包裹的引号
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  // 支持百分号写法：120% -> 1.2
  if (s.endsWith("%")) {
    const num = parseFloat(s.slice(0, -1));
    if (Number.isFinite(num) && num > 0) {
      return num / 100;
    }
  }

  // 支持带 x 的写法：1.2x / x1.2
  if (s.toLowerCase().endsWith("x")) {
    s = s.slice(0, -1).trim();
  } else if (s.toLowerCase().startsWith("x")) {
    s = s.slice(1).trim();
  }

  const num = parseFloat(s);
  if (!Number.isFinite(num) || num <= 0) {
    return 1.0;
  }
  return num;
}

/**
 * 根据 URL 自动识别协议类型
 */
export function detectProtocol(
  baseUrl: string,
  defaultProtocol: "openai" | "anthropic",
): "openai" | "anthropic" {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname;

    if (path.endsWith("/v1/chat/completions")) {
      return "openai";
    }
    if (path.endsWith("/v1/messages")) {
      return "anthropic";
    }
  } catch (_e) {
    // 如果 URL 解析失败，尝试简单的字符串匹配
    if (baseUrl.includes("/v1/chat/completions")) {
      return "openai";
    }
    if (baseUrl.includes("/v1/messages")) {
      return "anthropic";
    }
  }

  return defaultProtocol;
}

function loadChannelConfigs(defaultProtocol: "openai" | "anthropic"): ChannelConfig[] {
  const configs: ChannelConfig[] = [];
  let i = 1;
  while (true) {
    const name = Deno.env.get(`CHANNEL_${i}_NAME`);
    const baseUrl = Deno.env.get(`CHANNEL_${i}_BASE_URL`);
    const apiKey = Deno.env.get(`CHANNEL_${i}_API_KEY`);
    const rawProtocol = Deno.env.get(`CHANNEL_${i}_PROTOCOL`);
    const rawAutoTrigger = Deno.env.get(`CHANNEL_${i}_AUTO_TRIGGER`);

    if (!name || !baseUrl) {
      // 如果缺少必要字段，停止搜索
      break;
    }

    // 自动识别协议
    const protocol = (rawProtocol as "openai" | "anthropic") ||
      detectProtocol(baseUrl, defaultProtocol);

    // 解析 autoTrigger（可选配置）
    let autoTrigger: boolean | undefined;
    if (rawAutoTrigger === "true") {
      autoTrigger = true;
    } else if (rawAutoTrigger === "false") {
      autoTrigger = false;
    }
    // 如果未设置，保持 undefined，使用全局配置

    configs.push({
      name,
      baseUrl,
      apiKey,
      protocol,
      autoTrigger,
    });
    i++;
  }
  return configs;
}

export function loadConfig(): ProxyConfig {
  const adminApiKey = Deno.env.get("ADMIN_API_KEY");
  const pgStoreDsn = Deno.env.get("PGSTORE_DSN");
  const configFilePath = Deno.env.get("CONFIG_FILE_PATH");

  // 检查是否启用自动端口配置
  const autoPort = Deno.env.get("AUTO_PORT") === "true";
  
  // 如果启用自动端口，则使用 0 让系统自动分配端口
  // 否则使用环境变量指定的端口或默认端口 3456
  const port = autoPort ? 0 : Number(Deno.env.get("PORT") ?? "3456");
  const host = Deno.env.get("HOST") ?? "0.0.0.0";
  const clientApiKey = Deno.env.get("CLIENT_API_KEY");
  const requestTimeoutMs = Number(Deno.env.get("TIMEOUT_MS") ?? "120000");
  const aggregationIntervalMs = Number(Deno.env.get("AGGREGATION_INTERVAL_MS") ?? "35");
  const maxRequestsPerMinute = Number(Deno.env.get("MAX_REQUESTS_PER_MINUTE") ?? "10");
  // 解析 tokenMultiplier，并对非法值进行兜底，避免出现 NaN/Infinity
  const tokenMultiplier = parseTokenMultiplier(Deno.env.get("TOKEN_MULTIPLIER"));

  // 是否透传客户端 API key
  const passthroughApiKey = Deno.env.get("PASSTHROUGH_API_KEY") === "true";

  // 默认协议
  const defaultProtocol = (Deno.env.get("UPSTREAM_PROTOCOL") ?? "openai") as "openai" | "anthropic";

  // 加载渠道配置
  const channelConfigs = loadChannelConfigs(defaultProtocol);

  // 向后兼容：如果未设置任何渠道配置，则使用旧的环境变量
  let upstreamBaseUrl: string | undefined;
  let upstreamApiKey: string | undefined;
  let upstreamModelOverride: string | undefined;

  if (channelConfigs.length === 0) {
    upstreamBaseUrl = Deno.env.get("UPSTREAM_BASE_URL") ??
      "http://127.0.0.1:8000/v1/chat/completions";
    upstreamApiKey = Deno.env.get("UPSTREAM_API_KEY");
    upstreamModelOverride = Deno.env.get("UPSTREAM_MODEL");
  }

  // 加载工具调用重试配置
  const toolCallRetryEnabled = Deno.env.get("TOOL_RETRY_ENABLED") === "true";
  let toolCallRetry: ToolCallRetryConfig | undefined;

  if (toolCallRetryEnabled) {
    toolCallRetry = {
      enabled: true,
      maxRetries: Number(Deno.env.get("TOOL_RETRY_MAX_RETRIES") ?? "1"),
      timeout: Number(Deno.env.get("TOOL_RETRY_TIMEOUT") ?? "30000"),
      strategy: 'correction',
      keepAlive: Deno.env.get("TOOL_RETRY_KEEP_ALIVE") !== "false", // 默认 true
      promptTemplate: Deno.env.get("TOOL_RETRY_PROMPT_TEMPLATE"),
    };
  }

  // 加载 Firecrawl 配置
  const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY");
  let firecrawl: FirecrawlConfig | undefined;

  if (firecrawlApiKey) {
    firecrawl = {
      apiKey: firecrawlApiKey,
      baseUrl: Deno.env.get("FIRECRAWL_BASE_URL") ?? "https://api.firecrawl.dev/v2",
      timeout: Number(Deno.env.get("FIRECRAWL_TIMEOUT") ?? "30000"),
      maxRetries: Number(Deno.env.get("FIRECRAWL_MAX_RETRIES") ?? "3"),
      retryDelay: Number(Deno.env.get("FIRECRAWL_RETRY_DELAY") ?? "1000"),
    };
  }

  // 加载 Web Tools 配置
  let webTools: WebToolsConfig | undefined;

  const enableSearchIntercept = Deno.env.get("ENABLE_WEB_SEARCH_INTERCEPT") === "true";
  const enableFetchIntercept = Deno.env.get("ENABLE_WEB_FETCH_INTERCEPT") === "true";

  if (enableSearchIntercept || enableFetchIntercept) {
    webTools = {
      enableSearchIntercept,
      enableFetchIntercept,
      searchMode: (Deno.env.get("WEB_SEARCH_MODE") ?? "smart") as "simple" | "smart",
      autoTrigger: Deno.env.get("WEB_TOOLS_AUTO_TRIGGER") !== "false", // 默认 true，自动触发
      deepBrowseEnabled: Deno.env.get("DEEP_BROWSE_ENABLED") === "true",
      deepBrowseCount: Number(Deno.env.get("DEEP_BROWSE_COUNT") ?? "3"),
      deepBrowsePageContentLimit: Number(Deno.env.get("DEEP_BROWSE_PAGE_CONTENT_LIMIT") ?? "5000"),
      maxSearchResults: Number(Deno.env.get("MAX_SEARCH_RESULTS") ?? "10"),
      maxFetchContentTokens: Number(Deno.env.get("MAX_FETCH_CONTENT_TOKENS") ?? "100000"),
    };
  }

  return {
    port,
    host,
    channelConfigs,
    upstreamBaseUrl,
    upstreamApiKey,
    upstreamModelOverride,
    clientApiKey,
    requestTimeoutMs,
    aggregationIntervalMs,
    maxRequestsPerMinute,
    tokenMultiplier,
    autoPort,
    passthroughApiKey,
    defaultProtocol,
    adminApiKey,
    pgStoreDsn,
    configFilePath,
    toolCallRetry,
    firecrawl,
    webTools,
  };
}

/**
 * 解析模型名并确定最终的 autoTrigger 配置
 * 优先级：模型名前缀 > 渠道配置 > 全局配置
 *
 * @param modelName - 完整的模型名（可能包含 cc+ 或 chat+ 前缀）
 * @param channel - 渠道配置（可选）
 * @param globalAutoTrigger - 全局 autoTrigger 配置
 * @returns { autoTrigger: boolean, actualModelName: string, channelName?: string }
 */
export function resolveAutoTrigger(
  modelName: string,
  channelConfigs: ChannelConfig[],
  globalAutoTrigger: boolean
): { autoTrigger: boolean; actualModelName: string; channelName?: string } {
  // 1. 检查模型名前缀（最高优先级）
  if (modelName.startsWith("cc+")) {
    // cc+ 前缀 → 强制自动触发模式
    const rest = modelName.slice(3); // 移除 "cc+"
    const plusIndex = rest.indexOf("+");
    if (plusIndex !== -1) {
      return {
        autoTrigger: true,
        actualModelName: rest,
        channelName: rest.slice(0, plusIndex),
      };
    }
    return { autoTrigger: true, actualModelName: rest };
  }

  if (modelName.startsWith("chat+")) {
    // chat+ 前缀 → 强制按需拦截模式
    const rest = modelName.slice(5); // 移除 "chat+"
    const plusIndex = rest.indexOf("+");
    if (plusIndex !== -1) {
      return {
        autoTrigger: false,
        actualModelName: rest,
        channelName: rest.slice(0, plusIndex),
      };
    }
    return { autoTrigger: false, actualModelName: rest };
  }

  // 2. 检查渠道配置（次优先级）
  const plusIndex = modelName.indexOf("+");
  if (plusIndex !== -1) {
    const channelName = modelName.slice(0, plusIndex);
    const channel = channelConfigs.find((c) => c.name === channelName);
    if (channel && channel.autoTrigger !== undefined) {
      return {
        autoTrigger: channel.autoTrigger,
        actualModelName: modelName,
        channelName,
      };
    }
  }

  // 3. 使用全局配置（默认）
  return { autoTrigger: globalAutoTrigger, actualModelName: modelName };
}
