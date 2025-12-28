import { ToolifyParser } from "./parser.ts";
import { ClaudeStream } from "./claude_writer.ts";
import { SSEWriter } from "./sse.ts";
import { ProxyConfig } from "./config.ts";
import { log } from "./logging.ts";

export async function handleAnthropicStream(
  response: Response,
  writer: SSEWriter,
  config: ProxyConfig,
  requestId: string,
  triggerSignal?: string,
  thinkingEnabled = false,
  inputTokens = 0,
) {
  const parser = new ToolifyParser(triggerSignal, thinkingEnabled);
  const claudeStream = new ClaudeStream(writer, config, requestId, inputTokens);

  await claudeStream.init();

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
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
  } finally {
    reader.releaseLock();
  }
}
