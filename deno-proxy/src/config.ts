/// <reference lib="deno.ns" />

export interface ChannelConfig {
  name: string; // 渠道名称，用于 channel+model 格式
  baseUrl: string;
  apiKey?: string;
  protocol?: "openai" | "anthropic"; // 渠道协议类型，默认为 openai
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

function loadChannelConfigs(): ChannelConfig[] {
  const configs: ChannelConfig[] = [];
  let i = 1;
  while (true) {
    const name = Deno.env.get(`CHANNEL_${i}_NAME`);
    const baseUrl = Deno.env.get(`CHANNEL_${i}_BASE_URL`);
    const apiKey = Deno.env.get(`CHANNEL_${i}_API_KEY`);
    const protocol = (Deno.env.get(`CHANNEL_${i}_PROTOCOL`) || "openai") as "openai" | "anthropic";
    if (!name || !baseUrl) {
      // 如果缺少必要字段，停止搜索
      break;
    }
    configs.push({
      name,
      baseUrl,
      apiKey,
      protocol,
    });
    i++;
  }
  return configs;
}

export function loadConfig(): ProxyConfig {
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
  const channelConfigs = loadChannelConfigs();

  // 向后兼容：如果未设置任何渠道配置，则使用旧的环境变量
  let upstreamBaseUrl: string | undefined;
  let upstreamApiKey: string | undefined;
  let upstreamModelOverride: string | undefined;

  if (channelConfigs.length === 0) {
    upstreamBaseUrl = Deno.env.get("UPSTREAM_BASE_URL") ?? "http://127.0.0.1:8000/v1/chat/completions";
    upstreamApiKey = Deno.env.get("UPSTREAM_API_KEY");
    upstreamModelOverride = Deno.env.get("UPSTREAM_MODEL");
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
  };
}
