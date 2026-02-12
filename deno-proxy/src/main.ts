import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { loadConfig, ProxyConfig, resolveAutoTrigger } from "./config.ts";
import { log, logRequest, closeRequestLog, logRequestStart, logRequestComplete, logPhase, LogPhase } from "./logging.ts";
import { forwardRequest } from "./upstream.ts";
import { SSEWriter } from "./sse.ts";
import { ClaudeRequest } from "./types.ts";
import { RateLimiter } from "./rate_limiter.ts";
import { countTokens } from "./token_counter.ts";
import { AdminService } from "./admin_service.ts";
import { ToolInterceptor } from "./tools/tool_interceptor.ts";
import { StreamResponseWriter } from "./tools/stream_response_writer.ts";
import { RequestContext } from "./ai_client/mod.ts";
import type { AnthropicWebSearchToolDefinition, AnthropicWebFetchToolDefinition } from "./tools/types.ts";

const initialConfig = loadConfig();
const adminService = new AdminService(initialConfig);
await adminService.init();

// 代理逻辑应始终使用来自 adminService 的最新配置
const getConfig = () => adminService.getCurrentConfig();

const rateLimiter = new RateLimiter(getConfig().maxRequestsPerMinute, 60_000);

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
  // 如果启用了透传模式，跳过客户端密钥验证（以请求密钥为准）
  if (config.passthroughApiKey) return true;

  if (!config.clientApiKey) return true;
  const clientKey = extractClientApiKey(req);
  if (!clientKey) return false;
  return clientKey === config.clientApiKey;
}

