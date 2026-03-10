import {
  MessageFormatConverter,
  OPENAI_CHAT_PASSTHROUGH_METADATA_KEY,
  type OpenAIRequest,
} from "./tools/message_format_converter.ts";
import {
  isAnthropicWebFetchTool,
  isAnthropicWebSearchTool,
  isOpenAIWebFetchTool,
  isOpenAIWebSearchTool,
  openAIWebFetchToolToAnthropic,
  openAIWebSearchToolToAnthropic,
} from "./tools/types.ts";
import type {
  ClaudeContentBlock,
  ClaudeImageBlock,
  ClaudeMessage,
  ClaudeRequest,
  ClaudeTextBlock,
  ClaudeToolDefinition,
} from "./types.ts";
import type { SSEEvent } from "./sse.ts";

const encoder = new TextEncoder();

export type DownstreamFormat = "anthropic" | "openai-chat" | "openai-responses";

export interface OpenAIChatCompletionRequest extends OpenAIRequest {}

export interface OpenAIResponsesFunctionTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIResponsesMessageContentItem {
  type?: string;
  text?: string;
  content?: string;
  image_url?: string | { url?: string };
  image?: string | { url?: string };
  name?: string;
  call_id?: string;
  arguments?: string | Record<string, unknown>;
  output?: string;
  detail?: "auto" | "low" | "high";
  summary?: string | OpenAIResponsesMessageContentItem[];
  [key: string]: unknown;
}

export interface OpenAIResponsesInputItem {
  type?: string;
  role?: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIResponsesMessageContentItem[];
  name?: string;
  call_id?: string;
  arguments?: string | Record<string, unknown>;
  output?: string;
  text?: string;
  image_url?: string | { url?: string };
  image?: string | { url?: string };
  detail?: "auto" | "low" | "high";
  [key: string]: unknown;
}

export interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIResponsesInputItem[];
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: OpenAIResponsesFunctionTool[];
  tool_choice?: unknown;
  instructions?: string;
  metadata?: Record<string, unknown>;
  user?: string;
  store?: boolean;
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  truncation?: "disabled" | "auto";
  reasoning?: Record<string, unknown>;
  text?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AnthropicLikeResponse {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: ClaudeContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const OPENAI_RESPONSES_PASSTHROUGH_METADATA_KEY = "_openai_responses_passthrough";

const OPENAI_RESPONSES_PASSTHROUGH_KEYS = [
  "instructions",
  "metadata",
  "user",
  "store",
  "parallel_tool_calls",
  "previous_response_id",
  "truncation",
  "reasoning",
  "text",
  "response_format",
  "service_tier",
] as const;

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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

function normalizeImageUrl(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof (value as any).url === "string") {
    return (value as any).url;
  }
  return undefined;
}

function responseImageToClaude(value: unknown): ClaudeImageBlock | undefined {
  const url = normalizeImageUrl(value);
  if (!url) return undefined;
  const parsed = parseDataUrl(url);
  if (!parsed) return undefined;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: parsed.mediaType as ClaudeImageBlock["source"]["media_type"],
      data: parsed.data,
    },
  };
}

function claudeImageToOpenAIUrl(block: ClaudeImageBlock): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

