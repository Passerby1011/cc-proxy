import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { loadConfig, ProxyConfig, resolveAutoTrigger } from "./config.ts";
import {
  closeRequestLog,
  log,
  LogPhase,
  logPhase,
  logRequest,
  logRequestComplete,
  logRequestStart,
} from "./logging.ts";
import { forwardRequest, UpstreamRequestError } from "./upstream.ts";
import { SSEWriter } from "./sse.ts";
import { ClaudeRequest } from "./types.ts";
import { MessageFormatConverter, type OpenAIRequest } from "./tools/message_format_converter.ts";
import {
  anthropicToOpenAIChatResponse,
  anthropicToOpenAIResponsesResponse,
  type DownstreamFormat,
  OpenAIChatCompletionStreamWriter,
  type OpenAIResponsesRequest,
  OpenAIResponsesStreamWriter,
  openAIResponsesToAnthropic,
} from "./openai_compat.ts";
import { RateLimiter } from "./rate_limiter.ts";
import { countTokens } from "./token_counter.ts";
import { AdminService } from "./admin_service.ts";
import { ToolInterceptor } from "./tools/tool_interceptor.ts";
import { StreamResponseWriter } from "./tools/stream_response_writer.ts";
import { RequestContext } from "./ai_client/mod.ts";
import {
  isOpenAIWebFetchTool,
  isOpenAIWebSearchTool,
  openAIWebFetchToolToAnthropic,
  openAIWebSearchToolToAnthropic,
  type AnthropicWebFetchToolDefinition,
  type AnthropicWebSearchToolDefinition,
} from "./tools/types.ts";

const initialConfig = loadConfig();
const adminService = new AdminService(initialConfig);
await adminService.init();

const getConfig = () => adminService.getCurrentConfig();

const rateLimiter = new RateLimiter(getConfig().maxRequestsPerMinute, 60_000);

// 构造统一 JSON 响应。
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 返回未授权响应。
function unauthorized() {
  return jsonResponse({ error: "unauthorized" }, 401);
}

// 从请求头提取客户端 API Key。
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

// 校验客户端访问密钥。
function validateClientKey(req: Request, config: ProxyConfig): boolean {
  if (config.passthroughApiKey) return true;

  if (!config.clientApiKey) return true;
  const clientKey = extractClientApiKey(req);
  if (!clientKey) return false;
  return clientKey === config.clientApiKey;
}

// 按下游协议创建对应的流式写出器。
function createStreamWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
  requestId: string,
  format: DownstreamFormat,
): SSEWriter {
  if (format === "openai-chat") {
    return new OpenAIChatCompletionStreamWriter(controller, requestId) as unknown as SSEWriter;
  }
  if (format === "openai-responses") {
    return new OpenAIResponsesStreamWriter(controller, requestId) as unknown as SSEWriter;
  }
  return new SSEWriter(controller, requestId);
}

// 按下游协议格式化非流式响应体。
function formatResponseBody(
  body: Record<string, unknown>,
  format: DownstreamFormat,
  model: string,
): Record<string, unknown> {
  if (format === "openai-chat") {
    return anthropicToOpenAIChatResponse(body as any, model);
  }
  if (format === "openai-responses") {
    return anthropicToOpenAIResponsesResponse(body as any, model);
  }
  return body;
}

function buildDefaultErrorBody(format: DownstreamFormat, message: string): Record<string, unknown> {
  if (format === "anthropic") {
    return {
      type: "error",
      error: {
        type: "api_error",
        message,
      },
    };
  }

  return {
    error: {
      type: "api_error",
      message,
    },
  };
}

function normalizeErrorForClient(
  error: unknown,
  format: DownstreamFormat,
): { status: number; body: Record<string, unknown> } {
  if (error instanceof UpstreamRequestError) {
    if (error.payload && typeof error.payload === "object") {
      return {
        status: error.status,
        body: error.payload as Record<string, unknown>,
      };
    }

    return {
      status: error.status,
      body: buildDefaultErrorBody(format, error.body || error.message),
    };
  }

  return {
    status: 500,
    body: buildDefaultErrorBody(format, String(error)),
  };
}

function normalizeStreamErrorForClient(
  error: unknown,
  format: DownstreamFormat,
): Record<string, unknown> {
  const { status, body } = normalizeErrorForClient(error, format);
  if (format === "openai-responses") {
    return {
      error: (body as any).error ?? body,
      status,
    };
  }
  if (format === "openai-chat") {
    return (body as any).error ? body : { error: body, status };
  }
  return body;
}

function extractUrlFromMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const urlMatch = content.match(/https?:\/\/[^\s]+/);
    return urlMatch?.[0];
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block as Record<string, unknown>;

    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      const urlMatch = typedBlock.text.match(/https?:\/\/[^\s]+/);
      if (urlMatch?.[0]) {
        return urlMatch[0];
      }
      continue;
    }

    const input = typedBlock.input;
    if (input && typeof input === "object" && typeof (input as Record<string, unknown>).url === "string") {
      return (input as Record<string, string>).url;
    }
  }

  return undefined;
}

function extractLatestUrlFromMessages(messages: ClaudeRequest["messages"]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const url = extractUrlFromMessageContent(messages[i].content);
    if (url) {
      return url;
    }
  }
  return undefined;
}

// 统一处理内部 Anthropic 格式请求，并转发到目标上游。
async function handleClaudeRequestBody(
  req: Request,
  requestId: string,
  body: ClaudeRequest,
  downstreamFormat: DownstreamFormat,
) {
  const startTime = Date.now();
  const config = getConfig();

  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  try {
    await rateLimiter.acquire();

    const rawClientKey = extractClientApiKey(req);
    const clientApiKey = (config.passthroughApiKey && rawClientKey) ? rawClientKey : undefined;

    const context = RequestContext.fromRequest(
      body,
      config,
      requestId,
      clientApiKey,
    );

    const upstreamConfig = context.getUpstreamConfig();
    const isStream = body.stream === true;

    const { autoTrigger: resolvedAutoTrigger, actualModelName, channelName } = resolveAutoTrigger(
      body.model,
      config.channelConfigs,
      config.webTools?.autoTrigger ?? true,
    );

    logRequestStart(requestId, {
      model: body.model,
      tools: body.tools?.length,
      stream: body.stream === true,
      channel: channelName,
      autoTrigger: resolvedAutoTrigger,
      downstreamFormat,
      upstreamProtocol: upstreamConfig.protocol,
      upstreamModel: upstreamConfig.model,
      toolCallMode: context.getToolCallMode(),
    });

    logPhase(requestId, LogPhase.PROTOCOL, "Resolved request context", {
      downstreamFormat,
      upstreamProtocol: upstreamConfig.protocol,
      upstreamModel: upstreamConfig.model,
      actualModelName,
      toolCallMode: context.getToolCallMode(),
      supportsNativeToolCalling: context.supportsNativeToolCall(),
    });

    const shouldInterceptTools = ToolInterceptor.shouldIntercept(
      body.tools,
      config.webTools,
    );

    if (shouldInterceptTools && config.firecrawl && config.webTools && resolvedAutoTrigger) {
      const upstreamInfo = {
        baseUrl: upstreamConfig.baseUrl,
        apiKey: upstreamConfig.apiKey,
        model: upstreamConfig.model,
        protocol: upstreamConfig.protocol as "openai" | "openai-responses" | "anthropic",
      };

      const rawWebSearchTool = body.tools?.find((tool: any) =>
        tool?.type === "web_search_20250305" ||
        tool?.type === "web_search_preview" ||
        tool?.type === "web_search"
      );
      const rawWebFetchTool = body.tools?.find((tool: any) =>
        tool?.type === "web_fetch_20250910" ||
        tool?.type === "web_fetch_preview" ||
        tool?.type === "web_fetch"
      );

      const webSearchTool: AnthropicWebSearchToolDefinition | undefined = rawWebSearchTool
        ? (rawWebSearchTool.type === "web_search_20250305"
          ? rawWebSearchTool as AnthropicWebSearchToolDefinition
          : (isOpenAIWebSearchTool(rawWebSearchTool)
            ? openAIWebSearchToolToAnthropic(rawWebSearchTool)
            : undefined))
        : undefined;
      const webFetchTool: AnthropicWebFetchToolDefinition | undefined = rawWebFetchTool
        ? (rawWebFetchTool.type === "web_fetch_20250910"
          ? rawWebFetchTool as AnthropicWebFetchToolDefinition
          : (isOpenAIWebFetchTool(rawWebFetchTool)
            ? openAIWebFetchToolToAnthropic(rawWebFetchTool)
            : undefined))
        : undefined;

      logPhase(requestId, LogPhase.TOOL_INTERCEPT, "Web Search/Fetch tool detected", {
        totalTools: body.tools?.length,
        hasWebSearch: !!webSearchTool,
        hasWebFetch: !!webFetchTool,
        toolTypes: body.tools?.map((t: any) => t.type || t.name).filter(Boolean),
      });

      try {
        const interceptor = new ToolInterceptor(config.firecrawl, config.webTools);

        if (webSearchTool && config.webTools.enableSearchIntercept) {
          const isSmartMode = config.webTools.searchMode === "smart";
          const deepBrowseEnabled = config.webTools.deepBrowseEnabled;

          await logRequest(
            requestId,
            "info",
            `启动 Web Search (${isSmartMode ? "Smart" : "Simple"} Mode${
              isSmartMode && deepBrowseEnabled ? " + Deep Browse" : ""
            })`,
            {
              mode: config.webTools.searchMode,
              deepBrowse: isSmartMode ? deepBrowseEnabled : false,
              deepBrowseCount: isSmartMode && deepBrowseEnabled
                ? config.webTools.deepBrowseCount
                : 0,
              stream: isStream,
              upstream: `${upstreamInfo.protocol}://${upstreamInfo.model}`,
              channel: actualModelName.includes("+") ? actualModelName.split("+")[0] : "default",
            },
          );

          if (isStream) {
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const writer = createStreamWriter(controller, requestId, downstreamFormat);

                try {
                  if (isSmartMode) {
                    const searchResult = await interceptor.handleWebSearch(
                      webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                      body.messages,
                      upstreamInfo,
                      requestId,
                    );

                    await StreamResponseWriter.writeSmartSearchResponseStreaming(
                      writer,
                      body.model,
                      async () => searchResult,
                      async (onStreamChunk) => {
                        await interceptor.doStreamAnalysis(
                          webSearchTool as unknown as AnthropicWebSearchToolDefinition,
                          searchResult,
                          body.messages,
                          upstreamInfo,
                          requestId,
                          onStreamChunk,
                          () => {
                            try {
                              if (!writer.isClosed()) {
                                controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
                              }
                            } catch {
                            }
                          },
                        );
                      },
                    );
                  } else {
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
                  logRequestComplete(requestId, { duration });
                } catch (error) {
                  log("error", "Web Search streaming error", { requestId, error: String(error) });
                  try {
                    await writer.send({
                      event: "error",
                      data: normalizeStreamErrorForClient(error, downstreamFormat),
                    }, true);
                  } catch {
                  }
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
          }

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
                { type: "text", text: smartResult.llmAnalysis.text },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
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
              content: [simpleResult.serverToolUse, simpleResult.toolResult],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            };
          }

          const duration = Date.now() - startTime;
          logRequestComplete(requestId, { duration });
          return jsonResponse(formatResponseBody(response as any, downstreamFormat, body.model));
        }

        if (webFetchTool && config.webTools.enableFetchIntercept) {
          const url = extractLatestUrlFromMessages(body.messages);
          if (!url) {
            throw new Error("No URL found in message for web_fetch");
          }

          await logRequest(requestId, "info", "启动 Web Fetch", {
            stream: isStream,
            url: url.substring(0, 100),
            upstream: `${upstreamInfo.protocol}://${upstreamInfo.model}`,
            channel: actualModelName.includes("+") ? actualModelName.split("+")[0] : "default",
          });

          if (isStream) {
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const writer = createStreamWriter(controller, requestId, downstreamFormat);
                try {
                  const simpleResult = await interceptor.handleWebFetch(
                    webFetchTool as unknown as AnthropicWebFetchToolDefinition,
                    url,
                    requestId,
                  );
                  await StreamResponseWriter.writeFetchResponse(writer, simpleResult, body.model);
                  const duration = Date.now() - startTime;
                  logRequestComplete(requestId, { duration });
                } catch (error) {
                  log("error", "Web Fetch streaming error", { requestId, error: String(error) });
                  try {
                    await writer.send({
                      event: "error",
                      data: normalizeStreamErrorForClient(error, downstreamFormat),
                    }, true);
                  } catch {
                  }
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
          }

          const simpleResult = await interceptor.handleWebFetch(
            webFetchTool as unknown as AnthropicWebFetchToolDefinition,
            url,
            requestId,
          );
          const response = {
            id: `msg_${crypto.randomUUID()}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [simpleResult.serverToolUse, simpleResult.toolResult],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          };

          const duration = Date.now() - startTime;
          logRequestComplete(requestId, { duration });
          return jsonResponse(formatResponseBody(response as any, downstreamFormat, body.model));
        }
      } catch (error) {
        await logRequest(requestId, "error", "Tool interception failed", {
          error: String(error),
        });
      }
    }

    if (isStream) {
      const abortController = new AbortController();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const writer = createStreamWriter(controller, requestId, downstreamFormat);
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
          }, 5000);

          try {
            const result = await forwardRequest(context, writer, abortController.signal);
            const duration = Date.now() - startTime;
            logRequestComplete(requestId, {
              duration,
              inputTokens: (result as any)?.inputTokens,
              outputTokens: (result as any)?.outputTokens,
            });
          } catch (error) {
            if (abortController.signal.aborted) {
              await logRequest(requestId, "info", "Request aborted by client disconnect", {});
            } else {
              const duration = Date.now() - startTime;
              logRequestComplete(requestId, { duration, error: String(error) });
              try {
                await writer.send({
                  event: "error",
                  data: normalizeStreamErrorForClient(error, downstreamFormat),
                }, true);
              } catch {
              }
            }
          } finally {
            clearInterval(heartbeatInterval);
            await closeRequestLog(requestId);
            writer.close();
          }
        },
        cancel(reason) {
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
    }

    try {
      const result = await forwardRequest(context, undefined);
      const duration = Date.now() - startTime;
      logRequestComplete(requestId, {
        duration,
        inputTokens: (result as any)?.usage?.input_tokens,
        outputTokens: (result as any)?.usage?.output_tokens,
      });
      return jsonResponse(formatResponseBody(result as any, downstreamFormat, body.model));
    } catch (error) {
      const duration = Date.now() - startTime;
      logRequestComplete(requestId, { duration, error: String(error) });
      const normalized = normalizeErrorForClient(error, downstreamFormat);
      return jsonResponse(normalized.body, normalized.status);
    } finally {
      await closeRequestLog(requestId);
    }
  } catch (error) {
    await logRequest(requestId, "error", "Failed to setup request stream", {
      error: String(error),
    });
    await closeRequestLog(requestId);
    const normalized = normalizeErrorForClient(error, downstreamFormat);
    return jsonResponse(normalized.body, normalized.status);
  }
}

// 处理对外 Anthropic Messages 接口。
async function handleMessages(req: Request, requestId: string) {
  const config = getConfig();
  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  try {
    const body = JSON.parse(await req.text()) as ClaudeRequest;
    await logRequest(requestId, "debug", "Received Claude request body", { rawPreview: body });
    return await handleClaudeRequestBody(req, requestId, body, "anthropic");
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
}

// 处理对外 OpenAI Chat Completions 接口。
async function handleChatCompletions(req: Request, requestId: string) {
  const config = getConfig();
  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  try {
    const body = JSON.parse(await req.text()) as OpenAIRequest;
    await logRequest(requestId, "debug", "Received OpenAI chat request body", { rawPreview: body });
    logPhase(requestId, LogPhase.PROTOCOL, "Converting OpenAI Chat request to internal Anthropic format", {
      messageCount: body.messages?.length,
      toolsCount: body.tools?.length,
      stream: body.stream === true,
    });
    const claudeRequest = MessageFormatConverter.openAIToAnthropic(body);
    return await handleClaudeRequestBody(req, requestId, claudeRequest, "openai-chat");
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
}

// 处理对外 OpenAI Responses 接口。
async function handleResponses(req: Request, requestId: string) {
  const config = getConfig();
  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  try {
    const body = JSON.parse(await req.text()) as OpenAIResponsesRequest;
    await logRequest(requestId, "debug", "Received OpenAI responses request body", {
      rawPreview: body,
    });
    logPhase(requestId, LogPhase.PROTOCOL, "Converting OpenAI Responses request to internal Anthropic format", {
      inputIsArray: Array.isArray(body.input),
      inputCount: Array.isArray(body.input) ? body.input.length : 1,
      toolsCount: body.tools?.length,
      stream: body.stream === true,
    });
    const claudeRequest = openAIResponsesToAnthropic(body);
    return await handleClaudeRequestBody(req, requestId, claudeRequest, "openai-responses");
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
}
// 处理 token 统计接口。
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

  const adminResponse = await adminService.handleRequest(req);
  if (adminResponse) return adminResponse;

  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = await Deno.readTextFile(new URL("./index.html", import.meta.url));
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      return new Response("Index page not found: " + errorMessage, { status: 404 });
    }
  }

  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    try {
      const html = await Deno.readTextFile(new URL("./admin_ui.html", import.meta.url));
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
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

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const requestId = crypto.randomUUID();
    return handleChatCompletions(req, requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    const requestId = crypto.randomUUID();
    return handleResponses(req, requestId);
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const requestId = crypto.randomUUID();
    return handleTokenCount(req, requestId);
  }

  return new Response("Not Found", { status: 404 });
};

if (import.meta.main) {
  const config = getConfig();

  const { logConfigInfo } = await import("./logging.ts");
  logConfigInfo(config as unknown as Record<string, unknown>, "Service startup config");

  serve(handler, config.autoPort ? undefined : { hostname: config.host, port: config.port });
}
