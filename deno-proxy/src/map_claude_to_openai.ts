import {
  ClaudeRequest,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIContentBlock,
  OpenAITextBlock,
} from "./types.ts";
import { OPENAI_CHAT_PASSTHROUGH_METADATA_KEY } from "./tools/message_format_converter.ts";

const THINKING_HINT = "<antml\\b:thinking_mode>interleaved</antml><antml\\b:max_thinking_length>16000</antml>";

function mapRole(role: string): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

function isBlankText(text: string): boolean {
  return text.trim().length === 0;
}

function getOpenAIChatPassthrough(body: ClaudeRequest): Record<string, unknown> {
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  const passthrough = (metadata as Record<string, unknown>)[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY];
  if (!passthrough || typeof passthrough !== "object") {
    return {};
  }

  return passthrough as Record<string, unknown>;
}

/**
 * 将已增强（已处理工具注入和文本化）的 ClaudeRequest 转换为 OpenAIChatRequest
 */
export function mapClaudeToOpenAI(
  body: ClaudeRequest,
  requestModel: string,
  supportsSystemPrompt: boolean = true,
): OpenAIChatRequest {
  if (typeof body.max_tokens !== "number" || Number.isNaN(body.max_tokens)) {
    throw new Error("max_tokens is required for Claude requests");
  }

  const messages: OpenAIChatMessage[] = [];

  if (body.system) {
    let systemContent = "";
    if (typeof body.system === "string") {
      systemContent = body.system;
    } else {
      systemContent = body.system
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
    }

    if (systemContent) {
      messages.push({
        role: supportsSystemPrompt ? "system" : "user",
        content: systemContent,
      });
    }
  }

  for (const message of body.messages) {
    const openaiContent: OpenAIContentBlock[] = [];

    if (typeof message.content === "string") {
      if (!isBlankText(message.content)) {
        openaiContent.push({ type: "text", text: message.content });
      }
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          if (!isBlankText(block.text)) {
            openaiContent.push({ type: "text", text: block.text });
          }
        } else if (block.type === "image") {
          openaiContent.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          });
        } else if (block.type === "thinking") {
          openaiContent.push({
            type: "text",
            text: `<thinking>${block.thinking}</thinking>`,
          });
        }
      }
    }

    if (openaiContent.length === 0) {
      continue;
    }

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

  const requestBody: OpenAIChatRequest & Record<string, unknown> = {
    model: requestModel,
    stream: true,
    max_tokens: body.max_tokens,
    messages,
  };

  if (body.temperature !== undefined) {
    requestBody.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    requestBody.top_p = body.top_p;
  }

  const stopSequences = (body as any).stop_sequences;
  if (typeof stopSequences === "string") {
    requestBody.stop = stopSequences;
  } else if (Array.isArray(stopSequences)) {
    const normalized = stopSequences.filter((item): item is string => typeof item === "string");
    if (normalized.length > 0) {
      requestBody.stop = normalized;
    }
  }

  const passthrough = getOpenAIChatPassthrough(body);
  for (const [key, value] of Object.entries(passthrough)) {
    if (value === undefined) continue;
    if (requestBody[key] !== undefined) continue;
    requestBody[key] = value;
  }

  return requestBody;
}