function textFromContent(
  content: string | OpenAIResponsesMessageContentItem[] | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;

  return content.map((item) => {
    const itemType = item.type ?? "";
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    if (typeof item.output === "string") return item.output;
    if ((itemType === "reasoning" || itemType === "summary_text") && typeof item.summary === "string") {
      return item.summary;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function normalizeToolArguments(argumentsValue: unknown): Record<string, unknown> {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === "string") {
    try {
      return JSON.parse(argumentsValue);
    } catch {
      return {};
    }
  }
  if (typeof argumentsValue === "object") {
    return argumentsValue as Record<string, unknown>;
  }
  return {};
}

function convertResponsesToolsToAnthropic(
  tools: OpenAIResponsesFunctionTool[] | undefined,
): ClaudeToolDefinition[] | undefined {
  if (!tools?.length) return undefined;

  return tools
    .map((tool) => {
      if (isOpenAIWebSearchTool(tool)) {
        return openAIWebSearchToolToAnthropic(tool) as unknown as ClaudeToolDefinition;
      }

      if (isOpenAIWebFetchTool(tool)) {
        return openAIWebFetchToolToAnthropic(tool) as unknown as ClaudeToolDefinition;
      }

      const fn = tool.function ?? {};
      return {
        name: tool.name ?? fn.name ?? "function",
        description: tool.description ?? fn.description,
        input_schema: tool.parameters ?? fn.parameters ?? { type: "object", properties: {} },
      };
    });
}

function inferResponsesRole(item: OpenAIResponsesInputItem): "system" | "user" | "assistant" | undefined {
  if (item.role === "tool") return "user";
  if (item.role) return item.role;

  const itemType = item.type ?? "";
  if (itemType === "message") return "user";
  if (itemType === "input_text" || itemType === "input_image") return "user";
  if (itemType === "output_text" || itemType === "output_image" || itemType === "reasoning") {
    return "assistant";
  }
  return undefined;
}

function pushTextIfPresent(target: ClaudeContentBlock[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    target.push({ type: "text", text: value });
  }
}

function pushThinkingIfPresent(target: ClaudeContentBlock[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    target.push({ type: "thinking", thinking: value } as any);
  }
}

function appendResponsesEntryAsAnthropicBlock(
  entry: OpenAIResponsesMessageContentItem,
  target: ClaudeContentBlock[],
  pendingToolResults: ClaudeContentBlock[],
): void {
  const entryType = entry.type ?? "";

  if (entryType === "function_call") {
    target.push({
      type: "tool_use",
      id: entry.call_id ?? `call_${crypto.randomUUID()}`,
      name: entry.name ?? "function",
      input: normalizeToolArguments(entry.arguments),
    });
    return;
  }

  if (entryType === "function_call_output") {
    pendingToolResults.push({
      type: "tool_result",
      tool_use_id: entry.call_id ?? `call_${crypto.randomUUID()}`,
      content: entry.output ?? textFromContent([entry]),
    });
    return;
  }

  if (entryType === "web_search_call" || entryType === "web_fetch_call") {
    const callEntry = entry as Record<string, unknown>;
    const toolUseId = (typeof callEntry.id === "string" && callEntry.id.length > 0)
      ? callEntry.id
      : (entry.call_id ?? `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`);
    const isFetch = entryType === "web_fetch_call";

    target.push({
      type: "server_tool_use",
      id: toolUseId,
      name: isFetch ? "web_fetch" : "web_search",
      input: isFetch
        ? { url: callEntry.url }
        : { query: callEntry.query },
    } as any);

    if (!isFetch && Array.isArray(callEntry.results)) {
      pendingToolResults.push({
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: callEntry.results,
      } as any);
    }

    if (isFetch && Array.isArray(callEntry.content)) {
      pendingToolResults.push({
        type: "web_fetch_tool_result",
        tool_use_id: toolUseId,
        content: callEntry.content,
      } as any);
    }
    return;
  }

  const image = responseImageToClaude(
    entry.image_url ??
      entry.image ??
      (entryType.includes("image") ? entry.content : undefined),
  );
  if (image) {
    target.push(image);
  }

  if (entryType === "reasoning" || entryType === "summary_text") {
    if (typeof entry.summary === "string") {
      pushThinkingIfPresent(target, entry.summary);
    } else {
      pushThinkingIfPresent(target, textFromContent(Array.isArray(entry.summary) ? entry.summary : undefined));
    }
  }

  pushTextIfPresent(target, entry.text);
  pushTextIfPresent(target, entry.content);
  pushTextIfPresent(target, entry.output);
}

function mapResponsesItemsToAnthropicMessages(items: OpenAIResponsesInputItem[]): {
  system?: string;
  messages: ClaudeMessage[];
} {
  const messages: ClaudeMessage[] = [];
  const pendingToolResults: ClaudeContentBlock[] = [];
  const systemParts: string[] = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }

    messages.push({
      role: "user",
      content: [...pendingToolResults],
    });
    pendingToolResults.length = 0;
  };

  for (const item of items) {
    if (item.type === "web_search_call" || item.type === "web_fetch_call") {
      flushPendingToolResults();
      const callItem = item as unknown as Record<string, unknown>;
      const toolUseId = (typeof callItem.id === "string" && callItem.id.length > 0)
        ? callItem.id
        : (item.call_id ?? `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`);
      const isFetch = item.type === "web_fetch_call";

      messages.push({
        role: "assistant",
        content: [{
          type: "server_tool_use",
          id: toolUseId,
          name: isFetch ? "web_fetch" : "web_search",
          input: isFetch
            ? { url: callItem.url }
            : { query: callItem.query },
        } as any],
      });

      if (!isFetch && Array.isArray(callItem.results)) {
        pendingToolResults.push({
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: callItem.results,
        } as any);
      }

      if (isFetch && Array.isArray(callItem.content)) {
        pendingToolResults.push({
          type: "web_fetch_tool_result",
          tool_use_id: toolUseId,
          content: callItem.content,
        } as any);
      }
      continue;
    }

    if (item.type === "function_call_output") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: item.call_id ?? `call_${crypto.randomUUID()}`,
        content: item.output ?? textFromContent(item.content),
      });
      continue;
    }

    if (item.type === "function_call") {
      flushPendingToolResults();
      messages.push({
        role: "assistant",
        content: [{
          type: "tool_use",
          id: item.call_id ?? `call_${crypto.randomUUID()}`,
          name: item.name ?? "function",
          input: normalizeToolArguments(item.arguments),
        }],
      });
      continue;
    }

    const role = inferResponsesRole(item);
    const contentItems = Array.isArray(item.content) ? item.content : undefined;

    if (role === "system") {
      const topLevelSystem = [
        typeof item.text === "string" ? item.text : "",
        typeof item.content === "string" ? item.content : "",
        textFromContent(contentItems),
      ].filter(Boolean).join("\n");
      const text = topLevelSystem || textFromContent(item.content);
      if (text) systemParts.push(text);
      continue;
    }

    const messageRole = role === "assistant" ? "assistant" : "user";
    if (messageRole === "assistant") {
      flushPendingToolResults();
    }

    const messageContent: ClaudeContentBlock[] = messageRole === "assistant"
      ? []
      : [...pendingToolResults];
    if (messageRole !== "assistant") {
      pendingToolResults.length = 0;
    }

    const topLevelImage = responseImageToClaude(
      item.image_url ??
        item.image ??
        ((item.type ?? "").includes("image") ? item.content : undefined),
    );
    if (topLevelImage) {
      messageContent.push(topLevelImage);
    }

    if (item.type === "reasoning" || item.type === "summary_text") {
      pushThinkingIfPresent(messageContent, typeof item.content === "string" ? item.content : item.text);
    } else {
      pushTextIfPresent(messageContent, item.text);
      if (typeof item.content === "string") {
        pushTextIfPresent(messageContent, item.content);
      }
    }

    for (const entry of contentItems ?? []) {
      appendResponsesEntryAsAnthropicBlock(entry, messageContent, pendingToolResults);
    }

    if (messageContent.length === 0) {
      continue;
    }

    messages.push({
      role: messageRole,
      content: messageContent.length === 1 && messageContent[0].type === "text"
        ? (messageContent[0] as ClaudeTextBlock).text
        : messageContent,
    });
  }

  flushPendingToolResults();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

