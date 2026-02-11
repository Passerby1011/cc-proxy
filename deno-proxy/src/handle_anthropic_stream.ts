import { ClaudeStream, ToolInterceptCallback } from "./claude_writer.ts";
import { ProxyConfig, resolveAutoTrigger } from "./config.ts";
import { ToolifyParser } from "./parser.ts";
import { SSEWriter } from "./sse.ts";
import { log } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";
import { ToolCallRetryHandler } from "./tool_retry.ts";
import { ClaudeRequest } from "./types.ts";
import { ParsedToolInterceptor } from "./tools/parsed_tool_interceptor.ts";

export async function handleAnthropicStream(
  response: Response,
  writer: SSEWriter,
  config: ProxyConfig,
  requestId: string,
  delimiter?: ToolCallDelimiter,
  thinkingEnabled = false,
  inputTokens = 0,
  originalRequest?: ClaudeRequest,
  upstreamUrl = "",
  upstreamHeaders: Record<string, string> = {},
  protocol: "openai" | "anthropic" = "anthropic",
  clientApiKey?: string, // 新增：客户端 API Key
) {
  const model = originalRequest?.model || "claude-3-5-sonnet-20241022";
  const parser = new ToolifyParser(delimiter, thinkingEnabled, requestId);

  // 初始化工具拦截回调（如果启用且不是自动触发模式）
  let toolInterceptCallback: ToolInterceptCallback | undefined;

  if (
    config.firecrawl &&
    config.webTools &&
    (config.webTools.enableSearchIntercept || config.webTools.enableFetchIntercept) &&
    originalRequest
  ) {
    // 解析模型名并确定 autoTrigger 配置（考虑前缀、渠道、全局配置）
    const { autoTrigger: resolvedAutoTrigger, actualModelName } = resolveAutoTrigger(
      originalRequest.model,
      config.channelConfigs,
      config.webTools.autoTrigger
    );

    // 只有非自动触发模式才使用拦截器
    if (!resolvedAutoTrigger) {
      // 解析上游信息（使用解析后的模型名）
      const modelName = actualModelName;
      const plusIndex = modelName.indexOf("+");
      let upstreamBaseUrl: string;
      let upstreamApiKey: string | undefined;
      let upstreamModel: string;
      let upstreamProtocol: "openai" | "anthropic";

      if (plusIndex !== -1) {
        const channelName = modelName.slice(0, plusIndex);
        const actualModel = modelName.slice(plusIndex + 1);
        const channel = config.channelConfigs.find((c) => c.name === channelName);

        if (channel) {
          upstreamBaseUrl = channel.baseUrl;
          upstreamApiKey = channel.apiKey;
          upstreamModel = actualModel;
          upstreamProtocol = channel.protocol ?? config.defaultProtocol;
        } else {
          upstreamBaseUrl = config.upstreamBaseUrl!;
          upstreamApiKey = config.upstreamApiKey;
          upstreamModel = modelName;
          upstreamProtocol = config.defaultProtocol;
        }
      } else {
        if (config.channelConfigs.length > 0) {
          const channel = config.channelConfigs[0];
          upstreamBaseUrl = channel.baseUrl;
          upstreamApiKey = channel.apiKey;
          upstreamModel = modelName;
          upstreamProtocol = channel.protocol ?? config.defaultProtocol;
        } else {
          upstreamBaseUrl = config.upstreamBaseUrl!;
          upstreamApiKey = config.upstreamApiKey;
          upstreamModel = config.upstreamModelOverride ?? modelName;
          upstreamProtocol = config.defaultProtocol;
        }
      }

      // 如果启用了透传 API key，则优先使用客户端提供的 key
      if (config.passthroughApiKey && clientApiKey) {
        upstreamApiKey = clientApiKey;
      }

      const upstreamInfo = {
        baseUrl: upstreamBaseUrl,
        apiKey: upstreamApiKey,
        model: upstreamModel,
        protocol: upstreamProtocol,
      };

      const parsedInterceptor = new ParsedToolInterceptor(
        config.firecrawl,
        config.webTools,
        requestId,
        originalRequest.messages,
        upstreamInfo,
      );

      toolInterceptCallback = async (toolCall, writer) => {
        return await parsedInterceptor.interceptToolCall(toolCall, writer);
      };
    }
  }

  const claudeStream = new ClaudeStream(writer, config, requestId, inputTokens, model, toolInterceptCallback);

  await claudeStream.init();

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  async function handleRetry(failed: any) {
    if (!delimiter || !originalRequest || !upstreamUrl) {
      // 条件不足，降级处理
      await claudeStream.handleEvents([{ type: "text", content: failed.content }]);
      return;
    }

    // 🔑 保持连接：发送心跳
    if (config.toolCallRetry?.keepAlive !== false) {
      await writer.send({
        event: "ping",
        data: { type: "ping" }
      });
    }

    const maxRetries = config.toolCallRetry?.maxRetries || 1;
    let retrySuccess = false;

    // 重试循环
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const retryHandler = new ToolCallRetryHandler(
        config,
        requestId,
        originalRequest,
        upstreamUrl,
        upstreamHeaders,
        protocol
      );

      const retryResult = await retryHandler.retry(
        failed.content,
        failed.priorText || "",
        delimiter,
        attempt
      );

      if (retryResult.success) {
        // 🔑 重试成功：发送工具调用事件
        await claudeStream.handleEvents([{
          type: "tool_call",
          call: retryResult.result!
        }]);
        retrySuccess = true;
        break;
      } else if (attempt < maxRetries) {
        // 继续下一次重试
        log("info", "Retry attempt failed, will retry again", {
          requestId,
          attempt,
          maxRetries,
          error: retryResult.error
        });
        
        // 🔑 保持连接：再次发送心跳
        if (config.toolCallRetry?.keepAlive !== false) {
          await writer.send({
            event: "ping",
            data: { type: "ping" }
          });
        }
      }
    }

    if (!retrySuccess) {
      // 🔑 所有重试都失败：降级为文本
      log("error", "All retry attempts exhausted, falling back to text", {
        requestId,
        totalAttempts: maxRetries
      });
      
      await claudeStream.handleEvents([{
        type: "text",
        content: failed.content
      }]);
    }

    // 🔑 无论结果如何，最后发出完成事件
    await claudeStream.handleEvents([{ type: "end" }]);
  }

  try {
    let eventType = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("event: ")) {
          eventType = trimmed.slice(7);
        } else if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const data = JSON.parse(jsonStr);

            // 处理不同类型的 Anthropic 事件
            if (eventType === "content_block_delta") {
              const delta = data.delta;
              if (delta?.type === "text_delta") {
                const text = delta.text;
                if (text) {
                  for (const char of text) {
                    parser.feedChar(char);
                    const events = parser.consumeEvents();
                    const failed = events.find(e => e.type === "tool_call_failed");
                    if (failed && config.toolCallRetry?.enabled) {
                      parser.finish();
                      const allEvents = [...events, ...parser.consumeEvents()];
                      const finalFailed = allEvents.find(e => e.type === "tool_call_failed") || failed;
                      await handleRetry(finalFailed);
                      return { outputTokens: claudeStream.getTotalOutputTokens() };
                    }
                    await claudeStream.handleEvents(events);
                  }
                }
              }
            } else if (eventType === "message_start") {
              // 可以在这里更新 input_tokens
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    parser.finish();
    const events = parser.consumeEvents();
    const failedEvent = events.find(e => e.type === "tool_call_failed");

    if (failedEvent && config.toolCallRetry?.enabled) {
      await handleRetry(failedEvent);
    } else {
      await claudeStream.handleEvents(events);
    }

    return { outputTokens: claudeStream.getTotalOutputTokens() };
  } finally {
    reader.releaseLock();
  }
}