async function handleMessages(req: Request, requestId: string) {
  const startTime = Date.now();
  const config = getConfig();
  
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
    // 如果启用透传模式，直接使用请求中的密钥（无视 CLIENT_API_KEY 和渠道密钥）
    const rawClientKey = extractClientApiKey(req);
    const clientApiKey = (config.passthroughApiKey && rawClientKey)
      ? rawClientKey
      : undefined;

    // ============ 新架构：创建 RequestContext ============
    // 在请求入口处创建 RequestContext，封装所有参数解析逻辑
    const context = RequestContext.fromRequest(
      body,
      config,
      requestId,
      clientApiKey,
    );

    // 从上下文获取解析后的信息
    const upstreamConfig = context.getUpstreamConfig();
    const isStream = body.stream === true;

    // 解析模型名并确定 autoTrigger 配置和渠道名（处理 cc+/chat+ 前缀）
    const { autoTrigger: resolvedAutoTrigger, actualModelName, channelName } = resolveAutoTrigger(
      body.model,
      config.channelConfigs,
      config.webTools?.autoTrigger ?? true
    );

    // 使用新的请求开始日志格式
    logRequestStart(requestId, {
      model: body.model,
      tools: body.tools?.length,
      stream: body.stream === true,
      channel: channelName,
      autoTrigger: resolvedAutoTrigger,
    });

    // 检查是否需要拦截 Web Search/Fetch 工具调用
    const shouldInterceptTools = ToolInterceptor.shouldIntercept(
      body.tools,
      config.webTools,
    );

    // 只有在自动触发模式下才使用提前拦截逻辑
    if (shouldInterceptTools && config.firecrawl && config.webTools && resolvedAutoTrigger) {
      // 使用 RequestContext 中已解析的上游信息
      const upstreamInfo = {
        baseUrl: upstreamConfig.baseUrl,
        apiKey: upstreamConfig.apiKey,
        model: upstreamConfig.model,
        protocol: upstreamConfig.protocol as "openai" | "anthropic",
      };

      // 拦截工具调用
      const webSearchTool = body.tools?.find(
        (tool: any) => tool.type === "web_search_20250305",
      );
      const webFetchTool = body.tools?.find(
        (tool: any) => tool.type === "web_fetch_20250910",
      );

      logPhase(requestId, LogPhase.TOOL_INTERCEPT, "Web Search/Fetch tool detected", {
        totalTools: body.tools?.length,
        hasWebSearch: !!webSearchTool,
        hasWebFetch: !!webFetchTool,
        toolTypes: body.tools?.map((t: any) => t.type || t.name).filter(Boolean),
      });

      try {
        const interceptor = new ToolInterceptor(config.firecrawl, config.webTools);

        if (webSearchTool && config.webTools.enableSearchIntercept) {
          // 根据配置选择简单模式或智能模式
          const isSmartMode = config.webTools.searchMode === "smart";
          const deepBrowseEnabled = config.webTools.deepBrowseEnabled;

          await logRequest(requestId, "info", `🔍 Web Search (${isSmartMode ? "Smart" : "Simple"} Mode${isSmartMode && deepBrowseEnabled ? " + Deep Browse" : ""})`, {
            mode: config.webTools.searchMode,
            deepBrowse: isSmartMode ? deepBrowseEnabled : false,
            deepBrowseCount: isSmartMode && deepBrowseEnabled ? config.webTools.deepBrowseCount : 0,
            stream: isStream,
            upstream: `${upstreamInfo.protocol}://${upstreamInfo.model}`,
            channel: actualModelName.includes("+") ? actualModelName.split("+")[0] : "default",
          });

          if (isStream) {
            // ========== 流式模式 ==========
            // 创建 SSE 流并逐个发送事件
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const writer = new SSEWriter(controller, requestId);

                try {
                  if (isSmartMode) {
                    // 智能模式：使用流式调用上游 API
                    // 先获取搜索结果
                    const searchResult = await interceptor.handleWebSearch(
                      webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                      body.messages,
                      upstreamInfo,
                      requestId,
                    );

                    // 使用流式写入器，先输出搜索结果，然后流式输出 AI 分析
                    await StreamResponseWriter.writeSmartSearchResponseStreaming(
                      writer,
                      body.model,
                      // 获取搜索结果的回调
                      async () => searchResult,
                      // 流式分析的回调
                      async (onStreamChunk) => {
                        await interceptor.doStreamAnalysis(
                          webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                          searchResult,
                          body.messages,
                          upstreamInfo,
                          requestId,
                          onStreamChunk,
                          // keepAlive 回调，在深入浏览期间保持连接
                          () => {
                            try {
                              if (!writer.isClosed()) {
                                controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
                              }
                            } catch {
                              // 忽略错误
                            }
                          },
                        );
                      },
                    );
                  } else {
                    // 简单模式：仅返回搜索结果
                    const simpleResult = await interceptor.handleWebSearch(
                      webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                      body.messages,
                      upstreamInfo,
                      requestId,
                    );

                    await StreamResponseWriter.writeSearchResponse(
                      writer,
                      simpleResult,
                      body.model,
                    );
                  }

                  const duration = Date.now() - startTime;
                  logRequestComplete(requestId, {
                    duration,
                  });
                } catch (error) {
                  log("error", "Web Search streaming error", { requestId, error: String(error) });
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
            // ========== 非流式模式 ==========
            let response;
            if (isSmartMode) {
              const smartResult = await interceptor.handleSmartWebSearch(
                webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                body.messages,
                upstreamInfo,
                requestId,
              );

              response = {
                id: `msg_${crypto.randomUUID()}`,
                type: "message",
                role: "assistant",
                model: body.model,
                content: [
                  smartResult.serverToolUse,
                  smartResult.toolResult,
                  smartResult.llmAnalysis,
                ],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                },
              };
            } else {
              const simpleResult = await interceptor.handleWebSearch(
                webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                body.messages,
                upstreamInfo,
                requestId,
              );

              response = {
                id: `msg_${crypto.randomUUID()}`,
                type: "message",
                role: "assistant",
                model: body.model,
                content: [
                  simpleResult.serverToolUse,
                  simpleResult.toolResult,
                ],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                },
              };
            }

            const duration = Date.now() - startTime;
            logRequestComplete(requestId, {
              duration,
            });

            return jsonResponse(response);
          }
        }

        if (webFetchTool && config.webTools.enableFetchIntercept) {
          // 从消息中提取 URL
          const lastMessage = body.messages[body.messages.length - 1];
          let url = "";

          if (typeof lastMessage.content === "string") {
            // 简单的 URL 提取
            const urlMatch = lastMessage.content.match(/https?:\/\/[^\s]+/);
            if (urlMatch) {
              url = urlMatch[0];
            }
          }

          if (!url) {
            throw new Error("No URL found in message for web_fetch");
          }

          await logRequest(requestId, "info", `🌐 Web Fetch`, {
            stream: isStream,
            url: url.substring(0, 100),
            upstream: `${upstreamInfo.protocol}://${upstreamInfo.model}`,
            channel: actualModelName.includes("+") ? actualModelName.split("+")[0] : "default",
          });

          if (isStream) {
            // ========== 流式模式 ==========
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const writer = new SSEWriter(controller, requestId);

                try {
                  const simpleResult = await interceptor.handleWebFetch(
                    webFetchTool as unknown as AnthropicWebFetchToolDefinition,
                    url,
                    requestId,
                  );

                  await StreamResponseWriter.writeFetchResponse(
                    writer,
                    simpleResult,
                    body.model,
                  );

                  const duration = Date.now() - startTime;
                  logRequestComplete(requestId, {
                    duration,
                  });
                } catch (error) {
                  log("error", "Web Fetch streaming error", { requestId, error: String(error) });
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
            // ========== 非流式模式 ==========
            const simpleResult = await interceptor.handleWebFetch(webFetchTool as unknown as AnthropicWebFetchToolDefinition, url, requestId);

            const response = {
              id: `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: body.model,
              content: [
                simpleResult.serverToolUse,
                simpleResult.toolResult,
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
              },
            };

            const duration = Date.now() - startTime;
            logRequestComplete(requestId, {
              duration,
            });

            return jsonResponse(response);
          }
        }
      } catch (error) {
        await logRequest(requestId, "error", "Tool interception failed", {
          error: String(error),
        });
        // 失败时继续正常流程
      }
    }

    if (isStream) {
      // 创建中止控制器，用于在客户端断开时取消上游请求
      const abortController = new AbortController();

      // 创建响应流
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const writer = new SSEWriter(controller, requestId);

          // 设置心跳机制，防止连接超时
          const heartbeatInterval = setInterval(() => {
            if (!writer.isClosed()) {
              try {
                controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
              } catch {
                clearInterval(heartbeatInterval);
              }
            } else {
              clearInterval(heartbeatInterval);
            }
          }, 5000); // 每 5 秒发送心跳

          try {
            // 调用统一的转发逻辑，传入 RequestContext 和 abort signal
            const result = await forwardRequest(context, writer, abortController.signal);
            
            // 计算耗时和统计
            const duration = Date.now() - startTime;
            logRequestComplete(requestId, {
              duration,
              inputTokens: (result as any)?.inputTokens,
              outputTokens: (result as any)?.outputTokens,
            });
          } catch (error) {
            // 检查是否是因为客户端断开导致的中止
            if (abortController.signal.aborted) {
              await logRequest(requestId, "info", "Request aborted by client disconnect", {});
            } else {
              const duration = Date.now() - startTime;
              logRequestComplete(requestId, {
                duration,
                error: String(error),
              });
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
            }
          } finally {
            clearInterval(heartbeatInterval);
            await closeRequestLog(requestId);
            writer.close();
          }
        },
        cancel(reason) {
          // 当客户端断开连接时，中止上游请求
          log("info", "Client disconnected, aborting upstream request", { requestId, reason });
          abortController.abort();
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
        // forwardRequest 使用 RequestContext
        const result = await forwardRequest(context, undefined);
        const duration = Date.now() - startTime;
        logRequestComplete(requestId, {
          duration,
          inputTokens: (result as any)?.usage?.input_tokens,
          outputTokens: (result as any)?.usage?.output_tokens,
        });
        return jsonResponse(result);
      } catch (error) {
        const duration = Date.now() - startTime;
        logRequestComplete(requestId, {
          duration,
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
  const config = getConfig();
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

export const handler = async (req: Request) => {
  const url = new URL(req.url);

  // 优先处理 Admin API
  const adminResponse = await adminService.handleRequest(req);
  if (adminResponse) return adminResponse;

  // 处理主页
  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = await Deno.readTextFile(new URL("./index.html", import.meta.url));
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      return new Response("Index page not found: " + errorMessage, { status: 404 });
    }
  }

  // 处理 Admin UI 静态页面
  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    try {
      const html = await Deno.readTextFile(new URL("./admin_ui.html", import.meta.url));
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      return new Response("Admin UI not found: " + errorMessage, { status: 404 });
    }
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
    return handleMessages(req, requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const requestId = crypto.randomUUID();
    return handleTokenCount(req, requestId);
  }

  return new Response("Not Found", { status: 404 });
};

if (import.meta.main) {
  const config = getConfig();
  
  // 启动时输出关键配置信息
  const { logConfigInfo } = await import("./logging.ts");
  logConfigInfo(config as unknown as Record<string, unknown>, "🚀 服务启动配置");
  
  serve(handler, config.autoPort ? undefined : { hostname: config.host, port: config.port });
}
