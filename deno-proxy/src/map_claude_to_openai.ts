import {
  ClaudeRequest,
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "./types.ts";

// 思考模式相关的提示符
const THINKING_HINT = "<antml\b:thinking_mode>interleaved</antml><antml\b:max_thinking_length>16000</antml>";

function mapRole(role: string): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

/**
 * 将已增强（已处理工具注入和文本化）的 ClaudeRequest 转换为 OpenAIChatRequest
 */
export function mapClaudeToOpenAI(
  body: ClaudeRequest,
  requestModel: string,
): OpenAIChatRequest {
  if (typeof body.max_tokens !== "number" || Number.isNaN(body.max_tokens)) {
    throw new Error("max_tokens is required for Claude requests");
  }

  const messages: OpenAIChatMessage[] = [];
  
  // 1. 处理 System Message
  if (body.system) {
    let systemContent = "";
    if (typeof body.system === "string") {
      systemContent = body.system;
    } else {
      systemContent = body.system
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
    }
    messages.push({ role: "system", content: systemContent });
  }

  // 2. 处理 Messages
  for (const message of body.messages) {
    let content = "";
    if (typeof message.content === "string") {
      content = message.content;
    } else {
      // 理论上此时 content 已经是字符串了（由于 enrichClaudeRequest 的处理）
      // 这里做个保险
      content = message.content
        .map(b => b.type === "text" ? b.text : "")
        .join("\n");
    }
    
    // 如果是用户消息且启用了思考模式，添加思考提示符
    if (message.role === "user" && body.thinking && body.thinking.type === "enabled") {
      // 这里简化了原先对 tool_result 的排除逻辑，因为此时 tool_result 已经是字符串中的一部分了
      // 如果需要更精细控制，可能需要在 enrich 阶段打标记
      content = content + THINKING_HINT;
    }
    
    messages.push({
      role: mapRole(message.role),
      content: content,
    });
  }

  // 3. 在最后一条消息添加继续回复的引导（保持原有逻辑）
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    lastMessage.content = lastMessage.content + "\n\n<antml\\b:role>\n\nPlease continue responding as an assistant.\n\n</antml>";
  }

  return {
    model: requestModel,
    stream: true,
    temperature: body.temperature ?? 0.2,
    top_p: body.top_p ?? 1,
    max_tokens: body.max_tokens,
    messages,
  };
}
