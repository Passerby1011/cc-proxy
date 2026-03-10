import type {
  ClaudeContentBlock,
  ClaudeImageBlock,
  ClaudeMessage,
  ClaudeRequest,
  ClaudeTextBlock,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
  OpenAIChatMessage,
  OpenAIContentBlock,
} from "../types.ts";
import type { OpenAIToolMessage } from "./tool_format_converter.ts";
import {
  isAnthropicWebFetchTool,
  isAnthropicWebSearchTool,
  isOpenAIWebFetchTool,
  isOpenAIWebSearchTool,
  openAIWebFetchToolToAnthropic,
  openAIWebSearchToolToAnthropic,
} from "./types.ts";

export const OPENAI_CHAT_PASSTHROUGH_METADATA_KEY = "_openai_chat_passthrough";

const OPENAI_CHAT_PASSTHROUGH_KEYS = [
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "n",
  "seed",
  "stop",
  "response_format",
  "modalities",
  "audio",
  "parallel_tool_calls",
  "user",
  "reasoning_effort",
  "max_completion_tokens",
  "prediction",
  "stream_options",
  "service_tier",
  "metadata",
] as const;

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// OpenAI Chat 请求的最小结构定义。
export interface OpenAIRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  seed?: number;
  stop?: string | string[];
  response_format?: Record<string, unknown>;
  modalities?: string[];
  audio?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
  user?: string;
  reasoning_effort?: string;
  prediction?: Record<string, unknown>;
  stream_options?: Record<string, unknown>;
  service_tier?: string;
  metadata?: Record<string, unknown>;
  tools?: any[];
  tool_choice?: any;
  [key: string]: unknown;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
  if (!match) return undefined;

  const mediaType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return undefined;
  }

  return {
    mediaType,
    data: match[2],
  };
}

function openAIImageToClaude(
  block: Extract<OpenAIContentBlock, { type: "image_url" }>,
): ClaudeImageBlock | undefined {
  const url = block.image_url?.url;
  if (!url || typeof url !== "string") {
    return undefined;
  }

  const parsed = parseDataUrl(url);
  if (!parsed) {
    return undefined;
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: parsed.mediaType as ClaudeImageBlock["source"]["media_type"],
      data: parsed.data,
    },
  };
}

function claudeImageToOpenAI(
  block: ClaudeImageBlock,
): Extract<OpenAIContentBlock, { type: "image_url" }> {
  return {
    type: "image_url",
    image_url: {
      url: `data:${block.source.media_type};base64,${block.source.data}`,
    },
  };
}

function extractOpenAIContentBlocks(content: string | OpenAIContentBlock[] | null): ClaudeContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ClaudeContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image_url") {
      const image = openAIImageToClaude(block);
      if (image) {
        blocks.push(image);
      }
    }
  }

  return blocks;
}