export function openAIResponsesToAnthropic(request: OpenAIResponsesRequest): ClaudeRequest {
  const normalizedInput = typeof request.input === "string"
    ? [{ role: "user", content: request.input } satisfies OpenAIResponsesInputItem]
    : request.input;

  const { system, messages } = mapResponsesItemsToAnthropicMessages(normalizedInput);
  const passthrough: Record<string, unknown> = {};
  for (const key of OPENAI_RESPONSES_PASSTHROUGH_KEYS) {
    if (request[key] !== undefined) {
      passthrough[key] = request[key];
    }
  }

  const maxOutputTokens = request.max_output_tokens ??
    ((typeof (request as any).max_tokens === "number") ? (request as any).max_tokens : undefined) ??
    4096;
  const result: ClaudeRequest = {
    model: request.model,
    max_tokens: maxOutputTokens,
    messages,
    stream: request.stream,
    system,
    temperature: request.temperature,
    top_p: request.top_p,
  };

  const tools = convertResponsesToolsToAnthropic(request.tools);
  if (tools) {
    result.tools = tools;
  }
  if (request.tool_choice !== undefined) {
    result.tool_choice = request.tool_choice;
  }
  if (Object.keys(passthrough).length > 0) {
    result.metadata = {
      [OPENAI_RESPONSES_PASSTHROUGH_METADATA_KEY]: passthrough,
    };
  }

  return result;
}

function convertOpenAIChatToolToResponsesTool(
  tool: Record<string, unknown>,
): OpenAIResponsesFunctionTool {
  if (isAnthropicWebSearchTool(tool)) {
    return {
      type: "web_search_preview",
      user_location: tool.user_location,
      allowed_domains: tool.allowed_domains,
      blocked_domains: tool.blocked_domains,
    } as OpenAIResponsesFunctionTool;
  }

  if (isAnthropicWebFetchTool(tool)) {
    return {
      type: "web_fetch",
    } as OpenAIResponsesFunctionTool;
  }

  const fn = (tool.function ?? {}) as Record<string, unknown>;
  return {
    type: "function",
    name: (fn.name as string | undefined) ?? (tool.name as string | undefined),
    description: (fn.description as string | undefined) ?? (tool.description as string | undefined),
    parameters: (fn.parameters as Record<string, unknown> | undefined) ??
      (tool.parameters as Record<string, unknown> | undefined) ??
      { type: "object", properties: {} },
  };
}

