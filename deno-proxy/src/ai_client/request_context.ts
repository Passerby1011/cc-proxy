/**
 * AI 请求上下文类
 *
 * 核心类，封装所有 AI 请求所需的参数，在请求入口处创建，全流程传递。
 * 负责：
 * 1. 解析模型名前缀（cc+/chat+）
 * 2. 解析渠道名（channel+model）
 * 3. 查找渠道配置
 * 4. 应用透传逻辑
 * 5. 构建上游配置
 * 6. 增强请求（工具调用注入）
 */

import { ClaudeRequest } from "../types.ts";
import { ProxyConfig, ChannelConfig, resolveAutoTrigger } from "../config.ts";
import { ToolCallDelimiter } from "../signals.ts";
import { enrichClaudeRequest } from "../prompt_inject.ts";
import type {
  UpstreamConfig,
  RequestContextData,
  Protocol,
  ToolCallMode,
  RequestFormat,
} from "./types.ts";

export class RequestContext {
  private data: RequestContextData;

  private constructor(data: RequestContextData) {
    this.data = data;
  }

  /**
   * 静态工厂方法：从原始请求创建 RequestContext
   *
   * @param originalRequest 原始 Claude 请求
   * @param config 代理配置
   * @param requestId 请求 ID
   * @param clientApiKey 客户端 API 密钥（用于透传）
   * @returns RequestContext 实例
   */
  static fromRequest(
    originalRequest: ClaudeRequest,
    config: ProxyConfig,
    requestId: string,
    clientApiKey?: string,
  ): RequestContext {
    // 1. 解析模型名前缀和 autoTrigger 配置
    const { autoTrigger, actualModelName, channelName } = resolveAutoTrigger(
      originalRequest.model,
      config.channelConfigs,
      config.webTools?.autoTrigger ?? true,
    );

    // 2. 解析渠道信息
    const upstreamConfig = RequestContext.parseChannelInfo(
      actualModelName,
      config,
      clientApiKey,
    );

    // 3. 确定工具调用模式
    const toolCallMode: ToolCallMode = upstreamConfig.supportsNativeToolCalling
      ? "native"
      : "prompt_injection";

    // 4. 增强请求（仅在 prompt_injection 模式下才注入工具 XML）
    let enrichedRequest: ClaudeRequest;
    let delimiter: ToolCallDelimiter | undefined;

    if (toolCallMode === "prompt_injection") {
      const enrichResult = enrichClaudeRequest(originalRequest);
      enrichedRequest = enrichResult.request;
      delimiter = enrichResult.delimiter;
    } else {
      // 原生工具调用模式，不需要注入 XML，直接使用原始请求
      enrichedRequest = originalRequest;
      delimiter = undefined;
    }

    // 5. 确定请求格式（当前仅支持 anthropic 格式）
    const requestFormat: RequestFormat = "anthropic";

    // 6. 构建上下文数据
    const contextData: RequestContextData = {
      upstreamConfig,
      originalRequest,
      enrichedRequest,
      delimiter,
      config,
      requestId,
      requestFormat,
      toolCallMode,
      clientApiKey,
    };

    return new RequestContext(contextData);
  }

  /**
   * 静态工厂方法：从 UpstreamInfo 创建 RequestContext（用于工具拦截器中的辅助 AI 请求）
   *
   * @param upstreamInfo 上游配置信息
   * @param requestId 请求 ID
   * @returns RequestContext 实例
   */
  static fromUpstreamInfo(
    upstreamInfo: { baseUrl: string; apiKey?: string; model: string; protocol: Protocol },
    requestId: string,
  ): RequestContext {
    // 创建一个最小化的 RequestContext 用于工具拦截器中的辅助 AI 请求
    const upstreamConfig: UpstreamConfig = {
      baseUrl: upstreamInfo.baseUrl,
      apiKey: upstreamInfo.apiKey,
      model: upstreamInfo.model,
      protocol: upstreamInfo.protocol,
    };

    // 创建最小化的请求对象
    const minimalRequest: ClaudeRequest = {
      model: upstreamInfo.model,
      max_tokens: 4096,
      messages: [],
    };

    // 创建最小化的配置对象（确保 defaultProtocol 类型正确）
    const protocol = upstreamInfo.protocol === "gemini" ? "openai" : upstreamInfo.protocol;
    const minimalConfig: ProxyConfig = {
      upstreamBaseUrl: upstreamInfo.baseUrl,
      upstreamApiKey: upstreamInfo.apiKey,
      upstreamModelOverride: upstreamInfo.model,
      channelConfigs: [],
      defaultProtocol: protocol as "openai" | "anthropic",
      port: 0, // 占位值
      host: "0.0.0.0",
      requestTimeoutMs: 120000,
      aggregationIntervalMs: 35,
      maxRequestsPerMinute: 10,
      tokenMultiplier: 1.0,
      autoPort: false,
      passthroughApiKey: false,
    };

    const contextData: RequestContextData = {
      upstreamConfig,
      originalRequest: minimalRequest,
      enrichedRequest: minimalRequest,
      config: minimalConfig,
      requestId,
      requestFormat: "anthropic",
      toolCallMode: "prompt_injection",
    };

    return new RequestContext(contextData);
  }

