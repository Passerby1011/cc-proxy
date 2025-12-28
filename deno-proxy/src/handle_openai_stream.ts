import { ToolifyParser } from "./parser.ts";
import { ClaudeStream } from "./claude_writer.ts";
import { SSEWriter } from "./sse.ts";
import { ProxyConfig } from "./config.ts";
import { log } from "./logging.ts";

export async function handleOpenAIStream(
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

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") break;

        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices?.[0]?.delta;
          const content = delta?.content;

          if (content) {
            for (const char of content) {
              parser.feedChar(char);
              await claudeStream.handleEvents(parser.consumeEvents());
            }
          }
        } catch (e) {
          log("error", "Failed to parse OpenAI SSE chunk", { error: String(e), jsonStr });
        }
      }
    }

    parser.finish();
    await claudeStream.handleEvents(parser.consumeEvents());
  } catch (e) {
    log("error", "Error in OpenAI stream handling", { error: String(e), requestId });
  } finally {
    reader.releaseLock();
  }
}
