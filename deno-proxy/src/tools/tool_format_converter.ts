/**
 * 工具格式转换器
 *
 * 严格按照官方 API 格式规范实现 Anthropic ↔ OpenAI 工具调用格式转换
 *
 * 参考文档：
 * - Anthropic: https://docs.anthropic.com/claude/docs/tool-use
 * - OpenAI: https://platform.openai.com/docs/guides/function-calling
 */

import type { ClaudeToolDefinition, ClaudeToolResultBlock, ClaudeToolUseBlock } from "../types.ts";

/**
 * OpenAI 工具定义格式
 * 官方格式：https://platform.openai.com/docs/api-reference/chat/create#chat-create-tools
 */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/**
 * OpenAI 工具调用格式（响应中）
 * 官方格式：https://platform.openai.com/docs/api-reference/chat/object#chat/object-tool_calls
 */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

/**
 * OpenAI 工具消息格式（请求中）
 * 官方格式：https://platform.openai.com/docs/api-reference/chat/create#chat-create-messages
 */
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/**
 * 工具定义转换器
 */
export class ToolDefinitionConverter {
  /**
   * Anthropic 工具定义 → OpenAI 工具定义
   *
   * Anthropic 格式:
   * {
   *   "name": "get_weather",
   *   "description": "Get weather info",
   *   "input_schema": { "type": "object", "properties": {...}, "required": [...] }
   * }
   *
   * OpenAI 格式:
   * {
   *   "type": "function",
   *   "function": {
   *     "name": "get_weather",
   *     "description": "Get weather info",
   *     "parameters": { "type": "object", "properties": {...}, "required": [...] }
   *   }
   * }
   */
  static anthropicToOpenAI(tools: ClaudeToolDefinition[]): OpenAIToolDefinition[] {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  /**
   * OpenAI 工具定义 → Anthropic 工具定义
   */
  static openAIToAnthropic(tools: OpenAIToolDefinition[]): ClaudeToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }
}

/**
 * 工具调用转换器
 */
export class ToolCallConverter {
  /**
   * OpenAI 工具调用 → Anthropic 工具调用
   *
   * OpenAI 格式:
   * {
   *   "id": "call_abc123",
   *   "type": "function",
   *   "function": {
   *     "name": "get_weather",
   *     "arguments": "{\"location\":\"Tokyo\"}"
   *   }
   * }
   *
   * Anthropic 格式:
   * {
   *   "type": "tool_use",
   *   "id": "toolu_abc123",
   *   "name": "get_weather",
   *   "input": { "location": "Tokyo" }
   * }
   */
  static openAIToAnthropic(toolCall: OpenAIToolCall): ClaudeToolUseBlock {
    let input: Record<string, unknown>;

    try {
      // OpenAI 的 arguments 是 JSON 字符串，需要解析
      input = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      console.error(`Failed to parse tool arguments: ${toolCall.function.arguments}`, e);
      input = {}; // 解析失败时使用空对象
    }

    return {
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input,
    };
  }

  /**
   * Anthropic 工具调用 → OpenAI 工具调用
   */
  static anthropicToOpenAI(toolUse: ClaudeToolUseBlock): OpenAIToolCall {
    return {
      id: toolUse.id,
      type: "function",
      function: {
        name: toolUse.name,
        arguments: JSON.stringify(toolUse.input),
      },
    };
  }
}

/**
 * 工具结果转换器
 */
export class ToolResultConverter {
  /**
   * Anthropic 工具结果 → OpenAI 工具消息
   *
   * Anthropic 格式（在 user 消息的 content 数组中）:
   * {
   *   "type": "tool_result",
   *   "tool_use_id": "toolu_abc123",
   *   "content": "Sunny, 25°C"
   * }
   *
   * OpenAI 格式（独立的 message）:
   * {
   *   "role": "tool",
   *   "tool_call_id": "call_abc123",
   *   "content": "Sunny, 25°C"
   * }
   */
  static anthropicToOpenAI(toolResult: ClaudeToolResultBlock): OpenAIToolMessage {
    return {
      role: "tool",
      tool_call_id: toolResult.tool_use_id,
      content: typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content),
    };
  }

  /**
   * OpenAI 工具消息 → Anthropic 工具结果
   */
  static openAIToAnthropic(toolMessage: OpenAIToolMessage): ClaudeToolResultBlock {
    return {
      type: "tool_result",
      tool_use_id: toolMessage.tool_call_id,
      content: toolMessage.content,
    };
  }
}

/**
 * 统一的工具格式转换器
 */
export class ToolFormatConverter {
  /**
   * 转换工具定义：Anthropic → OpenAI
   */
  static convertToolDefinitionsToOpenAI(tools: ClaudeToolDefinition[]): OpenAIToolDefinition[] {
    return ToolDefinitionConverter.anthropicToOpenAI(tools);
  }

  /**
   * 转换工具定义：OpenAI → Anthropic
   */
  static convertToolDefinitionsToAnthropic(tools: OpenAIToolDefinition[]): ClaudeToolDefinition[] {
    return ToolDefinitionConverter.openAIToAnthropic(tools);
  }

  /**
   * 转换工具调用：OpenAI → Anthropic
   */
  static convertToolCallToAnthropic(toolCall: OpenAIToolCall): ClaudeToolUseBlock {
    return ToolCallConverter.openAIToAnthropic(toolCall);
  }

  /**
   * 转换工具调用：Anthropic → OpenAI
   */
  static convertToolCallToOpenAI(toolUse: ClaudeToolUseBlock): OpenAIToolCall {
    return ToolCallConverter.anthropicToOpenAI(toolUse);
  }

  /**
   * 转换工具结果：Anthropic → OpenAI
   */
  static convertToolResultToOpenAI(toolResult: ClaudeToolResultBlock): OpenAIToolMessage {
    return ToolResultConverter.anthropicToOpenAI(toolResult);
  }

  /**
   * 转换工具结果：OpenAI → Anthropic
   */
  static convertToolResultToAnthropic(toolMessage: OpenAIToolMessage): ClaudeToolResultBlock {
    return ToolResultConverter.openAIToAnthropic(toolMessage);
  }
}
