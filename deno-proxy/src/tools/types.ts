// Firecrawl API 类型定义

export interface FirecrawlSearchParams {
  query: string;
  limit?: number;
  location?: string;
  scrape_options?: {
    formats?: string[];
  };
}

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description?: string;
  markdown?: string;
  html?: string;
}

export interface FirecrawlSearchResponse {
  success: boolean;
  data: {
    web: FirecrawlSearchResult[];
  };
  credits_used?: number;
}

export interface FirecrawlScrapeParams {
  url: string;
  formats?: string[];
  location?: string;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
      language?: string;
      [key: string]: unknown;
    };
  };
  credits_used?: number;
}

export interface FirecrawlBatchScrapeParams {
  urls: string[];
  formats?: string[];
  pollInterval?: number;
  waitTimeout?: number;
}

// Anthropic Web Search/Fetch 类型定义

export interface AnthropicWebSearchToolDefinition {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number;
  user_location?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface AnthropicWebFetchToolDefinition {
  type: "web_fetch_20250910";
  name: "web_fetch";
}

export interface AnthropicServerToolUse {
  type: "server_tool_use";
  id: string;
  name: "web_search" | "web_fetch";
  input: {
    query?: string;
    url?: string;
  };
}

export interface AnthropicWebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string;
}

export interface AnthropicWebSearchToolResult {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: AnthropicWebSearchResult[];
}

export interface AnthropicDocumentSource {
  type: "text" | "base64";
  media_type: "text/plain" | "application/pdf";
  data: string;
}

export interface AnthropicDocument {
  type: "document";
  source: AnthropicDocumentSource;
  title?: string;
  context?: string;
  retrieved_at?: string;
}

export interface AnthropicWebFetchToolResult {
  type: "web_fetch_tool_result";
  tool_use_id: string;
  content: AnthropicDocument[];
}

export interface AnthropicCitation {
  type: "web_search_result_location" | "char_location";
  url?: string;
  title?: string;
  cited_text?: string;
  encrypted_index?: string;
  start_char_index?: number;
  end_char_index?: number;
}

// 工具拦截器配置

export interface WebToolsConfig {
  enableSearchIntercept: boolean;
  enableFetchIntercept: boolean;
  searchMode: "simple" | "smart";
  autoTrigger: boolean;                   // 是否自动触发（true=看到工具就执行，false=等AI调用）
  deepBrowseEnabled: boolean;             // 是否启用深入浏览
  deepBrowseCount: number;                // 深入浏览的页面数量（1-5）
  deepBrowsePageContentLimit: number;     // 深入浏览每个页面内容字符数限制
  maxSearchResults: number;               // 最大搜索结果数量
  maxFetchContentTokens: number;          // Web Fetch 内容最大 token 数
}

export interface FirecrawlConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
}

// 内部使用的类型

export interface InterceptContext {
  requestId: string;
  toolDefinition: AnthropicWebSearchToolDefinition | AnthropicWebFetchToolDefinition;
  messages: unknown[];
  config: WebToolsConfig & { firecrawl: FirecrawlConfig };
}

export interface SearchInterceptResult {
  serverToolUse: AnthropicServerToolUse;
  toolResult: AnthropicWebSearchToolResult;
}

export interface FetchInterceptResult {
  serverToolUse: AnthropicServerToolUse;
  toolResult: AnthropicWebFetchToolResult;
}

// 智能模式拦截结果（包含 LLM 分析）
export interface SmartSearchInterceptResult {
  serverToolUse: AnthropicServerToolUse;
  llmAnalysis: {
    type: "text";
    text: string;
  };
  toolResult: AnthropicWebSearchToolResult;
}

// 上游 API 信息（用于智能模式）
export interface UpstreamInfo {
  baseUrl: string;
  apiKey?: string;
  model: string;
  protocol: "openai" | "anthropic";
}
