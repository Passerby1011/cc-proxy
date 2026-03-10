/// <reference lib="deno.ns" />

// 单个上游渠道的配置。
export interface ChannelConfig {
  name: string; 
  baseUrl: string;
  apiKey?: string;
  protocol?: "openai" | "openai-responses" | "anthropic"; 
  autoTrigger?: boolean; 
  supportsNativeToolCalling?: boolean; 
  supportsSystemPrompt?: boolean; 
}

// 工具调用纠错重试配置。
export interface ToolCallRetryConfig {
  enabled: boolean; 
  maxRetries: number; 
  timeout: number; 
  strategy: "correction"; 
  keepAlive: boolean; 
  promptTemplate?: string; 
}

// Firecrawl 相关配置。
export interface FirecrawlConfig {
  apiKey: string; 
  baseUrl: string; 
  timeout: number; 
  maxRetries: number; 
  retryDelay: number; 
}

// Web 工具拦截与深度浏览配置。
export interface WebToolsConfig {
  enableSearchIntercept: boolean; 
  enableFetchIntercept: boolean; 
  searchMode: "simple" | "smart"; 
  autoTrigger: boolean; 
  deepBrowseEnabled: boolean; 
  deepBrowseCount: number; 
  deepBrowsePageContentLimit: number; 
  maxSearchResults: number; 
  maxFetchContentTokens: number; 
}

// 代理服务的完整运行配置。
export interface ProxyConfig {
  port: number;
  host: string;
  channelConfigs: ChannelConfig[]; 
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamModelOverride?: string;
  clientApiKey?: string;
  requestTimeoutMs: number;
  aggregationIntervalMs: number;
  maxRequestsPerMinute: number;
  tokenMultiplier: number;
  autoPort: boolean;
  passthroughApiKey: boolean; 
  defaultProtocol: "openai" | "openai-responses" | "anthropic"; 
  adminApiKey?: string;
  pgStoreDsn?: string;
  configFilePath?: string;
  toolCallRetry?: ToolCallRetryConfig;
  firecrawl?: FirecrawlConfig;
  webTools?: WebToolsConfig;
}

export interface ConfigStorage {
  load(): Promise<Partial<ProxyConfig>>;
  save(config: Partial<ProxyConfig>): Promise<void>;
  healthCheck(): Promise<boolean>;
}

// 解析 token 倍率配置，兼容百分比和 x 倍写法。
function parseTokenMultiplier(raw: string | undefined): number {
  if (!raw) return 1.0;

  let s = raw.trim();
  if (!s) return 1.0;

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  if (s.endsWith("%")) {
    const num = parseFloat(s.slice(0, -1));
    if (Number.isFinite(num) && num > 0) {
      return num / 100;
    }
  }

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

// 根据 URL、模型名和默认值推断上游协议。
export function detectProtocol(
  baseUrl: string,
  defaultProtocol: "openai" | "openai-responses" | "anthropic",
): "openai" | "openai-responses" | "anthropic" {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname;

    if (path.endsWith("/v1/chat/completions")) {
      return "openai";
    }
    if (path.endsWith("/v1/responses")) {
      return "openai-responses";
    }
    if (path.endsWith("/v1/messages")) {
      return "anthropic";
    }
  } catch (_e) {
    if (baseUrl.includes("/v1/chat/completions")) {
      return "openai";
    }
    if (baseUrl.includes("/v1/responses")) {
      return "openai-responses";
    }
    if (baseUrl.includes("/v1/messages")) {
      return "anthropic";
    }
  }

  return defaultProtocol;
}

// 从环境变量加载渠道配置列表。
function loadChannelConfigs(
  defaultProtocol: "openai" | "openai-responses" | "anthropic",
): ChannelConfig[] {
  const configs: ChannelConfig[] = [];
  let i = 1;
  while (true) {
    const name = Deno.env.get(`CHANNEL_${i}_NAME`);
    const baseUrl = Deno.env.get(`CHANNEL_${i}_BASE_URL`);
    const apiKey = Deno.env.get(`CHANNEL_${i}_API_KEY`);
    const rawProtocol = Deno.env.get(`CHANNEL_${i}_PROTOCOL`);
    const rawAutoTrigger = Deno.env.get(`CHANNEL_${i}_AUTO_TRIGGER`);
    const rawSupportsNativeToolCalling = Deno.env.get(`CHANNEL_${i}_SUPPORTS_NATIVE_TOOL_CALLING`);
    const rawSupportsSystemPrompt = Deno.env.get(`CHANNEL_${i}_SUPPORTS_SYSTEM_PROMPT`);

    if (!name || !baseUrl) {
      break;
    }

    const protocol = (rawProtocol as "openai" | "openai-responses" | "anthropic") ||
      detectProtocol(baseUrl, defaultProtocol);

    let autoTrigger: boolean | undefined;
    if (rawAutoTrigger === "true") {
      autoTrigger = true;
    } else if (rawAutoTrigger === "false") {
      autoTrigger = false;
    }

    let supportsNativeToolCalling: boolean | undefined;
    if (rawSupportsNativeToolCalling === "true") {
      supportsNativeToolCalling = true;
    } else if (rawSupportsNativeToolCalling === "false") {
      supportsNativeToolCalling = false;
    }

    let supportsSystemPrompt: boolean | undefined;
    if (rawSupportsSystemPrompt === "true") {
      supportsSystemPrompt = true;
    } else if (rawSupportsSystemPrompt === "false") {
      supportsSystemPrompt = false;
    }

    configs.push({
      name,
      baseUrl,
      apiKey,
      protocol,
      autoTrigger,
      supportsNativeToolCalling,
      supportsSystemPrompt,
    });
    i++;
  }
  return configs;
}

