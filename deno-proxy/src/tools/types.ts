// Firecrawl API 绫诲瀷瀹氫箟

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

// Anthropic Web Search/Fetch 绫诲瀷瀹氫箟

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

export interface OpenAIWebSearchToolDefinition {
  type: "web_search_preview" | "web_search";
  user_location?: string | Record<string, unknown>;
  allowed_domains?: string[];
  blocked_domains?: string[];
  domains?: string[];
  filters?: {
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
}

export interface OpenAIWebFetchToolDefinition {
  type: "web_fetch" | "web_fetch_preview";
  name?: "web_fetch";
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

// 宸ュ叿鎷︽埅鍣ㄩ厤缃?

export interface WebToolsConfig {
  enableSearchIntercept: boolean;
  enableFetchIntercept: boolean;
  searchMode: "simple" | "smart";
  autoTrigger: boolean; // 鏄惁鑷姩瑙﹀彂锛坱rue=鐪嬪埌宸ュ叿灏辨墽琛岋紝false=绛堿I璋冪敤锛?
  deepBrowseEnabled: boolean; // 鏄惁鍚敤娣卞叆娴忚
  deepBrowseCount: number; // 娣卞叆娴忚鐨勯〉闈㈡暟閲忥紙1-5锛?
  deepBrowsePageContentLimit: number; // 娣卞叆娴忚姣忎釜椤甸潰鍐呭瀛楃鏁伴檺鍒?
  maxSearchResults: number; // 鏈€澶ф悳绱㈢粨鏋滄暟閲?
  maxFetchContentTokens: number; // Web Fetch 鍐呭鏈€澶?token 鏁?
}

export interface FirecrawlConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
}

// 鍐呴儴浣跨敤鐨勭被鍨?

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

// 鏅鸿兘妯″紡鎷︽埅缁撴灉锛堝寘鍚?LLM 鍒嗘瀽锛?
export interface SmartSearchInterceptResult {
  serverToolUse: AnthropicServerToolUse;
  llmAnalysis: {
    type: "text";
    text: string;
  };
  toolResult: AnthropicWebSearchToolResult;
}

// 涓婃父 API 淇℃伅锛堢敤浜庢櫤鑳芥ā寮忥級
export interface UpstreamInfo {
  baseUrl: string;
  apiKey?: string;
  model: string;
  protocol: "openai" | "openai-responses" | "anthropic";
}

function normalizeLocation(location: unknown): string | undefined {
  if (!location) return undefined;
  if (typeof location === "string") return location;
  if (typeof location !== "object") return undefined;

  const value = location as Record<string, unknown>;
  const parts = [value.city, value.region, value.country]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);

  return parts.length > 0 ? parts.join(", ") : undefined;
}

export function isAnthropicWebSearchTool(tool: unknown): tool is AnthropicWebSearchToolDefinition {
  return !!tool && typeof tool === "object" &&
    (tool as Record<string, unknown>).type === "web_search_20250305";
}

export function isAnthropicWebFetchTool(tool: unknown): tool is AnthropicWebFetchToolDefinition {
  return !!tool && typeof tool === "object" &&
    (tool as Record<string, unknown>).type === "web_fetch_20250910";
}

export function isOpenAIWebSearchTool(tool: unknown): tool is OpenAIWebSearchToolDefinition {
  if (!tool || typeof tool !== "object") return false;
  const type = (tool as Record<string, unknown>).type;
  return type === "web_search_preview" || type === "web_search";
}

export function isOpenAIWebFetchTool(tool: unknown): tool is OpenAIWebFetchToolDefinition {
  if (!tool || typeof tool !== "object") return false;
  const type = (tool as Record<string, unknown>).type;
  return type === "web_fetch" || type === "web_fetch_preview";
}

export function isAnyWebSearchTool(tool: unknown): boolean {
  return isAnthropicWebSearchTool(tool) || isOpenAIWebSearchTool(tool);
}

export function isAnyWebFetchTool(tool: unknown): boolean {
  return isAnthropicWebFetchTool(tool) || isOpenAIWebFetchTool(tool);
}

export function openAIWebSearchToolToAnthropic(
  tool: OpenAIWebSearchToolDefinition,
): AnthropicWebSearchToolDefinition {
  return {
    type: "web_search_20250305",
    name: "web_search",
    user_location: normalizeLocation(tool.user_location),
    allowed_domains: tool.allowed_domains ?? tool.domains ?? tool.filters?.allowed_domains,
    blocked_domains: tool.blocked_domains ?? tool.filters?.blocked_domains,
  };
}

export function openAIWebFetchToolToAnthropic(
  _tool: OpenAIWebFetchToolDefinition,
): AnthropicWebFetchToolDefinition {
  return {
    type: "web_fetch_20250910",
    name: "web_fetch",
  };
}
