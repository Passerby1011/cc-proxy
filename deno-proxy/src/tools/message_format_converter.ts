/**
 * 消息格式转换器
 *
 * 严格按照官方 API 格式规范实现 Anthropic ↔ OpenAI 消息格式转换
 *
 * 关键差异：
 * 1. 系统提示词：Anthropic 使用 system 字段，OpenAI 使用 system 角色消息
 * 2. 工具结果：Anthropic 在 user 消息的 content 数组中，OpenAI 使用独立的 tool 角色消息
 * 3. 内容格式：Anthropic 使用 content 数组，OpenAI 可以使用字符串或数组
 */

import type {
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeTextBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  OpenAIChatMessage,
  ClaudeRequest,
} from "../types.ts";
import type { OpenAIToolMessage } from "./tool_format_converter.ts";

/**
 * OpenAI 请求格式
 */
export interface OpenAIRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: any[];
  tool_choice?: any;
}

/**
 * 消息格式转换器
 */
export class MessageFormatConverter {
  /**
   * Anthropic 请求 → OpenAI 请求
   *
   * 关键转换：
   * 1. 提取 system 字段，转为 system 角色消息（插入到消息列表头部）
   * 2. 转换消息列表中的 tool_result 为 tool 角色消息
   * 3. 转换消息列表中的 tool_use 为 assistant 消息（带 tool_calls）
   * 
   * @param request Anthropic 请求
   * @param supportsSystemPrompt 是否支持系统提示词（默认 true，不支持时转换为 user 消息）
   */
  static anthropicToOpenAI(request: ClaudeRequest, supportsSystemPrompt: boolean = true): OpenAIRequest {
    const messages: OpenAIChatMessage[] = [];

    // 1. 处理 system 提示词
    if (request.system) {
      const systemContent = typeof request.system === "string"
        ? request.system
        : request.system
          .filter(block => block.type === "text")
          .map((block: any) => block.text)
          .join("\n");

      if (systemContent) {
        messages.push({
          role: supportsSystemPrompt ? "system" : "user",
          content: systemContent,
        });
      }
    }

    // 2. 转换消息列表
    for (const message of request.messages) {
      if (message.role === "user") {
        this.convertAnthropicUserMessage(message, messages);
      } else if (message.role === "assistant") {
        this.convertAnthropicAssistantMessage(message, messages);
      }
    }

    return {
      model: request.model,
      messages,
      stream: request.stream,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      tools: request.tools ? this.convertToolsToOpenAI(request.tools) : undefined,
      tool_choice: request.tool_choice,
    };
  }

  /**
   * 转换 Anthropic user 消息 → OpenAI user/tool 消息
   */
  private static convertAnthropicUserMessage(
    message: ClaudeMessage,
    messages: OpenAIChatMessage[],
  ): void {
    if (typeof message.content === "string") {
      // 简单文本消息
      messages.push({
        role: "user",
        content: message.content,
      });
      return;
    }

    // content 是数组，需要分离 tool_result 和其他内容
    const textBlocks: ClaudeTextBlock[] = [];
    const toolResultBlocks: ClaudeToolResultBlock[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        textBlocks.push(block);
      } else if (block.type === "tool_result") {
        toolResultBlocks.push(block);
      }
    }

    // 先添加 tool 角色消息（工具结果）
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

