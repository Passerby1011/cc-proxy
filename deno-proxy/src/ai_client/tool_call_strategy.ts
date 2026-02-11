/**
 * 工具调用策略抽象层
 *
 * 支持多种工具调用方式：
 * - 📌 当前实现：提示词注入（PromptInjectionStrategy）
 * - 🔮 未来扩展：原生工具调用（NativeToolCallStrategy）、自动选择（AutoStrategy）
 */

import { ClaudeRequest, ClaudeMessage, ParsedInvokeCall } from "../types.ts";
import { ToolCallDelimiter } from "../signals.ts";
import { enrichClaudeRequest } from "../prompt_inject.ts";
import { ToolifyParser } from "../parser.ts";

/**
 * 准备好的请求
 */
export interface PreparedRequest {
  /** 处理后的请求 */
  request: ClaudeRequest;

  /** 工具调用分隔符（仅提示词注入模式使用） */
  delimiter?: ToolCallDelimiter;
}

/**
 * 工具调用结果
 */
export interface ToolCall {
  /** 工具名称 */
  name: string;

  /** 工具参数 */
  arguments: Record<string, unknown>;
}

/**
 * 工具调用策略接口
 */
export interface ToolCallStrategy {
  /**
   * 准备请求（注入工具定义或使用原生格式）
   *
   * @param request 原始请求
   * @returns 准备好的请求
   */
  prepareRequest(request: ClaudeRequest): PreparedRequest;

  /**
   * 解析响应中的工具调用
   *
   * @param response 响应文本或对象
   * @param delimiter 工具调用分隔符（可选）
   * @returns 解析出的工具调用列表
   */
  parseResponse(response: string | unknown, delimiter?: ToolCallDelimiter): ToolCall[];

  /**
   * 是否支持流式处理
   */
  supportsStreaming(): boolean;

  /**
   * 获取策略名称
   */
  getName(): string;
}

/**
 * 提示词注入策略
 *
 * 📌 当前实现：使用现有的 enrichClaudeRequest 和 ToolifyParser
 */
export class PromptInjectionStrategy implements ToolCallStrategy {
  /**
   * 准备请求 - 使用提示词注入方式
   */
  prepareRequest(request: ClaudeRequest): PreparedRequest {
    // 如果请求没有工具定义，直接返回
    if (!request.tools || request.tools.length === 0) {
      return { request };
    }

    // 使用 enrichClaudeRequest 注入工具定义到 system prompt
    const result = enrichClaudeRequest(request);

    return {
      request: result.request,
      delimiter: result.delimiter,
    };
  }

  /**
   * 解析响应 - 使用 ToolifyParser
   */
  parseResponse(response: string | unknown, delimiter?: ToolCallDelimiter): ToolCall[] {
    // 如果没有分隔符，说明没有工具调用
    if (!delimiter) {
      return [];
    }

    // 如果响应不是字符串，无法解析
    if (typeof response !== "string") {
      return [];
    }

    // 使用 ToolifyParser 解析
    const parser = new ToolifyParser(delimiter, false, "");

    // 逐字符喂入解析器
    for (const char of response) {
      parser.feedChar(char);
    }

    // 完成解析
    parser.finish();

    // 提取工具调用事件
    const events = parser.consumeEvents();
    const toolCalls: ToolCall[] = [];

    for (const event of events) {
      if (event.type === "tool_call") {
        toolCalls.push({
          name: event.call.name,
          arguments: event.call.arguments,
        });
      }
    }

    return toolCalls;
  }

  /**
   * 支持流式处理
   */
  supportsStreaming(): boolean {
    return true;
  }

  /**
   * 获取策略名称
   */
  getName(): string {
    return "prompt_injection";
  }
}

/**
 * 原生工具调用策略（预留接口）
 *
 * 🔮 未来实现：
 * - OpenAI Function Calling
 * - Anthropic Tool Use
 * - 直接使用上游原生工具调用格式
 */
export class NativeToolCallStrategy implements ToolCallStrategy {
  prepareRequest(request: ClaudeRequest): PreparedRequest {
    // 🔮 未来实现：
    // 1. 保持原始 tools 字段
    // 2. 不进行提示词注入
    // 3. 使用上游原生格式
    throw new Error("NativeToolCallStrategy not implemented yet");
  }

  parseResponse(response: string | unknown, delimiter?: ToolCallDelimiter): ToolCall[] {
    // 🔮 未来实现：
    // 1. 解析 OpenAI 的 tool_calls 字段
    // 2. 解析 Anthropic 的 tool_use 块
    // 3. 转换为统一的 ToolCall 格式
    throw new Error("NativeToolCallStrategy not implemented yet");
  }

  supportsStreaming(): boolean {
    // 🔮 未来实现：根据上游协议决定
    return true;
  }

  getName(): string {
    return "native";
  }
}

/**
 * 自动选择策略（预留接口）
 *
 * 🔮 未来实现：
 * - 根据上游能力自动选择策略
 * - 优先使用原生工具调用
 * - 降级到提示词注入
 */
export class AutoStrategy implements ToolCallStrategy {
  private actualStrategy: ToolCallStrategy;

  constructor(protocol: "openai" | "anthropic" | "gemini") {
    // 🔮 未来实现：
    // 1. 检测上游是否支持原生工具调用
    // 2. 如果支持，使用 NativeToolCallStrategy
    // 3. 否则，使用 PromptInjectionStrategy

    // 当前默认使用提示词注入
    this.actualStrategy = new PromptInjectionStrategy();
  }

  prepareRequest(request: ClaudeRequest): PreparedRequest {
    return this.actualStrategy.prepareRequest(request);
  }

  parseResponse(response: string | unknown, delimiter?: ToolCallDelimiter): ToolCall[] {
    return this.actualStrategy.parseResponse(response, delimiter);
  }

  supportsStreaming(): boolean {
    return this.actualStrategy.supportsStreaming();
  }

  getName(): string {
    return `auto(${this.actualStrategy.getName()})`;
  }
}

/**
 * 工具调用策略工厂
 */
export class ToolCallStrategyFactory {
  /**
   * 创建工具调用策略
   *
   * @param mode 工具调用模式
   * @param protocol 上游协议（用于 auto 模式）
   * @returns 工具调用策略实例
   */
  static create(
    mode: "prompt_injection" | "native" | "auto",
    protocol?: "openai" | "anthropic" | "gemini",
  ): ToolCallStrategy {
    switch (mode) {
      case "prompt_injection":
        return new PromptInjectionStrategy();

      case "native":
        // 🔮 未来实现
        throw new Error("Native tool call mode not implemented yet");

      case "auto":
        // 🔮 未来实现
        if (!protocol) {
          throw new Error("Protocol required for auto mode");
        }
        return new AutoStrategy(protocol);

      default:
        throw new Error(`Unknown tool call mode: ${mode}`);
    }
  }
}