function convertChatMessageContentToResponsesContent(
  content: string | OpenAIRequest["messages"][number]["content"],
  role: "user" | "assistant" | "system" | "tool",
): string | OpenAIResponsesMessageContentItem[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  const imageType = role === "assistant" ? "output_image" : "input_image";

  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const converted = content.map((block) => {
    if (block.type === "text") {
      return {
        type: textType,
        text: block.text,
      } as OpenAIResponsesMessageContentItem;
    }

    if (block.type === "image_url") {
      return {
        type: imageType,
        image_url: block.image_url,
      } as OpenAIResponsesMessageContentItem;
    }

    return undefined;
  }).filter((item): item is OpenAIResponsesMessageContentItem => !!item);

  return converted.length > 0 ? converted : "";
}

export function anthropicToOpenAIResponsesRequest(
  request: ClaudeRequest,
  model: string,
  supportsSystemPrompt = true,
): OpenAIResponsesRequest {
  const openAIRequest = MessageFormatConverter.anthropicToOpenAI(request, supportsSystemPrompt);

  const input: OpenAIResponsesInputItem[] = [];

  for (const message of openAIRequest.messages) {
    const extendedMessage = message as any;

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: extendedMessage.tool_call_id,
        output: typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? ""),
      });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(extendedMessage.tool_calls)) {
      const convertedAssistantContent = convertChatMessageContentToResponsesContent(
        message.content,
        "assistant",
      );
      if (
        Array.isArray(convertedAssistantContent) && convertedAssistantContent.length > 0
      ) {
        input.push({
          type: "message",
          role: "assistant",
          content: convertedAssistantContent,
        });
      }

      for (const toolCall of (extendedMessage.tool_calls as Array<Record<string, any>>)) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments,
        });
      }
      continue;
    }

    input.push({
      type: "message",
      role: message.role,
      content: convertChatMessageContentToResponsesContent(message.content, message.role),
    });
  }

  const responsesRequest: OpenAIResponsesRequest = {
    model,
    input,
    stream: openAIRequest.stream,
    max_output_tokens: openAIRequest.max_tokens,
    temperature: openAIRequest.temperature,
    top_p: openAIRequest.top_p,
    tools: openAIRequest.tools?.map((tool: Record<string, unknown>) =>
      convertOpenAIChatToolToResponsesTool(tool)
    ),
    tool_choice: openAIRequest.tool_choice,
  };

  const metadata = (request.metadata && typeof request.metadata === "object")
    ? request.metadata as Record<string, unknown>
    : undefined;
  const responsesPassthrough = (metadata?.[OPENAI_RESPONSES_PASSTHROUGH_METADATA_KEY] &&
      typeof metadata[OPENAI_RESPONSES_PASSTHROUGH_METADATA_KEY] === "object")
    ? metadata[OPENAI_RESPONSES_PASSTHROUGH_METADATA_KEY] as Record<string, unknown>
    : {};
  const chatPassthrough = (metadata?.[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY] &&
      typeof metadata[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY] === "object")
    ? metadata[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY] as Record<string, unknown>
    : {};

  const allowedPassthrough = new Set<string>(OPENAI_RESPONSES_PASSTHROUGH_KEYS);
  for (const [key, value] of Object.entries({ ...chatPassthrough, ...responsesPassthrough })) {
    if (!allowedPassthrough.has(key)) continue;
    if (value === undefined) continue;
    if ((responsesRequest as Record<string, unknown>)[key] !== undefined) continue;
    (responsesRequest as Record<string, unknown>)[key] = value;
  }

  return responsesRequest;
}

function normalizeAnthropicBlocks(response: AnthropicLikeResponse): ClaudeContentBlock[] {
  if (Array.isArray(response.content)) {
    return response.content;
  }
  return [];
}

