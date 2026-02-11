/**
 * AI 请求客户端类型定义
 *
 * 本文件定义了 AI 请求相关的所有核心类型，包括：
 * - 上游配置
 * - 请求选项
 * - 响应格式
 * - 协议类型
 * - 工具调用模式
 * - 请求格式
 */

import { ClaudeMessage, ClaudeRequest } from "../types.ts";
import { ProxyConfig } from "../config.ts";
import { ToolCallDelimiter } from "../signals.ts";

/**
 * 协议类型枚举
 *
 * 📌 当前实现：openai, anthropic
 * 🔮 未来扩展：gemini（预留）
 */
export type Protocol = "openai" | "anthropic" | "gemini";

/**
 * 工具调用模式枚举
 *
 * 📌 当前实现：prompt_injection（提示词注入）
 * 🔮 未来扩展：native（原生工具调用）、auto（自动选择）
 */
export type ToolCallMode = "prompt_injection" | "native" | "auto";

/**
 * 请求格式枚举
 *
 * 📌 当前实现：anthropic（Claude 格式）
 * 🔮 未来扩展：openai（OpenAI 格式，支持自动转换）
 */
export type RequestFormat = "anthropic" | "openai";

/**
 * 上游配置
 * 封装解析后的渠道信息
 */
export interface UpstreamConfig {
  /** 上游 API 基础 URL */
  baseUrl: string;

  /** 上游 API 密钥 */
  apiKey?: string;

  /** 上游模型名称 */
  model: string;

  /** 上游协议类型 */
  protocol: Protocol;
}

/**
 * AI 请求选项
 * 统一管理请求参数
 */
export interface AIRequestOptions {
  /** 是否启用流式输出 */
  stream?: boolean;

  /** 最大生成 token 数 */
  max_tokens?: number;

  /** 温度参数（0-1） */
  temperature?: number;

  /** Top-P 采样参数（0-1） */
  top_p?: number;

  /** 元数据 */
  metadata?: Record<string, unknown>;

  /** 工具定义 */
  tools?: unknown[];

  /** 工具选择策略 */
  tool_choice?: unknown;

  /** 思考配置 */
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
}

/**
 * AI 响应格式
 * 统一的响应结构
 */
export interface AIResponse {
  /** 响应内容 */
  content: string | ClaudeMessage["content"];

  /** Token 使用情况 */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };

  /** 完成原因 */
  finish_reason?: string;

  /** 原始响应（用于调试） */
  raw?: unknown;
}

/**
 * 流式响应块
 */
export interface StreamChunk {
  /** 文本内容 */
  text?: string;

  /** 事件类型 */
  type?: string;

  /** 原始数据 */
  data?: unknown;
}

/**
 * 流式回调函数
 * 用于处理流式响应
 */
export type StreamCallback = (chunk: StreamChunk) => Promise<void>;

/**
 * 请求上下文数据
 * 用于传递给 RequestContext 类
 */
export interface RequestContextData {
  /** 上游配置 */
  upstreamConfig: UpstreamConfig;

  /** 原始请求 */
  originalRequest: ClaudeRequest;

  /** 增强后的请求 */
  enrichedRequest: ClaudeRequest;

  /** 工具调用分隔符 */
  delimiter?: ToolCallDelimiter;

  /** 全局配置 */
  config: ProxyConfig;

  /** 请求 ID */
  requestId: string;

  /** 请求格式 */
  requestFormat: RequestFormat;

  /** 工具调用模式 */
  toolCallMode: ToolCallMode;

  /** 客户端 API 密钥（用于透传） */
  clientApiKey?: string;
}

/**
 * 日志级别
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 日志元数据
 */
export interface LogMetadata {
  /** 请求 ID */
  requestId?: string;

  /** 请求阶段 */
  phase?: string;

  /** 其他元数据 */
  [key: string]: unknown;
}

/**
 * 性能指标
 */
export interface PerformanceMetrics {
  /** 首字节时间（TTFB） */
  ttfb?: number;

  /** 总耗时 */
  totalTime?: number;

  /** 输入 token 数 */
  inputTokens?: number;

  /** 输出 token 数 */
  outputTokens?: number;

  /** 重试次数 */
  retryCount?: number;
}
