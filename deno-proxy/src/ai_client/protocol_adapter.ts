/**
 * 协议适配器
 *
 * 统一处理不同协议的差异，采用策略模式：
 * - 📌 当前实现：OpenAI、Anthropic
 * - 🔮 未来扩展：Gemini（预留）
 *
 * 消除7处协议适配重复逻辑
 */

import { ClaudeMessage, OpenAIChatMessage } from "../types.ts";
import type { Protocol, AIRequestOptions, AIResponse, StreamChunk } from "./types.ts";

/**
 * 协议适配器接口
 */
export interface ProtocolAdapter {
  /**
   * 构建请求体
   *
   * @param messages 消息列表
   * @param options 请求选项
   * @returns JSON 字符串
   */
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string;

  /**
   * 构建请求头
   *
   * @param apiKey API 密钥
   * @returns 请求头对象
   */
  buildHeaders(apiKey?: string): Record<string, string>;

  /**
   * 解析非流式响应
   *
   * @param json 响应 JSON 对象
   * @returns 统一的 AI 响应格式
   */
  parseResponse(json: unknown): AIResponse;

  /**
   * 解析流式响应块
   *
   * @param line SSE 数据行
   * @returns 流式响应块（如果无法解析则返回 null）
   */
  parseStreamChunk(line: string): StreamChunk | null;

  /**
   * 获取协议名称
   */
  getName(): Protocol;
}

/**
 * OpenAI 协议适配器
 *
 * 📌 当前实现：OpenAI Chat Completions API
 */
export class OpenAIAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    // 转换消息格式：Claude -> OpenAI
    const openaiMessages: OpenAIChatMessage[] = messages.map((msg) => ({
      role: msg.role as "user" | "assistant" | "system",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    }));

    // 🔑 处理 system prompt：如果 metadata 中包含 system，则将其作为消息插入到头部
    // 根据 supportsSystemPrompt 标志决定使用 system 角色还是 user 角色
    if (options.metadata?.system) {
      const supportsSystemPrompt = options.metadata?.supportsSystemPrompt !== false;
      openaiMessages.unshift({
        role: supportsSystemPrompt ? "system" : "user",
        content: options.metadata.system as string,
      });
    }

    const requestBody: any = {
      model: options.metadata?.model || "gpt-4",
      messages: openaiMessages,
      stream: options.stream ?? false,
      max_tokens: options.max_tokens,
      temperature: options.temperature,
      top_p: options.top_p,
    };

    // 添加工具定义
    if (options.tools && (options.tools as unknown[]).length > 0) {
      requestBody.tools = options.tools;
    }
    if (options.tool_choice !== undefined) {
      requestBody.tool_choice = options.tool_choice;
    }

    return JSON.stringify(requestBody);
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    return headers;
  }

  parseResponse(json: unknown): AIResponse {
    const data = json as any;

    // OpenAI 响应格式
    const message = data.choices?.[0]?.message;
    const content = message?.content || "";

    return {
      content,
      usage: data.usage
        ? {
            input_tokens: data.usage.prompt_tokens || 0,
            output_tokens: data.usage.completion_tokens || 0,
          }
        : undefined,
      finish_reason: data.choices?.[0]?.finish_reason,
      raw: data,
    };
  }

  parseStreamChunk(line: string): StreamChunk | null {
    const trimmed = line.trim();

    // OpenAI SSE 格式：data: {json}
    if (!trimmed.startsWith("data: ")) {
      return null;
    }

    const dataStr = trimmed.slice(6);

    // 流结束标记
    if (dataStr === "[DONE]") {
      return { type: "done", data: null };
    }

    try {
      const data = JSON.parse(dataStr);
      const delta = data.choices?.[0]?.delta;
      const text = delta?.content || "";

      return {
        text,
        type: "content",
        data,
      };
    } catch {
      return null;
    }
  }

  getName(): Protocol {
    return "openai";
  }
}

/**
 * Anthropic 协议适配器
 *
 * 📌 当前实现：Anthropic Messages API
 */
