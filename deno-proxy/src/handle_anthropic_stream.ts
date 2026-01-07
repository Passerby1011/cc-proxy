import { ToolifyParser } from "./parser.ts";
import { ClaudeStream } from "./claude_writer.ts";
import { SSEWriter } from "./sse.ts";
import { ProxyConfig } from "./config.ts";
import { log } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";

export async function handleAnthropicStream(
  response: Response,
  writer: SSEWriter,
  config: ProxyConfig,
  requestId: string,
  delimiter?: ToolCallDelimiter,
  thinkingEnabled = false,
  inputTokens = 0,
  model = "claude-3-5-sonnet-20241022",
) {
  const parser = new ToolifyParser(delimiter, thinkingEnabled, requestId);
  const claudeStream = new ClaudeStream(writer, config, requestId, inputTokens, model);

  await claudeStream.init();

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        log("error", "Stream read error", {
          error: String(readError),
          requestId
        });
        // 通知客户端发生了流读取错误
        await writer.send({
          event: "error",
          data: {
            error: {
              type: "stream_error",
              message: "Failed to read from upstream: " + String(readError)
            }
          }
        }, true);
        break;
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "";

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
                    await claudeStream.handleEvents(parser.consumeEvents());
                  }
                }
              }
            } else if (eventType === "message_start") {
              // 可以在这里更新 input_tokens，如果上游返回了更精确的值
            } else if (eventType === "message_delta") {
              // 处理结束状态等
            }
          } catch (e) {
            log("error", "Failed to parse Anthropic SSE chunk", { error: String(e), jsonStr });
          }
        }
      }
    }

    parser.finish();
    await claudeStream.handleEvents(parser.consumeEvents());
  } catch (e) {
    log("error", "Error in Anthropic stream handling", { error: String(e), requestId });
    // 尝试通知客户端发生了错误
    try {
      await writer.send({
        event: "error",
        data: {
          error: {
            type: "stream_error",
            message: String(e)
          }
        }
      }, true);
    } catch {
      // 忽略发送错误时的异常
    }
  } finally {
    reader.releaseLock();
  }
  
  return { outputTokens: claudeStream.getTotalOutputTokens() };
}
