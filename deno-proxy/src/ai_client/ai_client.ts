/**
 * AI 请求客户端
 *
 * 提供统一的 AI 请求接口，整合所有模块：
 * - RequestContext：请求上下文
 * - ProtocolAdapter：协议适配
 * - ToolCallStrategy：工具调用策略
 * - AIClientLogger：日志记录
 * - ContextBuilder：上下文构建
 *
 * 消除所有 AI 请求相关的重复代码
 */

import { ClaudeMessage } from "../types.ts";
import { RequestContext } from "./request_context.ts";
import { ProtocolAdapterFactory } from "./protocol_adapter.ts";
import { ToolCallStrategyFactory } from "./tool_call_strategy.ts";
import { createLogger, AIClientLogger } from "./logger.ts";
import type { AIRequestOptions, AIResponse, StreamChunk, StreamCallback } from "./types.ts";

/**
 * AI 客户端类
 */
export class AIClient {
  private context: RequestContext;
  private logger: AIClientLogger;
  private protocolAdapter;
  private toolCallStrategy;

  constructor(context: RequestContext) {
    this.context = context;
    this.logger = createLogger(context.getRequestId());

    // 创建协议适配器
    const protocol = context.getUpstreamConfig().protocol;
    this.protocolAdapter = ProtocolAdapterFactory.create(protocol);

    // 创建工具调用策略
    const toolCallMode = context.getToolCallMode();
    this.toolCallStrategy = ToolCallStrategyFactory.create(toolCallMode);
  }

  /**
   * 发送非流式请求
   *
   * @param messages 消息列表
   * @param options 请求选项
   * @returns AI 响应
   */
  async request(messages: ClaudeMessage[], options: AIRequestOptions): Promise<AIResponse> {
    const startTime = Date.now();

    try {
      this.logger.logPhase("forwarding", "Sending non-streaming request", {
        protocol: this.protocolAdapter.getName(),
        messageCount: messages.length,
      });

      // 1. 构建请求
      const { url, headers, body } = this._buildRequest(messages, options);

      // 2. 发送请求
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(
          this.context.getConfig().requestTimeoutMs || 120000,
        ),
      });

      // 记录 TTFB
      this.logger.markTTFB();

      // 3. 处理响应
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const json = await response.json();
      const aiResponse = this.protocolAdapter.parseResponse(json);

      // 4. 记录响应
      this.logger.logResponse("Request completed", {
        finishReason: aiResponse.finish_reason,
        inputTokens: aiResponse.usage?.input_tokens,
        outputTokens: aiResponse.usage?.output_tokens,
      });

      // 5. 记录指标
      this.logger.logMetrics({
        ttfb: this.logger.getTTFB(),
        totalTime: Date.now() - startTime,
        inputTokens: aiResponse.usage?.input_tokens,
        outputTokens: aiResponse.usage?.output_tokens,
      });

      return aiResponse;
    } catch (error) {
      this.logger.logError("Request failed", error, {
        elapsed: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * 发送流式请求
   *
   * @param messages 消息列表
   * @param options 请求选项
   * @param onChunk 流式回调
   */
  async streamRequest(
    messages: ClaudeMessage[],
    options: AIRequestOptions,
    onChunk: StreamCallback,
  ): Promise<void> {
    const startTime = Date.now();
    let totalChunks = 0;
    let totalOutputLength = 0;

    try {
      this.logger.logPhase("streaming", "Starting streaming request", {
        protocol: this.protocolAdapter.getName(),
        messageCount: messages.length,
      });

      // 1. 构建请求（启用流式）
      const streamOptions = { ...options, stream: true };
      const { url, headers, body } = this._buildRequest(messages, streamOptions);

      // 2. 发送请求
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(
          this.context.getConfig().requestTimeoutMs || 120000,
        ),
      });

      // 记录 TTFB
      this.logger.markTTFB();

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      // 3. 处理流式响应
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Response body is not readable");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      // For Anthropic SSE: temporarily store event type
      let pendingEventType: string | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Split lines, handle LF and CRLF
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || ""; // Keep last line (may be incomplete)

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Anthropic format: event: xxx\ndata: yyy
            // Detect event: line
            if (trimmed.startsWith("event: ")) {
              pendingEventType = trimmed.slice(7).trim();
              continue;
            }

            // Detect data: line
            if (trimmed.startsWith("data: ")) {
              const dataStr = trimmed.slice(6);

              // Stream end marker
              if (dataStr === "[DONE]") {
                const chunk = this.protocolAdapter.parseStreamChunk("data: [DONE]");
                if (chunk) {
                  await onChunk(chunk);
                }
                return;
              }

              // If there's a pending event type, inject it into the data line
              let parseLine = trimmed;
              if (pendingEventType) {
                // Inject event type into JSON
                try {
                  const data = JSON.parse(dataStr);
                  data.type = pendingEventType;
                  parseLine = "data: " + JSON.stringify(data);
                } catch {
                  // JSON parse failed, use original line
                }
                pendingEventType = null;
              }

              const chunk = this.protocolAdapter.parseStreamChunk(parseLine);

              if (chunk) {
                totalChunks++;

                if (chunk.text) {
                  totalOutputLength += chunk.text.length;
                }

                await onChunk(chunk);

                // Stream end
                if (chunk.type === "done") {
                  return;
                }
              }
              continue;
            }

            // Non-data line, try to parse directly
            const chunk = this.protocolAdapter.parseStreamChunk(trimmed);
            if (chunk) {
              totalChunks++;

              if (chunk.text) {
                totalOutputLength += chunk.text.length;
              }

              await onChunk(chunk);

              if (chunk.type === "done") {
                return;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // 4. 记录完成
      this.logger.logResponse("Streaming completed", {
        chunks: totalChunks,
        outputLength: totalOutputLength,
      });

      // 5. 记录指标
      this.logger.logMetrics({
        ttfb: this.logger.getTTFB(),
        totalTime: Date.now() - startTime,
      });
    } catch (error) {
      this.logger.logError("Streaming failed", error, {
        elapsed: Date.now() - startTime,
        chunks: totalChunks,
      });
      throw error;
    }
  }

  /**
   * 构建请求
   *
   * @param messages 消息列表
   * @param options 请求选项
   * @returns 请求 URL、请求头、请求体
   */
  private _buildRequest(
    messages: ClaudeMessage[],
    options: AIRequestOptions,
  ): { url: string; headers: Record<string, string>; body: string } {
    const upstreamConfig = this.context.getUpstreamConfig();

    // 1. 构建请求头
    const headers = this.protocolAdapter.buildHeaders(upstreamConfig.apiKey);

    // 2. 构建请求体
    const requestOptions: AIRequestOptions = {
      ...options,
      metadata: {
        model: upstreamConfig.model,
        system: this.context.getEnrichedRequest().system,
        ...options.metadata,
      },
    };

    const body = this.protocolAdapter.buildRequestBody(messages, requestOptions);

    // 3. 构建 URL
    const url = upstreamConfig.baseUrl;

    return { url, headers, body };
  }

  /**
   * 获取 Logger 实例（用于外部记录日志）
   */
  getLogger(): AIClientLogger {
    return this.logger;
  }

  /**
   * 获取 RequestContext 实例
   */
  getContext(): RequestContext {
    return this.context;
  }
}
