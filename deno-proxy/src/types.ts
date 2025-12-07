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

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

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
}

export interface ClaudeToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

export type ParserEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; call: ParsedInvokeCall }
  | { type: "end" };