function toChatContentFromBlocks(
  blocks: ClaudeContentBlock[],
): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> | null {
  const converted = blocks.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text } as const;
    }
    if (block.type === "thinking") {
      return { type: "text", text: `<thinking>${block.thinking}</thinking>` } as const;
    }
    if (block.type === "image") {
      return {
        type: "image_url",
        image_url: { url: claudeImageToOpenAIUrl(block) },
      } as const;
    }
    return undefined;
  }).filter((item): item is
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } } => !!item);

  if (converted.length === 0) {
    return null;
  }

  const hasImage = converted.some((item) => item.type === "image_url");
  if (!hasImage) {
    return converted
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  }

  return converted;
}

function toResponsesMessageContentFromBlocks(blocks: ClaudeContentBlock[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    if (block.type === "text") {
      content.push({
        type: "output_text",
        text: block.text,
        annotations: [],
      });
      continue;
    }

    if (block.type === "thinking") {
      content.push({
        type: "output_text",
        text: `<thinking>${block.thinking}</thinking>`,
        annotations: [],
      });
      continue;
    }

    if (block.type === "image") {
      content.push({
        type: "output_image",
        image_url: claudeImageToOpenAIUrl(block),
      });
    }
  }

  return content;
}

function mapStopReason(stopReason?: string | null): string {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return "stop";
  return stopReason ?? "stop";
}

export function anthropicToOpenAIChatResponse(
  response: AnthropicLikeResponse,
  modelOverride?: string,
): Record<string, unknown> {
  const blocks = normalizeAnthropicBlocks(response);
  const messageContent = toChatContentFromBlocks(blocks);
  const toolCalls = (blocks as Array<Record<string, any>>)
    .filter((block) => block.type === "tool_use" || block.type === "server_tool_use")
    .map((block, index) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.type === "server_tool_use"
          ? (block.name === "web_fetch" ? "web_fetch" : "web_search_preview")
          : block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
      index,
    }));

  return {
    id: response.id ?? `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelOverride ?? response.model ?? "unknown",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: messageContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapStopReason(response.stop_reason),
    }],
    usage: response.usage
      ? {
        prompt_tokens: response.usage.input_tokens ?? 0,
        completion_tokens: response.usage.output_tokens ?? 0,
        total_tokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
      }
      : undefined,
  };
}

export function anthropicToOpenAIResponsesResponse(
  response: AnthropicLikeResponse,
  modelOverride?: string,
): Record<string, unknown> {
  const blocks = normalizeAnthropicBlocks(response);
  const output: Record<string, unknown>[] = [];
  const pendingToolResults = new Map<string, Record<string, unknown>>();
  const messageContent = toResponsesMessageContentFromBlocks(blocks);

  if (messageContent.length > 0) {
    output.push({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: messageContent,
    });
  }

  for (const block of blocks as Array<Record<string, any>>) {
    if (block.type === "web_search_tool_result") {
      pendingToolResults.set(block.tool_use_id, {
        type: "web_search_call",
        id: block.tool_use_id,
        status: "completed",
        results: block.content ?? [],
      });
      continue;
    }

    if (block.type === "web_fetch_tool_result") {
      pendingToolResults.set(block.tool_use_id, {
        type: "web_fetch_call",
        id: block.tool_use_id,
        status: "completed",
        content: block.content ?? [],
      });
      continue;
    }
  }

  for (const block of blocks as Array<Record<string, any>>) {
    if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
      continue;
    }

    if (block.type === "server_tool_use") {
      const baseItem = pendingToolResults.get(block.id) ?? {
        type: block.name === "web_fetch" ? "web_fetch_call" : "web_search_call",
        id: block.id,
        status: "completed",
      };

      if (block.name === "web_fetch") {
        output.push({
          ...baseItem,
          url: block.input?.url,
        });
      } else {
        output.push({
          ...baseItem,
          query: block.input?.query,
        });
      }
      continue;
    }

    if (block.type !== "tool_use") continue;
    output.push({
      id: block.id,
      type: "function_call",
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
      status: "completed",
    });
  }

  return {
    id: response.id ?? `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: modelOverride ?? response.model ?? "unknown",
    output,
    usage: response.usage
      ? {
        input_tokens: response.usage.input_tokens ?? 0,
        output_tokens: response.usage.output_tokens ?? 0,
        total_tokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
      }
      : undefined,
  };
}

function emitRawSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: string,
): boolean {
  try {
    controller.enqueue(encoder.encode(payload));
    return true;
  } catch {
    return false;
  }
}

class BaseOpenAIStreamWriter {
  protected closed = false;

  constructor(
    protected controller: ReadableStreamDefaultController<Uint8Array>,
    protected requestId: string,
  ) {}

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // ignore double close
    }
  }
}