// 从环境变量构建完整代理配置。
export function loadConfig(): ProxyConfig {
  const adminApiKey = Deno.env.get("ADMIN_API_KEY");
  const pgStoreDsn = Deno.env.get("PGSTORE_DSN");
  const configFilePath = Deno.env.get("CONFIG_FILE_PATH");

  const autoPort = Deno.env.get("AUTO_PORT") === "true";

  const port = autoPort ? 0 : Number(Deno.env.get("PORT") ?? "3456");
  const host = Deno.env.get("HOST") ?? "0.0.0.0";
  const clientApiKey = Deno.env.get("CLIENT_API_KEY");
  const requestTimeoutMs = Number(Deno.env.get("TIMEOUT_MS") ?? "120000");
  const aggregationIntervalMs = Number(Deno.env.get("AGGREGATION_INTERVAL_MS") ?? "35");
  const maxRequestsPerMinute = Number(Deno.env.get("MAX_REQUESTS_PER_MINUTE") ?? "10");
  const tokenMultiplier = parseTokenMultiplier(Deno.env.get("TOKEN_MULTIPLIER"));

  const passthroughApiKey = Deno.env.get("PASSTHROUGH_API_KEY") === "true";

  const defaultProtocol = (Deno.env.get("UPSTREAM_PROTOCOL") ?? "openai") as
    | "openai"
    | "openai-responses"
    | "anthropic";

  const channelConfigs = loadChannelConfigs(defaultProtocol);

  let upstreamBaseUrl: string | undefined;
  let upstreamApiKey: string | undefined;
  let upstreamModelOverride: string | undefined;

  if (channelConfigs.length === 0) {
    upstreamBaseUrl = Deno.env.get("UPSTREAM_BASE_URL") ??
      "http://127.0.0.1:8000/v1/chat/completions";
    upstreamApiKey = Deno.env.get("UPSTREAM_API_KEY");
    upstreamModelOverride = Deno.env.get("UPSTREAM_MODEL");
  }

  const toolCallRetryEnabled = Deno.env.get("TOOL_RETRY_ENABLED") === "true";
  let toolCallRetry: ToolCallRetryConfig | undefined;

  if (toolCallRetryEnabled) {
    toolCallRetry = {
      enabled: true,
      maxRetries: Number(Deno.env.get("TOOL_RETRY_MAX_RETRIES") ?? "1"),
      timeout: Number(Deno.env.get("TOOL_RETRY_TIMEOUT") ?? "30000"),
      strategy: "correction",
      keepAlive: Deno.env.get("TOOL_RETRY_KEEP_ALIVE") !== "false", 
      promptTemplate: Deno.env.get("TOOL_RETRY_PROMPT_TEMPLATE"),
    };
  }

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

  let webTools: WebToolsConfig | undefined;

  const enableSearchIntercept = Deno.env.get("ENABLE_WEB_SEARCH_INTERCEPT") === "true";
  const enableFetchIntercept = Deno.env.get("ENABLE_WEB_FETCH_INTERCEPT") === "true";

  if (enableSearchIntercept || enableFetchIntercept) {
    webTools = {
      enableSearchIntercept,
      enableFetchIntercept,
      searchMode: (Deno.env.get("WEB_SEARCH_MODE") ?? "smart") as "simple" | "smart",
      autoTrigger: Deno.env.get("WEB_TOOLS_AUTO_TRIGGER") !== "false", 
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

// 解析是否自动触发 Web 工具，并返回实际模型名与渠道名。
export function resolveAutoTrigger(
  modelName: string,
  channelConfigs: ChannelConfig[],
  globalAutoTrigger: boolean,
): { autoTrigger: boolean; actualModelName: string; channelName?: string } {
  if (modelName.startsWith("cc+")) {
    const rest = modelName.slice(3); 
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
    const rest = modelName.slice(5); 
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

  return { autoTrigger: globalAutoTrigger, actualModelName: modelName };
}