    // 如果有文本内容，添加 user 消息
    if (textBlocks.length > 0) {
      const textContent = textBlocks.map(block => block.text).join("\n");
      messages.push({
        role: "user",
        content: textContent,
      });
    }
  }

  /**
   * 转换 Anthropic assistant 消息 → OpenAI assistant 消息
   */
  private static convertAnthropicAssistantMessage(
    message: ClaudeMessage,
    messages: OpenAIChatMessage[],
  ): void {
    if (typeof message.content === "string") {
      // 简单文本消息
      messages.push({
        role: "assistant",
        content: message.content,
      });
      return;
    }

    // content 是数组，可能包含 text 和 tool_use
    const textBlocks: ClaudeTextBlock[] = [];
    const toolUseBlocks: ClaudeToolUseBlock[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        textBlocks.push(block);
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    // 构建 assistant 消息
    const textContent = textBlocks.map(block => block.text).join("\n");

    if (toolUseBlocks.length > 0) {
      // 有工具调用，需要构建 tool_calls
      const toolCalls = toolUseBlocks.map(toolUse => ({
        id: toolUse.id,
        type: "function" as const,
        function: {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input),
        },
      }));

      messages.push({
        role: "assistant",
        content: textContent || null, // OpenAI 要求有 tool_calls 时 content 可以为 null
        tool_calls: toolCalls,
      } as any);
    } else {
      // 只有文本，普通 assistant 消息
      messages.push({
        role: "assistant",
        content: textContent,
      });
    }
  }

  /**
   * 转换工具定义（简化版，实际应使用 ToolFormatConverter）
   */
  private static convertToolsToOpenAI(tools: any[]): any[] {
    return tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  /**
   * OpenAI 请求 → Anthropic 请求
   *
   * 关键转换：
   * 1. 提取 system 角色消息，转为 system 字段
   * 2. 转换 tool 角色消息为 tool_result（放入 user 消息的 content 数组）
   * 3. 转换 assistant 消息中的 tool_calls 为 tool_use
   */
  static openAIToAnthropic(request: OpenAIRequest): ClaudeRequest {
    const messages: ClaudeMessage[] = [];
    let systemPrompt: string | undefined;

    // 1. 处理消息列表
    const toolMessages: OpenAIToolMessage[] = [];

    for (let i = 0; i < request.messages.length; i++) {
      const message = request.messages[i];

      if (message.role === "system") {
        // 提取 system 提示词
        if (!systemPrompt) {
          systemPrompt = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        }
      } else if (message.role === "tool") {
        // 收集 tool 消息，稍后合并到 user 消息
        toolMessages.push(message as any);
      } else if (message.role === "user") {
        // 检查是否需要合并 tool 消息
        const content: ClaudeContentBlock[] = [];

        // 先添加收集的 tool_result
        for (const toolMsg of toolMessages) {
          content.push({
            type: "tool_result",
            tool_use_id: (toolMsg as any).tool_call_id,
            content: toolMsg.content,
          });
        }
        toolMessages.length = 0; // 清空

        // 添加当前 user 消息的内容
        if (typeof message.content === "string") {
          content.push({
            type: "text",
            text: message.content,
          });
        }

        messages.push({
          role: "user",
          content: content.length === 1 && content[0].type === "text"
            ? (content[0] as ClaudeTextBlock).text
            : content,
        });
      } else if (message.role === "assistant") {
        // 转换 assistant 消息
        this.convertOpenAIAssistantMessage(message, messages);
      }
    }

    const result: ClaudeRequest = {
      model: request.model,
      messages,
      system: systemPrompt,
      stream: request.stream,
      max_tokens: request.max_tokens || 4096,
      temperature: request.temperature,
      top_p: request.top_p,
    };

    // 只在有值时添加这些字段
    if (request.tools) {
      result.tools = this.convertToolsToAnthropic(request.tools);
    }
    if (request.tool_choice) {
      result.tool_choice = request.tool_choice;
    }

    return result;
  }

  /**
   * 转换 OpenAI assistant 消息 → Anthropic assistant 消息
   */
  private static convertOpenAIAssistantMessage(
    message: OpenAIChatMessage,
    messages: ClaudeMessage[],
  ): void {
    const content: ClaudeContentBlock[] = [];

    // 添加文本内容
    if (message.content && typeof message.content === "string") {
      content.push({
        type: "text",
        text: message.content,
      });
    }

    // 添加工具调用
    if ((message as any).tool_calls) {
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

  /**
   * 转换工具定义（简化版，实际应使用 ToolFormatConverter）
   */
  private static convertToolsToAnthropic(tools: any[]): any[] {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }
}