export class OpenAIChatCompletionStreamWriter extends BaseOpenAIStreamWriter {
  private model = "unknown";
  private created = Math.floor(Date.now() / 1000);
  private sentRoleChunk = false;
  private finishReason: string | null = null;
  private sentDone = false;
  private toolIndices = new Map<number, number>();
  private nextToolIndex = 0;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private openThinkingBlocks = new Set<number>();

  private emitChunk(delta: Record<string, unknown>, finishReason: string | null = null): boolean {
    const chunk = {
      id: `chatcmpl_${this.requestId}`,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
    return emitRawSse(this.controller, `data: ${JSON.stringify(chunk)}\n\n`);
  }

  private emitDone(): boolean {
    if (this.sentDone) return true;
    this.sentDone = true;
    return emitRawSse(this.controller, "data: [DONE]\n\n");
  }

  async send(event: SSEEvent): Promise<boolean> {
    if (this.closed) return false;
    const data = event.data as Record<string, any>;

    if (event.event === "message_start") {
      this.model = data.message?.model ?? this.model;
      if (!this.sentRoleChunk) {
        this.sentRoleChunk = true;
        return this.emitChunk({ role: "assistant" });
      }
      return true;
    }

    if (
      event.event === "content_block_start" &&
      (data.content_block?.type === "tool_use" || data.content_block?.type === "server_tool_use")
    ) {
      const toolIndex = this.nextToolIndex++;
      this.toolIndices.set(data.index, toolIndex);
      const toolName = data.content_block?.type === "server_tool_use"
        ? (data.content_block.name === "web_fetch" ? "web_fetch" : "web_search_preview")
        : data.content_block.name;
      this.toolCalls.set(data.index, {
        id: data.content_block.id,
        name: toolName,
        arguments: "",
      });
      return this.emitChunk({
        tool_calls: [{
          index: toolIndex,
          id: data.content_block.id,
          type: "function",
          function: {
            name: toolName,
            arguments: "",
          },
        }],
      });
    }

    if (event.event === "content_block_start" && data.content_block?.type === "thinking") {
      this.openThinkingBlocks.add(data.index as number);
      return this.emitChunk({ content: "<thinking>" });
    }

    if (event.event === "content_block_delta") {
      if (data.delta?.type === "text_delta") {
        return this.emitChunk({ content: data.delta.text ?? "" });
      }
      if (data.delta?.type === "thinking_delta") {
        return this.emitChunk({ content: data.delta.thinking ?? "" });
      }
      if (data.delta?.type === "input_json_delta") {
        const blockIndex = data.index as number;
        const toolIndex = this.toolIndices.get(blockIndex) ?? 0;
        const toolCall = this.toolCalls.get(blockIndex);
        if (toolCall) {
          toolCall.arguments += data.delta.partial_json ?? "";
        }
        return this.emitChunk({
          tool_calls: [{
            index: toolIndex,
            id: toolCall?.id,
            type: "function",
            function: {
              arguments: data.delta.partial_json ?? "",
            },
          }],
        });
      }
      return true;
    }

    if (event.event === "content_block_stop" && this.openThinkingBlocks.has(data.index as number)) {
      this.openThinkingBlocks.delete(data.index as number);
      return this.emitChunk({ content: "</thinking>" });
    }

    if (event.event === "message_delta") {
      this.finishReason = mapStopReason(data.delta?.stop_reason);
      return true;
    }

    if (event.event === "message_stop") {
      if (this.finishReason) {
        this.emitChunk({}, this.finishReason);
      }
      this.emitDone();
      return true;
    }

    if (event.event === "error") {
      return emitRawSse(this.controller, `data: ${JSON.stringify(data)}\n\n`);
    }

    return true;
  }
}

export class OpenAIResponsesStreamWriter extends BaseOpenAIStreamWriter {
  private responseId = `resp_${this.requestId}`;
  private model = "unknown";
  private createdAt = Math.floor(Date.now() / 1000);
  private outputIndex = 0;
  private completed = false;
  private blocks = new Map<number, {
    kind: "text" | "thinking" | "tool" | "web_search" | "web_fetch";
    itemId: string;
    contentIndex: number;
    text: string;
    name?: string;
    callId?: string;
    arguments: string;
    payload?: Record<string, unknown>;
  }>();
  private finalUsage: { input_tokens?: number; output_tokens?: number } | undefined;

  private emitEvent(eventName: string, payload: Record<string, unknown>): boolean {
    return emitRawSse(
      this.controller,
      `event: ${eventName}\ndata: ${JSON.stringify({ type: eventName, ...payload })}\n\n`,
    );
  }