export class AnthropicAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    const requestBody: any = {
      model: options.metadata?.model || "claude-3-5-sonnet-20241022",
      messages: messages,
      stream: options.stream ?? false,
      max_tokens: options.max_tokens || 4096,
    };

    // 只添加有值的可选字段
    if (options.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options.top_p !== undefined) {
      requestBody.top_p = options.top_p;
    }
    if (options.metadata?.system) {
      requestBody.system = options.metadata.system;
    }

    // 添加工具定义
    if (options.tools && (options.tools as unknown[]).length > 0) {
      requestBody.tools = options.tools;
    }
    if (options.tool_choice !== undefined) {
      requestBody.tool_choice = options.tool_choice;
    }

    // 移除 undefined 字段（双重保险）
    Object.keys(requestBody).forEach((key) => {
      if (requestBody[key as keyof typeof requestBody] === undefined) {
        delete requestBody[key as keyof typeof requestBody];
      }
    });

    return JSON.stringify(requestBody);
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    return headers;
  }

  parseResponse(json: unknown): AIResponse {
    const data = json as any;

    // Anthropic 响应格式
    const content = data.content;
    let textContent = "";

    if (Array.isArray(content)) {
      const textBlocks = content.filter((block: any) => block.type === "text");
      textContent = textBlocks.map((block: any) => block.text).join("\n");
    }

    return {
      content: textContent || content,
      usage: data.usage
        ? {
            input_tokens: data.usage.input_tokens || 0,
            output_tokens: data.usage.output_tokens || 0,
          }
        : undefined,
      finish_reason: data.stop_reason,
      raw: data,
    };
  }

  parseStreamChunk(line: string): StreamChunk | null {
    const trimmed = line.trim();

    // Anthropic SSE 格式：event: {type}\ndata: {json}
    if (trimmed.startsWith("event: ")) {
      // 事件类型行，跳过（由下一行的 data 处理）
      return { type: trimmed.slice(7), data: null };
    }

    if (!trimmed.startsWith("data: ")) {
      return null;
    }

    const dataStr = trimmed.slice(6);

    try {
      const data = JSON.parse(dataStr);

      // 处理 content_block_delta 事件
      if (data.type === "content_block_delta") {
        const delta = data.delta;
        if (delta?.type === "text_delta") {
          return {
            text: delta.text || "",
            type: "content",
            data,
          };
        }
      }

      // 处理 message_stop 事件
      if (data.type === "message_stop") {
        return { type: "done", data };
      }

      return { type: data.type, data };
    } catch {
      return null;
    }
  }

  getName(): Protocol {
    return "anthropic";
  }
}

/**
 * Gemini 协议适配器（预留）
 *
 * 🔮 未来实现：Google Gemini API
 */
export class GeminiAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    // 🔮 未来实现：
    // 1. 转换消息格式为 Gemini 格式
    // 2. 处理 Gemini 特有的参数
    throw new Error("GeminiAdapter not implemented yet");
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    // 🔮 未来实现：
    // 1. Gemini API 密钥格式（可能是 URL 参数）
    // 2. Gemini 特有的请求头
    throw new Error("GeminiAdapter not implemented yet");
  }

  parseResponse(json: unknown): AIResponse {
    // 🔮 未来实现：
    // 1. 解析 Gemini 响应格式
    // 2. 转换为统一的 AIResponse
    throw new Error("GeminiAdapter not implemented yet");
  }

  parseStreamChunk(line: string): StreamChunk | null {
    // 🔮 未来实现：
    // 1. 解析 Gemini SSE 格式
    // 2. 提取文本内容
    throw new Error("GeminiAdapter not implemented yet");
  }

  getName(): Protocol {
    return "gemini";
  }
}

/**
 * 协议适配器工厂
 */
export class ProtocolAdapterFactory {
  private static adapters: Map<Protocol, ProtocolAdapter> = new Map([
    ["openai", new OpenAIAdapter()],
    ["anthropic", new AnthropicAdapter()],
    // Gemini 适配器暂不注册，等待实现
    // ["gemini", new GeminiAdapter()],
  ]);

  /**
   * 创建协议适配器
   *
   * @param protocol 协议类型
   * @returns 协议适配器实例
   */
  static create(protocol: Protocol): ProtocolAdapter {
    const adapter = this.adapters.get(protocol);

    if (!adapter) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    return adapter;
  }

  /**
   * 注册新的协议适配器
   *
   * @param protocol 协议类型
   * @param adapter 适配器实例
   */
  static register(protocol: Protocol, adapter: ProtocolAdapter): void {
    this.adapters.set(protocol, adapter);
  }

  /**
   * 获取所有支持的协议
   */
  static getSupportedProtocols(): Protocol[] {
    return Array.from(this.adapters.keys());
  }
}
