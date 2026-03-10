import { ClaudeStream, ToolInterceptCallback } from "./claude_writer.ts";
import { ProxyConfig, resolveAutoTrigger } from "./config.ts";
import { ToolifyParser } from "./parser.ts";
import { SSEWriter } from "./sse.ts";
import { log } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";
import { ToolCallRetryHandler } from "./tool_retry.ts";
import { ClaudeRequest } from "./types.ts";
import { ParsedToolInterceptor } from "./tools/parsed_tool_interceptor.ts";
import { RequestContext } from "./ai_client/mod.ts";

// 处理 OpenAI / Responses 流式响应，并在非原生工具模式下完成解析、重试和拦截。
export async function handleOpenAIStream(
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
  protocol: "openai" | "openai-responses" | "anthropic" = "openai",
  clientApiKey?: string,
  context?: RequestContext, 
) {
  const model = originalRequest?.model || "claude-3-5-sonnet-20241022";
  const parser = new ToolifyParser(delimiter, thinkingEnabled, requestId);

  let toolInterceptCallback: ToolInterceptCallback | undefined;

  if (
    config.firecrawl &&
    config.webTools &&
    (config.webTools.enableSearchIntercept || config.webTools.enableFetchIntercept) &&
    originalRequest &&
    context // 闇€瑕?context 鎵嶈兘浣跨敤鎷︽埅鍣?
  ) {
    const { autoTrigger: resolvedAutoTrigger } = resolveAutoTrigger(
      originalRequest.model,
      config.channelConfigs,
      config.webTools.autoTrigger,
    );

    if (!resolvedAutoTrigger) {
      const upstreamConfig = context.getUpstreamConfig();
      const upstreamInfo = {
        baseUrl: upstreamConfig.baseUrl,
        apiKey: upstreamConfig.apiKey,
        model: upstreamConfig.model,
        protocol: upstreamConfig.protocol as "openai" | "openai-responses" | "anthropic",
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

  const claudeStream = new ClaudeStream(
    writer,
    config,
    requestId,
    inputTokens,
    model,
    toolInterceptCallback,
  );

  await claudeStream.init();

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEventType = "";
  let shouldStop = false;

  async function handleRetry(failed: any) {
    if (!delimiter || !originalRequest || !upstreamUrl) {
      await claudeStream.handleEvents([{ type: "text", content: failed.content }]);
      return;
    }

    if (config.toolCallRetry?.keepAlive !== false) {
      await writer.send({
        event: "ping",
        data: { type: "ping" },
      });
    }

    const maxRetries = config.toolCallRetry?.maxRetries || 1;
    let retrySuccess = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!context) {
        log("error", "Cannot retry without RequestContext", { requestId });
        break;
      }

      const retryHandler = new ToolCallRetryHandler(context);

      const retryResult = await retryHandler.retry(
        failed.content,
        failed.priorText || "",
        delimiter,
        attempt,
      );

      if (retryResult.success) {
        await claudeStream.handleEvents([{
          type: "tool_call",
          call: retryResult.result!,
        }]);
        retrySuccess = true;
        break;
      } else if (attempt < maxRetries) {
        log("info", "Retry attempt failed, will retry again", {
          requestId,
          attempt,
          maxRetries,
          error: retryResult.error,
        });

        if (config.toolCallRetry?.keepAlive !== false) {
          await writer.send({
            event: "ping",
            data: { type: "ping" },
          });
        }
      }
    }

    if (!retrySuccess) {
      log("error", "All retry attempts exhausted, falling back to text", {
        requestId,
        totalAttempts: maxRetries,
      });

      await claudeStream.handleEvents([{
        type: "text",
        content: failed.content,
      }]);
    }

    await claudeStream.handleEvents([{ type: "end" }]);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (protocol === "openai-responses" && trimmed.startsWith("event: ")) {
          currentEventType = trimmed.slice(7);
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") {
          shouldStop = true;
          break;
        }

        try {
          const data = JSON.parse(jsonStr);
          if (protocol === "openai-responses") {
            const eventType = (typeof data.type === "string" && data.type.length > 0)
              ? data.type
              : currentEventType;

            const reasoningDelta = eventType === "response.reasoning_summary_text.delta"
              ? data.delta
              : undefined;
            if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
              parser.feedReasoning(reasoningDelta);
              await claudeStream.handleEvents(parser.consumeEvents());
            }

            const textDelta = eventType === "response.output_text.delta"
              ? data.delta
              : undefined;
            if (typeof textDelta === "string" && textDelta.length > 0) {
              for (const char of textDelta) {
                parser.feedChar(char);
                const events = parser.consumeEvents();
                const failed = events.find((e) => e.type === "tool_call_failed");
                if (failed && config.toolCallRetry?.enabled) {
                  parser.finish();
                  const allEvents = [...events, ...parser.consumeEvents()];
                  const finalFailed = allEvents.find((e) => e.type === "tool_call_failed") || failed;
                  await handleRetry(finalFailed);
                  return { outputTokens: claudeStream.getTotalOutputTokens() };
                }
                await claudeStream.handleEvents(events);
              }
            }

            if (eventType === "response.completed") {
              shouldStop = true;
              break;
            }

            continue;
          }

          const delta = data.choices?.[0]?.delta;

          if (delta?.reasoning_content) {
            parser.feedReasoning(delta.reasoning_content);
            await claudeStream.handleEvents(parser.consumeEvents());
          }

          if (delta?.content) {
            for (const char of delta.content) {
              parser.feedChar(char);
              const events = parser.consumeEvents();
              const failed = events.find((e) => e.type === "tool_call_failed");
              if (failed && config.toolCallRetry?.enabled) {
                parser.finish();
                const allEvents = [...events, ...parser.consumeEvents()];
                const finalFailed = allEvents.find((e) => e.type === "tool_call_failed") || failed;
                await handleRetry(finalFailed);
                return { outputTokens: claudeStream.getTotalOutputTokens() };
              }
              await claudeStream.handleEvents(events);
            }
          }
        } catch (e) {
        }
      }

      if (shouldStop) break;
    }

    parser.finish();
    const events = parser.consumeEvents();
    const failedEvent = events.find((e) => e.type === "tool_call_failed");

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