  /**
   * 解析渠道信息
   *
   * 处理 channel+model 格式，查找渠道配置，应用透传逻辑
   *
   * @param modelName 模型名（已移除 cc+/chat+ 前缀）
   * @param config 代理配置
   * @param clientApiKey 客户端 API 密钥
   * @returns 上游配置
   */
  private static parseChannelInfo(
    modelName: string,
    config: ProxyConfig,
    clientApiKey?: string,
  ): UpstreamConfig {
    let baseUrl: string;
    let apiKey: string | undefined;
    let model: string;
    let protocol: Protocol;
    let supportsNativeToolCalling: boolean = false; // 默认不支持原生工具调用
    let supportsSystemPrompt: boolean = true; // 默认支持系统提示词

    const plusIndex = modelName.indexOf("+");

    if (plusIndex !== -1) {
      // 格式：channel+model
      const channelName = modelName.slice(0, plusIndex);
      const actualModel = modelName.slice(plusIndex + 1);
      const channel = config.channelConfigs.find((c) => c.name === channelName);

      if (channel) {
        baseUrl = channel.baseUrl;
        apiKey = channel.apiKey;
        model = actualModel;
        protocol = (channel.protocol ?? config.defaultProtocol) as Protocol;
        supportsNativeToolCalling = channel.supportsNativeToolCalling ?? false;
        supportsSystemPrompt = channel.supportsSystemPrompt ?? true;
      } else {
        // 渠道未找到，使用默认配置
        baseUrl = config.upstreamBaseUrl!;
        apiKey = config.upstreamApiKey;
        model = modelName;
        protocol = config.defaultProtocol as Protocol;
        supportsNativeToolCalling = false;
      }
    } else {
      // 没有 + 号，使用默认渠道或全局配置
      if (config.channelConfigs.length > 0) {
        const channel = config.channelConfigs[0];
        baseUrl = channel.baseUrl;
        apiKey = channel.apiKey;
        model = modelName;
        protocol = (channel.protocol ?? config.defaultProtocol) as Protocol;
        supportsNativeToolCalling = channel.supportsNativeToolCalling ?? false;
        supportsSystemPrompt = channel.supportsSystemPrompt ?? true;
      } else {
        baseUrl = config.upstreamBaseUrl!;
        apiKey = config.upstreamApiKey;
        model = config.upstreamModelOverride ?? modelName;
        protocol = config.defaultProtocol as Protocol;
        supportsNativeToolCalling = false;
      }
    }

    // 应用透传逻辑：如果启用透传且客户端提供了 API key，则优先使用客户端的 key
    if (config.passthroughApiKey && clientApiKey) {
      apiKey = clientApiKey;
    }

    return {
      baseUrl,
      apiKey,
      model,
      protocol,
      supportsNativeToolCalling,
      supportsSystemPrompt,
    };
  }

  // ==================== 访问器方法 ====================

  /**
   * 获取上游配置
   */
  getUpstreamConfig(): UpstreamConfig {
    return this.data.upstreamConfig;
  }

  /**
   * 获取原始请求
   */
  getOriginalRequest(): ClaudeRequest {
    return this.data.originalRequest;
  }

  /**
   * 获取增强后的请求
   */
  getEnrichedRequest(): ClaudeRequest {
    return this.data.enrichedRequest;
  }

  /**
   * 获取工具调用分隔符
   */
  getDelimiter(): ToolCallDelimiter | undefined {
    return this.data.delimiter;
  }

  /**
   * 获取代理配置
   */
  getConfig(): ProxyConfig {
    return this.data.config;
  }

  /**
   * 获取请求 ID
   */
  getRequestId(): string {
    return this.data.requestId;
  }

  /**
   * 获取请求格式
   */
  getRequestFormat(): RequestFormat {
    return this.data.requestFormat;
  }

  /**
   * 获取工具调用模式
   */
  getToolCallMode(): ToolCallMode {
    return this.data.toolCallMode;
  }

  /**
   * 获取客户端 API 密钥
   */
  getClientApiKey(): string | undefined {
    return this.data.clientApiKey;
  }

  /**
   * 获取消息列表（使用增强后的请求）
   */
  getMessages() {
    return this.data.enrichedRequest.messages;
  }

  /**
   * 获取模型名（上游模型名）
   */
  getModel(): string {
    return this.data.upstreamConfig.model;
  }

  /**
   * 是否启用流式输出
   */
  isStreamEnabled(): boolean {
    return this.data.originalRequest.stream === true;
  }

  /**
   * 判断上游是否支持原生工具调用
   *
   * 📌 从渠道配置中读取 supportsNativeToolCalling 字段
   * 🔮 未来扩展：根据 protocol 和上游能力判断
   */
  supportsNativeToolCall(): boolean {
    return this.data.upstreamConfig.supportsNativeToolCalling ?? false;
  }

  /**
   * 获取完整的上下文数据（用于调试）
   */
  getContextData(): RequestContextData {
    return { ...this.data };
  }
}
