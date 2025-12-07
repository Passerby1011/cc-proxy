import {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRequest,
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "./types.ts";
import { ProxyConfig } from "./config.ts";

function normalizeBlocks(content: string | ClaudeContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_result") {
      return `<tool_result id="${block.tool_use_id}">${block.content ?? ""}</tool_result>`;
    }
    if (block.type === "tool_use") {
      const payload = JSON.stringify(block.input ?? {});
      return `<tool_call id="${block.id}" name="${block.name}">${payload}</tool_call>`;
    }
    return "";
  }).join("\n");
}

function mapRole(role: string): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

export function mapClaudeToOpenAI(body: ClaudeRequest, config: ProxyConfig): OpenAIChatRequest {
  if (typeof body.max_tokens !== "number" || Number.isNaN(body.max_tokens)) {
    throw new Error("max_tokens is required for Claude requests");
  }

  const messages: OpenAIChatMessage[] = [];
  if (body.system) {
    const systemContent = Array.isArray(body.system)
      ? body.system.map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object" && "text" in block) {
            return (block as { text: string }).text;
          }
          return "";
        }).join("\n")
      : body.system;
    messages.push({ role: "system", content: systemContent });
  }

  for (const message of body.messages) {
    messages.push({
      role: mapRole(message.role),
      content: normalizeBlocks(message.content),
    });
  }

  const model = config.upstreamModelOverride ?? body.model;

  return {
    model,
    stream: true,
    temperature: body.temperature ?? 0.2,
    top_p: body.top_p ?? 1,
    max_tokens: body.max_tokens,
    messages,
  };
}
