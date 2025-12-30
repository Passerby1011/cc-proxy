import { serve } from "https://deno.land/std/http/server.ts";
import { loadConfig, ProxyConfig } from "./config.ts";
import { log, logRequest, closeRequestLog } from "./logging.ts";
import { forwardRequest } from "./upstream.ts";
import { SSEWriter } from "./sse.ts";
import { ClaudeRequest } from "./types.ts";
import { RateLimiter } from "./rate_limiter.ts";
import { countTokens } from "./token_counter.ts";

const config = loadConfig();
const rateLimiter = new RateLimiter(config.maxRequestsPerMinute, 60_000);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized() {
  return jsonResponse({ error: "unauthorized" }, 401);
}

function extractClientApiKey(req: Request): string | undefined {
  const header = req.headers.get("x-api-key") || req.headers.get("authorization");
  if (!header) return undefined;
  let key: string;
  if (header.startsWith("Bearer ")) {
    key = header.slice(7).trim();
  } else {
    key = header.trim();
  }
  return key || undefined;
}

function validateClientKey(req: Request, config: ProxyConfig): boolean {
  if (!config.clientApiKey) return true;
  const clientKey = extractClientApiKey(req);
  if (!clientKey) return false;
  return clientKey === config.clientApiKey;
}

async function handleMessages(req: Request, requestId: string) {
  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  let body: ClaudeRequest;
  try {
    const rawBody = await req.text();
    body = JSON.parse(rawBody);
    await logRequest(requestId, "debug", "Received Claude request body", {
      rawPreview: body,
    });
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  try {
    await rateLimiter.acquire();

    // 提取可能需要透传的客户端 API key
    const rawClientKey = extractClientApiKey(req);
    const clientApiKey = (config.passthroughApiKey && rawClientKey && rawClientKey !== config.clientApiKey)
      ? rawClientKey
      : undefined;

    // 判断是否为流式请求
    const isStream = body.stream !== false;

    if (isStream) {
      // 创建响应流
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const writer = new SSEWriter(controller, requestId);
          try {
            // 调用统一的转发逻辑
            await forwardRequest(body, writer, config, requestId, clientApiKey);
            await logRequest(requestId, "info", "Completed processing request", {});
          } catch (error) {
            await logRequest(requestId, "error", "Request handling failure", { error: String(error) });
            // 如果流还没关闭，尝试发送错误信息
            try {
              await writer.send({
                event: "error",
                data: { error: { type: "api_error", message: String(error) } },
              }, true);
            } catch {
              // 忽略发送错误的错误
            }
            controller.error(error);
          } finally {
            await closeRequestLog(requestId);
            writer.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    } else {
      // 非流式请求：直接等待 forwardRequest 完成并返回 JSON
      try {
        // forwardRequest 需要改造以支持非流式返回数据
        const result = await forwardRequest(body, undefined, config, requestId, clientApiKey);
        await logRequest(requestId, "info", "Completed non-streaming request", {});
        return jsonResponse(result);
      } catch (error) {
        await logRequest(requestId, "error", "Non-streaming request handling failure", {
          error: String(error),
        });
        return jsonResponse({ error: { type: "api_error", message: String(error) } }, 500);
      } finally {
        await closeRequestLog(requestId);
      }
    }
  } catch (error) {
    await logRequest(requestId, "error", "Failed to setup request stream", { error: String(error) });
    await closeRequestLog(requestId);
    return jsonResponse({ error: "internal_error", details: String(error) }, 500);
  }
}

async function handleTokenCount(req: Request, requestId: string) {
  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  let body: ClaudeRequest;
  try {
    const rawBody = await req.text();
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  try {
    const tokenCount = await countTokens(body, config, requestId);
    return jsonResponse({
      input_tokens: tokenCount.input_tokens,
      token_count: tokenCount.token_count,
      tokens: tokenCount.tokens,
      output_tokens: tokenCount.output_tokens,
    });
  } catch (error) {
    await logRequest(requestId, "error", "Failed to count tokens", { error: String(error) });
    await closeRequestLog(requestId);
    return jsonResponse({ error: "token_count_error", details: String(error) }, 500);
  }
}

export const handler = (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/") {
    const html = `<!DOCTYPE html><html><head><title>cc-proxy</title></head><body><h1>cc-proxy Server</h1><p>Server is running</p></body></html>`;
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({ status: "ok" });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-api-key",
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const requestId = crypto.randomUUID();
    log("info", "Handling Claude message", { requestId });
    return handleMessages(req, requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const requestId = crypto.randomUUID();
    log("info", "Handling token count", { requestId });
    return handleTokenCount(req, requestId);
  }

  return new Response("Not Found", { status: 404 });
};

if (import.meta.main) {
  serve(handler, config.autoPort ? undefined : { hostname: config.host, port: config.port });
}
