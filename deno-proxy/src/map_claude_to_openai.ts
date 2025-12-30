import {
  ClaudeRequest,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIContentBlock,
  OpenAITextBlock,
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
    const openaiContent: OpenAIContentBlock[] = [];

    if (typeof message.content === "string") {
      openaiContent.push({ type: "text", text: message.content });
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          openaiContent.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          openaiContent.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          });
        }
        // tool_use, tool_result, thinking 应该在 enrichClaudeRequest 中被转成了文本
        // 如果这里还存在，说明 enrichClaudeRequest 没处理或者我们想保留它们的原生处理
        // 目前为了简单，非文本非图片直接忽略或作为文本（如果在 content[] 里）
      }
    }

    // 如果是用户消息且启用了思考模式，在最后一个文本块后添加思考提示符
    if (message.role === "user" && body.thinking && body.thinking.type === "enabled") {
      const lastTextBlock = [...openaiContent].reverse().find((b) => b.type === "text") as
        | OpenAITextBlock
        | undefined;
      if (lastTextBlock) {
        lastTextBlock.text += THINKING_HINT;
      } else {
        openaiContent.push({ type: "text", text: THINKING_HINT });
      }
    }

    messages.push({
      role: mapRole(message.role),
      content: openaiContent,
    });
  }

  // 3. 在最后一条消息添加继续回复的引导（保持原有逻辑）
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    if (Array.isArray(lastMessage.content)) {
      const lastTextBlock = [...lastMessage.content].reverse().find((b) => b.type === "text") as
        | OpenAITextBlock
        | undefined;
      const hint = "\n\n<antml\\b:role>\n\nPlease continue responding as an assistant.\n\n</antml>";
      if (lastTextBlock) {
        lastTextBlock.text += hint;
      } else {
        lastMessage.content.push({ type: "text", text: hint });
      }
    }
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