function collapseOpenAIContent(blocks: OpenAIContentBlock[]): string | OpenAIContentBlock[] | null {
  if (blocks.length === 0) {
    return null;
  }

  const hasImage = blocks.some((block) => block.type === "image_url");
  if (hasImage) {
    return blocks;
  }

  return blocks
    .filter((block): block is Extract<OpenAIContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// 从 OpenAI 的 content 中提取纯文本内容。
function extractOpenAIText(content: string | OpenAIContentBlock[] | null): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is Extract<OpenAIContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// 负责 OpenAI Chat 与 Anthropic Messages 之间的直接格式转换。
export class MessageFormatConverter {
  // 当 OpenAI 历史中存在连续 tool 消息、后面又没有紧跟 user 消息时，
  // 需要主动补成一条 Anthropic user/tool_result 消息，避免上下文丢失。
  private static flushPendingToolMessages(
    toolMessages: OpenAIToolMessage[],
    messages: ClaudeMessage[],
  ): void {
    if (toolMessages.length === 0) {
      return;
    }

    messages.push({
      role: "user",
      content: toolMessages.map((toolMsg) => ({
        type: "tool_result",
        tool_use_id: toolMsg.tool_call_id,
        content: toolMsg.content,
      })),
    });

    toolMessages.length = 0;
  }

  // Anthropic 请求转换为 OpenAI Chat 请求。
  static anthropicToOpenAI(
    request: ClaudeRequest,
    supportsSystemPrompt: boolean = true,
  ): OpenAIRequest {
    const messages: OpenAIChatMessage[] = [];

    if (request.system) {
      const systemContent = typeof request.system === "string"
        ? request.system
        : request.system
          .filter((block) => block.type === "text")
          .map((block: any) => block.text)
          .join("\n");

      if (systemContent) {
        messages.push({
          role: supportsSystemPrompt ? "system" : "user",
          content: systemContent,
        });
      }
    }

    for (const message of request.messages) {
      if (message.role === "user") {
        this.convertAnthropicUserMessage(message, messages);
      } else if (message.role === "assistant") {
        this.convertAnthropicAssistantMessage(message, messages);
      }
    }

    const result: OpenAIRequest = {
      model: request.model,
      messages,
      stream: request.stream,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      tools: request.tools ? this.convertToolsToOpenAI(request.tools) : undefined,
      tool_choice: request.tool_choice,
    };

    const metadata = (request.metadata && typeof request.metadata === "object")
      ? request.metadata as Record<string, unknown>
      : undefined;
    const passthrough = (metadata?.[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY] &&
      typeof metadata[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY] === "object")
      ? metadata[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY] as Record<string, unknown>
      : undefined;

    if (passthrough) {
      for (const [key, value] of Object.entries(passthrough)) {
        if (value === undefined) continue;
        if ((result as Record<string, unknown>)[key] !== undefined) continue;
        (result as Record<string, unknown>)[key] = value;
      }
    }

    if ((result as Record<string, unknown>).stop === undefined) {
      const stopSequences = (request as any).stop_sequences;
      if (typeof stopSequences === "string") {
        (result as Record<string, unknown>).stop = stopSequences;
      } else if (Array.isArray(stopSequences)) {
        const normalized = stopSequences.filter((item): item is string => typeof item === "string");
        if (normalized.length > 0) {
          (result as Record<string, unknown>).stop = normalized;
        }
      }
    }

    return result;
  }

  // 将 Anthropic 的 user 消息拆成 OpenAI user / tool 消息。
  private static convertAnthropicUserMessage(
    message: ClaudeMessage,
    messages: OpenAIChatMessage[],
  ): void {
    if (typeof message.content === "string") {
      messages.push({
        role: "user",
        content: message.content,
      });
      return;
    }

    const contentBlocks: OpenAIContentBlock[] = [];
    const toolResultBlocks: ClaudeToolResultBlock[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        contentBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        contentBlocks.push(claudeImageToOpenAI(block));
      } else if (block.type === "thinking") {
        contentBlocks.push({ type: "text", text: `<thinking>${block.thinking}</thinking>` });
      } else if (block.type === "tool_result") {
        toolResultBlocks.push(block);
      }
    }

    for (const toolResult of toolResultBlocks) {
      const toolMessage: OpenAIToolMessage = {
        role: "tool",
        tool_call_id: toolResult.tool_use_id,
        content: typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content),
      };
      messages.push(toolMessage as any);
    }

    if (contentBlocks.length > 0) {
      messages.push({
        role: "user",
        content: collapseOpenAIContent(contentBlocks) ?? "",
      });
    }
  }

  // 将 Anthropic assistant 消息转换为 OpenAI assistant 消息。
  private static convertAnthropicAssistantMessage(
    message: ClaudeMessage,
    messages: OpenAIChatMessage[],
  ): void {
    if (typeof message.content === "string") {
      messages.push({
        role: "assistant",
        content: message.content,
      });
      return;
    }

    const contentBlocks: OpenAIContentBlock[] = [];
    const toolUseBlocks: ClaudeToolUseBlock[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        contentBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        contentBlocks.push(claudeImageToOpenAI(block));
      } else if (block.type === "thinking") {
        contentBlocks.push({ type: "text", text: `<thinking>${block.thinking}</thinking>` });
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    const collapsed = collapseOpenAIContent(contentBlocks);

    if (toolUseBlocks.length > 0) {
      messages.push({
        role: "assistant",
        content: collapsed,
        tool_calls: toolUseBlocks.map((toolUse) => ({
          id: toolUse.id,
          type: "function" as const,
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input),
          },
        })),
      } as any);
      return;
    }

    messages.push({
      role: "assistant",
      content: collapsed ?? "",
    });
  }

  // 工具定义从 Anthropic 转到 OpenAI。
  private static convertToolsToOpenAI(tools: any[]): any[] {
    return tools.map((tool) => {
      if (isAnthropicWebSearchTool(tool)) {
        return {
          type: "web_search_preview",
          user_location: tool.user_location,
          allowed_domains: tool.allowed_domains,
          blocked_domains: tool.blocked_domains,
        };
      }

      if (isAnthropicWebFetchTool(tool)) {
        return {
          type: "web_fetch",
        };
      }

      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: "object", properties: {} },
        },
      };
    });
  }

  // OpenAI Chat 请求转换为 Anthropic 请求。
  static openAIToAnthropic(request: OpenAIRequest): ClaudeRequest {
    const messages: ClaudeMessage[] = [];
    let systemPrompt: string | undefined;
    const toolMessages: OpenAIToolMessage[] = [];

    for (const message of request.messages) {
      if (message.role === "system") {
        if (!systemPrompt) {
          systemPrompt = extractOpenAIText(message.content);
        }
        continue;
      }

      if (message.role === "tool") {
        toolMessages.push(message as OpenAIToolMessage);
        continue;
      }

      if (message.role === "user") {
        const content: ClaudeContentBlock[] = [];
        for (const toolMsg of toolMessages) {
          content.push({
            type: "tool_result",
            tool_use_id: toolMsg.tool_call_id,
            content: toolMsg.content,
          });
        }
        toolMessages.length = 0;

        content.push(...extractOpenAIContentBlocks(message.content));

        if (content.length > 0) {
          messages.push({
            role: "user",
            content: content.length === 1 && content[0].type === "text"
              ? (content[0] as ClaudeTextBlock).text
              : content,
          });
        }
        continue;
      }

      this.flushPendingToolMessages(toolMessages, messages);
      this.convertOpenAIAssistantMessage(message, messages);
    }

    this.flushPendingToolMessages(toolMessages, messages);

    const passthrough: Record<string, unknown> = {};
    for (const key of OPENAI_CHAT_PASSTHROUGH_KEYS) {
      const value = request[key];
      if (value !== undefined) {
        passthrough[key] = value;
      }
    }

    const maxTokens = request.max_tokens ?? request.max_completion_tokens ?? 4096;
    const result: ClaudeRequest = {
      model: request.model,
      messages,
      system: systemPrompt,
      stream: request.stream,
      max_tokens: maxTokens,
      temperature: request.temperature,
      top_p: request.top_p,
    };

    if (request.stop !== undefined) {
      const stopSequences = Array.isArray(request.stop)
        ? request.stop.filter((item): item is string => typeof item === "string")
        : [request.stop].filter((item): item is string => typeof item === "string");
      if (stopSequences.length > 0) {
        (result as any).stop_sequences = stopSequences;
      }
    }

    if (request.tools) {
      result.tools = this.convertToolsToAnthropic(request.tools);
    }
    if (request.tool_choice) {
      result.tool_choice = request.tool_choice;
    }
    if (Object.keys(passthrough).length > 0) {
      result.metadata = {
        [OPENAI_CHAT_PASSTHROUGH_METADATA_KEY]: passthrough,
      };
    }

    return result;
  }

  // 将 OpenAI assistant 消息转换为 Anthropic assistant 消息。
  private static convertOpenAIAssistantMessage(
    message: OpenAIChatMessage,
    messages: ClaudeMessage[],
  ): void {
    const content: ClaudeContentBlock[] = extractOpenAIContentBlocks(message.content);

    if (Array.isArray((message as any).tool_calls)) {
      for (const toolCall of (message as any).tool_calls) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          input = {};
        }

        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input,
        });
      }
    }

    messages.push({
      role: "assistant",
      content: content.length === 1 && content[0].type === "text"
        ? (content[0] as ClaudeTextBlock).text
        : content,
    });
  }

  // 工具定义从 OpenAI 转到 Anthropic。
  private static convertToolsToAnthropic(tools: any[]): any[] {
    return tools.map((tool) => {
      if (isOpenAIWebSearchTool(tool)) {
        return openAIWebSearchToolToAnthropic(tool);
      }

      if (isOpenAIWebFetchTool(tool)) {
        return openAIWebFetchToolToAnthropic(tool);
      }

      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      };
    });
  }
}
