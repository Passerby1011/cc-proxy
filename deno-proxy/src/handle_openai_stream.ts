import { ClaudeStream } from "./claude_writer.ts";
import { ProxyConfig } from "./config.ts";
import { ToolifyParser } from "./parser.ts";
import { SSEWriter } from "./sse.ts";
import { log } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";
import { ToolCallRetryHandler } from "./tool_retry.ts";
import { ClaudeRequest } from "./types.ts";

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
  protocol: "openai" | "anthropic" = "openai",
) {
  const model = originalRequest?.model || "claude-3-5-sonnet-20241022";
  const parser = new ToolifyParser(delimiter, thinkingEnabled, requestId);
  const claudeStream = new ClaudeStream(writer, config, requestId, inputTokens, model);

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
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") break;

        try {
          const data = JSON.parse(jsonStr);
          const delta = data.choices?.[0]?.delta;

          // 1. 处理原生推理内容 (Reasoning)
          if (delta?.reasoning_content) {
            parser.feedReasoning(delta.reasoning_content);
            await claudeStream.handleEvents(parser.consumeEvents());
          }

          // 2. 处理常规内容
          // 某些模型可能会返回 content: null
          if (delta?.content) {
            for (const char of delta.content) {
              parser.feedChar(char);
              const events = parser.consumeEvents();
              const failed = events.find(e => e.type === "tool_call_failed");
              if (failed && config.toolCallRetry?.enabled) {
                // 🔑 如果开启了重试且发现了失败事件，立即中断流式循环，交给 handleRetry 处理
                parser.finish(); // 确保清理状态
                const allEvents = [...events, ...parser.consumeEvents()];
                const finalFailed = allEvents.find(e => e.type === "tool_call_failed") || failed;
                await handleRetry(finalFailed);
                return { outputTokens: claudeStream.getTotalOutputTokens() };
              }
              await claudeStream.handleEvents(events);
            }
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    // 🔑 结束后处理剩余内容
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