  async send(event: SSEEvent): Promise<boolean> {
    if (this.closed) return false;
    const data = event.data as Record<string, any>;

    if (event.event === "message_start") {
      this.model = data.message?.model ?? this.model;
      this.responseId = data.message?.id?.replace(/^msg_/, "resp_") ?? this.responseId;
      return this.emitEvent("response.created", {
        response: {
          id: this.responseId,
          object: "response",
          created_at: this.createdAt,
          status: "in_progress",
          model: this.model,
          output: [],
        },
      });
    }

    if (event.event === "content_block_start" && data.content_block?.type === "text") {
      const itemId = `msg_${crypto.randomUUID()}`;
      this.blocks.set(data.index, {
        kind: "text",
        itemId,
        contentIndex: 0,
        text: "",
        arguments: "",
      });
      return this.emitEvent("response.output_item.added", {
        output_index: this.outputIndex,
        item: {
          id: itemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "", annotations: [] }],
        },
      });
    }

    if (event.event === "content_block_start" && data.content_block?.type === "thinking") {
      const itemId = `msg_${crypto.randomUUID()}`;
      this.blocks.set(data.index, {
        kind: "thinking",
        itemId,
        contentIndex: 0,
        text: "<thinking>",
        arguments: "",
      });
      const emitted = this.emitEvent("response.output_item.added", {
        output_index: this.outputIndex,
        item: {
          id: itemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "", annotations: [] }],
        },
      });
      this.emitEvent("response.output_text.delta", {
        output_index: this.outputIndex,
        item_id: itemId,
        content_index: 0,
        delta: "<thinking>",
      });
      return emitted;
    }

    if (event.event === "content_block_start" && data.content_block?.type === "tool_use") {
      const itemId = data.content_block.id ?? `fc_${crypto.randomUUID()}`;
      this.blocks.set(data.index, {
        kind: "tool",
        itemId,
        contentIndex: 0,
        text: "",
        name: data.content_block.name,
        callId: data.content_block.id,
        arguments: "",
      });
      return this.emitEvent("response.output_item.added", {
        output_index: this.outputIndex,
        item: {
          id: itemId,
          type: "function_call",
          status: "in_progress",
          call_id: data.content_block.id,
          name: data.content_block.name,
          arguments: "",
        },
      });
    }

    if (event.event === "content_block_start" && data.content_block?.type === "server_tool_use") {
      const itemId = data.content_block.id ?? `wc_${crypto.randomUUID()}`;
      const isFetch = data.content_block.name === "web_fetch";
      this.blocks.set(data.index, {
        kind: isFetch ? "web_fetch" : "web_search",
        itemId,
        contentIndex: 0,
        text: "",
        name: data.content_block.name,
        callId: data.content_block.id,
        arguments: "",
        payload: {},
      });
      return this.emitEvent("response.output_item.added", {
        output_index: this.outputIndex,
        item: {
          id: itemId,
          type: isFetch ? "web_fetch_call" : "web_search_call",
          status: "in_progress",
          ...(isFetch ? { url: undefined } : { query: undefined }),
        },
      });
    }

    if (event.event === "content_block_delta") {
      const block = this.blocks.get(data.index);
      if (!block) return true;

      if (data.delta?.type === "text_delta" && block.kind === "text") {
        block.text += data.delta.text ?? "";
        return this.emitEvent("response.output_text.delta", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          content_index: block.contentIndex,
          delta: data.delta.text ?? "",
        });
      }

      if (data.delta?.type === "thinking_delta" && block.kind === "thinking") {
        block.text += data.delta.thinking ?? "";
        return this.emitEvent("response.output_text.delta", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          content_index: block.contentIndex,
          delta: data.delta.thinking ?? "",
        });
      }

      if (data.delta?.type === "input_json_delta" && block.kind === "tool") {
        block.arguments += data.delta.partial_json ?? "";
        return this.emitEvent("response.function_call_arguments.delta", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          delta: data.delta.partial_json ?? "",
        });
      }

      if (
        data.delta?.type === "input_json_delta" &&
        (block.kind === "web_search" || block.kind === "web_fetch")
      ) {
        block.arguments += data.delta.partial_json ?? "";
        try {
          block.payload = JSON.parse(block.arguments || "{}");
        } catch {
          block.payload = block.payload ?? {};
        }
        return true;
      }

      return true;
    }

    if (
      event.event === "content_block_start" && data.content_block?.type === "web_search_tool_result"
    ) {
      const existingEntry = [...this.blocks.entries()].find(([, block]) =>
        block.itemId === data.content_block.tool_use_id
      );
      if (existingEntry) {
        const [blockIndex, existing] = existingEntry;
        existing.payload = {
          ...(existing.payload ?? {}),
          results: data.content_block.content ?? [],
        };
        this.emitEvent("response.output_item.done", {
          output_index: this.outputIndex,
          item: {
            id: existing.itemId,
            type: "web_search_call",
            status: "completed",
            query: existing.payload?.query,
            ...(existing.payload?.results ? { results: existing.payload.results } : {}),
          },
        });
        this.blocks.delete(blockIndex);
        this.outputIndex += 1;
      }
      return true;
    }

    if (
      event.event === "content_block_start" && data.content_block?.type === "web_fetch_tool_result"
    ) {
      const existingEntry = [...this.blocks.entries()].find(([, block]) =>
        block.itemId === data.content_block.tool_use_id
      );
      if (existingEntry) {
        const [blockIndex, existing] = existingEntry;
        existing.payload = {
          ...(existing.payload ?? {}),
          content: data.content_block.content ?? [],
        };
        this.emitEvent("response.output_item.done", {
          output_index: this.outputIndex,
          item: {
            id: existing.itemId,
            type: "web_fetch_call",
            status: "completed",
            url: existing.payload?.url,
            ...(existing.payload?.content ? { content: existing.payload.content } : {}),
          },
        });
        this.blocks.delete(blockIndex);
        this.outputIndex += 1;
      }
      return true;
    }

    if (event.event === "content_block_stop") {
      const block = this.blocks.get(data.index);
      if (!block) return true;

      if (block.kind === "text") {
        this.emitEvent("response.output_text.done", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          content_index: block.contentIndex,
          text: block.text,
        });
        this.emitEvent("response.output_item.done", {
          output_index: this.outputIndex,
          item: {
            id: block.itemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
          },
        });
      } else if (block.kind === "thinking") {
        block.text += "</thinking>";
        this.emitEvent("response.output_text.delta", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          content_index: block.contentIndex,
          delta: "</thinking>",
        });
        this.emitEvent("response.output_text.done", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          content_index: block.contentIndex,
          text: block.text,
        });
        this.emitEvent("response.output_item.done", {
          output_index: this.outputIndex,
          item: {
            id: block.itemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
          },
        });
      } else if (block.kind === "tool") {
        this.emitEvent("response.function_call_arguments.done", {
          output_index: this.outputIndex,
          item_id: block.itemId,
          arguments: block.arguments,
        });
        this.emitEvent("response.output_item.done", {
          output_index: this.outputIndex,
          item: {
            id: block.itemId,
            type: "function_call",
            status: "completed",
            call_id: block.callId,
            name: block.name,
            arguments: block.arguments,
          },
        });
      } else {
        return true;
      }

      this.blocks.delete(data.index);
      this.outputIndex += 1;
      return true;
    }

    if (event.event === "message_delta") {
      this.finalUsage = {
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
      };
      return true;
    }

    if (event.event === "message_stop" && !this.completed) {
      for (const [blockIndex, block] of [...this.blocks.entries()]) {
        if (block.kind !== "web_search" && block.kind !== "web_fetch") continue;
        const isFetch = block.kind === "web_fetch";
        this.emitEvent("response.output_item.done", {
          output_index: this.outputIndex,
          item: {
            id: block.itemId,
            type: isFetch ? "web_fetch_call" : "web_search_call",
            status: "completed",
            ...(isFetch ? { url: block.payload?.url } : { query: block.payload?.query }),
            ...(block.payload?.results ? { results: block.payload.results } : {}),
            ...(block.payload?.content ? { content: block.payload.content } : {}),
          },
        });
        this.blocks.delete(blockIndex);
        this.outputIndex += 1;
      }

      this.completed = true;
      return this.emitEvent("response.completed", {
        response: {
          id: this.responseId,
          object: "response",
          created_at: this.createdAt,
          status: "completed",
          model: this.model,
          output: [],
          usage: this.finalUsage
            ? {
              input_tokens: this.finalUsage.input_tokens ?? 0,
              output_tokens: this.finalUsage.output_tokens ?? 0,
              total_tokens: (this.finalUsage.input_tokens ?? 0) +
                (this.finalUsage.output_tokens ?? 0),
            }
            : undefined,
        },
      });
    }

    if (event.event === "error") {
      return this.emitEvent("response.error", {
        error: data.error ?? data,
      });
    }

    return true;
  }
}
