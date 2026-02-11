/**
 * AI Client 统一日志记录器
 *
 * 提供统一的日志记录接口，集成现有的 logging.ts 功能，
 * 增强 AI 请求追踪、性能指标记录等能力。
 */

import { log as systemLog, logRequest as systemLogRequest, LogPhase } from "../logging.ts";
import type { LogLevel, LogMetadata, PerformanceMetrics } from "./types.ts";

/**
 * AI Client Logger 类
 * 封装日志记录逻辑，提供结构化的日志接口
 */
export class AIClientLogger {
  private requestId: string;
  private startTime: number;
  private ttfb?: number;

  constructor(requestId: string) {
    this.requestId = requestId;
    this.startTime = Date.now();
  }

  /**
   * 记录请求开始
   */
  logRequest(message: string, metadata?: LogMetadata): void {
    systemLogRequest(
      this.requestId,
      "info",
      message,
      this.sanitizeMetadata(metadata),
      LogPhase.REQUEST
    );
  }

  /**
   * 记录响应完成
   */
  logResponse(message: string, metadata?: LogMetadata): void {
    systemLogRequest(
      this.requestId,
      "info",
      message,
      this.sanitizeMetadata(metadata),
      LogPhase.COMPLETE
    );
  }

  /**
   * 记录错误
   */
  logError(message: string, error?: Error | unknown, metadata?: LogMetadata): void {
    const errorMeta: Record<string, unknown> = {
      ...this.sanitizeMetadata(metadata),
    };

    if (error instanceof Error) {
      errorMeta.error = error.message;
      errorMeta.stack = error.stack;
    } else if (error) {
      errorMeta.error = String(error);
    }

    systemLogRequest(
      this.requestId,
      "error",
      message,
      errorMeta,
      LogPhase.ERROR
    );
  }

  /**
   * 记录请求阶段
   */
  logPhase(
    phase: "parsing" | "forwarding" | "streaming" | "tool_call" | "retry" | "analysis",
    message: string,
    metadata?: LogMetadata
  ): void {
    const phaseMap = {
      parsing: LogPhase.ENRICHED,
      forwarding: LogPhase.UPSTREAM,
      streaming: LogPhase.STREAM,
      tool_call: LogPhase.TOOL,
      retry: LogPhase.RETRY,
      analysis: LogPhase.THINKING,
    };

    systemLogRequest(
      this.requestId,
      "info",
      message,
      this.sanitizeMetadata(metadata),
      phaseMap[phase]
    );
  }

  /**
   * 记录性能指标
   */
  logMetrics(metrics: PerformanceMetrics): void {
    const totalTime = Date.now() - this.startTime;

    const metricsData: Record<string, unknown> = {
      totalTime: `${totalTime}ms`,
      ttfb: this.ttfb ? `${this.ttfb}ms` : undefined,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      retryCount: metrics.retryCount,
    };

    systemLogRequest(
      this.requestId,
      "info",
      "Request metrics",
      metricsData,
      LogPhase.STATS
    );
  }

  /**
   * 记录调试信息
   */
  debug(message: string, metadata?: LogMetadata): void {
    systemLogRequest(
      this.requestId,
      "debug",
      message,
      this.sanitizeMetadata(metadata)
    );
  }

  /**
   * 记录警告信息
   */
  warn(message: string, metadata?: LogMetadata): void {
    systemLogRequest(
      this.requestId,
      "warn",
      message,
      this.sanitizeMetadata(metadata)
    );
  }

  /**
   * 记录首字节时间（TTFB）
   */
  markTTFB(): void {
    if (!this.ttfb) {
      this.ttfb = Date.now() - this.startTime;
    }
  }

  /**
   * 获取请求耗时
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * 获取 TTFB
   */
  getTTFB(): number | undefined {
    return this.ttfb;
  }

  /**
   * 清理元数据，确保不包含敏感信息
   */
  private sanitizeMetadata(metadata?: LogMetadata): Record<string, unknown> {
    if (!metadata) return {};

    const sanitized: Record<string, unknown> = {};
    const sensitiveKeys = ["apikey", "api_key", "authorization", "token", "password", "secret"];

    for (const [key, value] of Object.entries(metadata)) {
      // 跳过 requestId（已由 logRequest 处理）
      if (key === "requestId") continue;

      // 检查敏感字段
      const keyLower = key.toLowerCase();
      if (sensitiveKeys.some(sk => keyLower.includes(sk))) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      // 处理对象类型（深度为1，避免循环引用）
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const objValue = value as Record<string, unknown>;
        const sanitizedObj: Record<string, unknown> = {};

        for (const [objKey, objVal] of Object.entries(objValue)) {
          const objKeyLower = objKey.toLowerCase();
          if (sensitiveKeys.some(sk => objKeyLower.includes(sk))) {
            sanitizedObj[objKey] = "[REDACTED]";
          } else {
            sanitizedObj[objKey] = objVal;
          }
        }

        sanitized[key] = sanitizedObj;
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

/**
 * 创建 AI Client Logger 实例的工厂函数
 */
export function createLogger(requestId: string): AIClientLogger {
  return new AIClientLogger(requestId);
}

/**
 * 系统级日志（非请求相关）
 */
export function logSystem(
  level: LogLevel,
  message: string,
  metadata?: LogMetadata
): void {
  systemLog(level, message, metadata);
}
