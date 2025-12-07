export interface ProxyConfig {
  port: number;
  host: string;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  upstreamModelOverride?: string;
  clientApiKey?: string;
  requestTimeoutMs: number;
  aggregationIntervalMs: number;
  maxRequestsPerMinute: number;
}

export function loadConfig(): ProxyConfig {
  const upstreamBaseUrl = Deno.env.get("UPSTREAM_BASE_URL") ?? "http://127.0.0.1:8000/v1/chat/completions";
  if (!upstreamBaseUrl) {
    throw new Error("UPSTREAM_BASE_URL must be provided");
  }

  const port = Number(Deno.env.get("PORT") ?? "3456");
  const host = Deno.env.get("HOST") ?? "0.0.0.0";
  const upstreamApiKey = Deno.env.get("UPSTREAM_API_KEY");
  const upstreamModelOverride = Deno.env.get("UPSTREAM_MODEL");
  const clientApiKey = Deno.env.get("CLIENT_API_KEY");
  const requestTimeoutMs = Number(Deno.env.get("TIMEOUT_MS") ?? "120000");
  const aggregationIntervalMs = Number(Deno.env.get("AGGREGATION_INTERVAL_MS") ?? "35");
  const maxRequestsPerMinute = Number(Deno.env.get("MAX_REQUESTS_PER_MINUTE") ?? "10");

  return {
    port,
    host,
    upstreamBaseUrl,
    upstreamApiKey,
    upstreamModelOverride,
    clientApiKey,
    requestTimeoutMs,
    aggregationIntervalMs,
    maxRequestsPerMinute,
  };
}
