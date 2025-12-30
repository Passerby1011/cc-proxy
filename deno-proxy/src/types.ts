export type ClaudeRole = "user" | "assistant";

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ClaudeImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | ClaudeImageBlock;

export interface ClaudeMessage {
  role: ClaudeRole;
  content: string | ClaudeContentBlock[];
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string | ClaudeContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, unknown>;
  tools?: ClaudeToolDefinition[];
  tool_choice?: unknown;
  thinking?: ThinkingConfigParam;
}

export interface ThinkingConfigParam {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export interface ClaudeToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface OpenAIImageURLBlock {
  type: "image_url";
  image_url: {
    url: string; // data:image/jpeg;base64,xxxx
    detail?: "auto" | "low" | "high";
  };
}

export interface OpenAITextBlock {
  type: "text";
  text: string;
}

export type OpenAIContentBlock = OpenAITextBlock | OpenAIImageURLBlock;

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentBlock[];
}

export interface OpenAIChatRequest {
  model: string;
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  messages: OpenAIChatMessage[];
}

export interface ParsedInvokeCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedThinkingCall {
  content: string;
}

export type ParserEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; call: ParsedInvokeCall }
  | { type: "thinking"; content: string }
  | { type: "end" };
