import { log, logPhase, LogPhase } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";
import { ParsedInvokeCall, ClaudeRequest } from "./types.ts";
import { ProxyConfig, resolveAutoTrigger } from "./config.ts";
import { ToolifyParser } from "./parser.ts";
import { RequestContext, ContextBuilder } from "./ai_client/mod.ts";

export class ToolCallRetryHandler {
  constructor(
    private context: RequestContext, // 使用 RequestContext 替代多个参数
  ) {}

  async retry(
    failedContent: string,
    priorText: string,
    delimiter: ToolCallDelimiter,
    attemptCount: number
  ): Promise<{
    success: boolean;
    result?: ParsedInvokeCall;
    error?: string;
    duration?: number;
  }> {
    const requestId = this.context.getRequestId();
    const config = this.context.getConfig();
    const upstreamConfig = this.context.getUpstreamConfig();
    const originalRequest = this.context.getOriginalRequest();

    const startTime = Date.now();

    // 日志：重试开始
    log("warn", "Tool call parse failed, initiating retry", {
      requestId,
      attemptCount,
      maxRetries: config.toolCallRetry?.maxRetries || 1,
      failedContentPreview: failedContent.slice(0, 200),
      priorTextLength: priorText.length,
      strategy: "correction"
    });
    logPhase(requestId, LogPhase.RETRY, `Attempt ${attemptCount}`, {
      priorTextPreview: priorText.slice(0, 100)
    });

    // 构造修正提示
    const correctionPrompt = this.buildCorrectionPrompt(
      failedContent,
      priorText,
      delimiter
    );

    // 使用 ContextBuilder 构建重试上下文
    const retryMessages = ContextBuilder.buildRetryContext(
      originalRequest.messages,
      failedContent,
      priorText,
      correctionPrompt
    );

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        config.toolCallRetry?.timeout || 30000
      );

      log("debug", "Sending retry request to upstream", {
        requestId,
        messageCount: retryMessages.length,
        url: upstreamConfig.baseUrl
      });

      // 构建请求体（根据协议）
      const protocol = upstreamConfig.protocol;
      const requestBody = this.buildRequestBody(retryMessages, protocol as "openai" | "anthropic");

      // 构建请求头
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (protocol === "openai") {
        if (upstreamConfig.apiKey) {
          headers["Authorization"] = `Bearer ${upstreamConfig.apiKey}`;
        }
      } else {
        if (upstreamConfig.apiKey) {
          headers["x-api-key"] = upstreamConfig.apiKey;
        }
        headers["anthropic-version"] = "2023-06-01";
      }

      const response = await fetch(upstreamConfig.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        const errorText = await response.text();
        log("error", "Retry request failed", {
          requestId,
          status: response.status,
          error: errorText.slice(0, 500)
        });
        return { success: false, error: `HTTP ${response.status}`, duration };
      }

      clearTimeout(timeoutId);

      // 🔑 改用流式处理重试响应
      const reader = response.body?.getReader();
      if (!reader) {
        log("error", "No response body reader", { requestId });
        return { success: false, error: "No response body", duration: Date.now() - startTime };
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      let eventType = ""; // 🔑 记录当前事件类型

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (protocol === "openai") {
              // OpenAI SSE 格式
              if (!trimmed.startsWith("data: ")) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === "[DONE]") break;

              try {
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta;
                if (delta?.content) {
                  fullContent += delta.content;
                }
              } catch (e) {
                // 忽略解析错误
              }
            } else {
              // Anthropic SSE 格式 - 🔑 修复：正确处理事件类型
              if (trimmed.startsWith("event: ")) {
                eventType = trimmed.slice(7); // 记录事件类型
              } else if (trimmed.startsWith("data: ")) {
                const jsonStr = trimmed.slice(6);
                try {
                  const data = JSON.parse(jsonStr);
                  // 🔑 根据事件类型解析内容
                  if (eventType === "content_block_delta" && data.delta?.type === "text_delta") {
                    fullContent += data.delta.text || "";
                  }
                } catch (e) {
                  // 忽略解析错误
                }
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const duration = Date.now() - startTime;

      if (!fullContent) {
        log("warn", "Empty retry response", {
          requestId
        });
        return { success: false, error: "Empty response", duration };
      }

      // 解析工具调用
      const toolCall = this.parseToolCallFromContent(fullContent, delimiter);

      if (toolCall) {
        // 🔑 日志：重试成功
        log("info", "Tool call retry succeeded", {
          requestId,
          attemptCount,
          toolName: toolCall.name,
          duration: `${duration}ms`
        });
        logPhase(requestId, LogPhase.RETRY_SUCCESS, toolCall.name, {
          duration: `${(duration / 1000).toFixed(2)}s`
        });
        return { success: true, result: toolCall, duration };
      } else {
        // 🔑 日志：重试响应仍然无效
        log("warn", "Retry response still invalid", {
          requestId,
          attemptCount,
          responsePreview: fullContent.slice(0, 300)
        });
        return { success: false, error: "Invalid retry response", duration };
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // 🔑 日志：重试异常
      log("error", "Retry request exception", {
        requestId,
        attemptCount,
        error: errorMsg,
        duration: `${duration}ms`
      });
      logPhase(requestId, LogPhase.RETRY_FAILED, "Exception", {
        error: errorMsg
      });
      return { success: false, error: errorMsg, duration };
    }
  }

  /**
   * 🔑 构造修正提示（明确指示不要重复输出）
   */
  private buildCorrectionPrompt(
    failedContent: string,
    priorText: string,
    delimiter: ToolCallDelimiter
  ): string {
    const m = delimiter.getMarkers();
    const config = this.context.getConfig();

    // 使用自定义模板
    if (config.toolCallRetry?.promptTemplate) {
      return config.toolCallRetry.promptTemplate
        .replace(/\{failedContent\}/g, failedContent)
        .replace(/\{priorText\}/g, priorText)
        .replace(/\{TC_START\}/g, m.TC_START)
        .replace(/\{TC_END\}/g, m.TC_END)
        .replace(/\{NAME_START\}/g, m.NAME_START)
        .replace(/\{NAME_END\}/g, m.NAME_END)
        .replace(/\{ARGS_START\}/g, m.ARGS_START)
        .replace(/\{ARGS_END\}/g, m.ARGS_END);
    }

    // 默认模板
    return `Your previous tool call output was malformed and could not be parsed.

${priorText ? 
  `⚠️ IMPORTANT: You already outputted this text:
---
${priorText}
---
**The above response is for reference only.**

` : ''}

Please output **ONLY** the corrected tool call using the exact format below:

${m.TC_START}
${m.NAME_START}function_name${m.NAME_END}
${m.ARGS_START}{"param": "value"}${m.ARGS_END}
${m.TC_END}

Critical requirements:
** Include ALL delimiters exactly as shown above **
1. **Arguments must be valid JSON (PERFECT SYNTAX IS MANDATORY)**
2. Include ALL delimiters exactly as shown above.
3. Do NOT include any text before or after the tool call block.
4. Start your response immediately with: ${m.TC_START}
5. Do not repeat any previously outputted text.

Your response should contain ONLY the tool call block, nothing else.`;
  }

  private buildRequestBody(messages: any[]): any {
    // 🔑 解析模型名：使用 resolveAutoTrigger 正确处理 cc+/chat+ 前缀和 channel+model 格式
    const modelName = this.originalRequest.model;
    const { actualModelName } = resolveAutoTrigger(
      modelName,
      this.config.channelConfigs,
      this.config.webTools?.autoTrigger ?? true
    );

    // 🔑 从 actualModelName 中提取真正的模型名（去掉 channel+ 部分）
    const plusIndex = actualModelName.indexOf("+");
    const actualModel = plusIndex !== -1 ? actualModelName.slice(plusIndex + 1) : actualModelName;

    // 使用实际的模型和协议
    if (protocol === "anthropic") {
      // Anthropic 格式
      return {
        model: upstreamConfig.model,
        max_tokens: originalRequest.max_tokens || 4096,
        messages,
        stream: true,
        system: originalRequest.system,
        temperature: originalRequest.temperature,
        top_p: originalRequest.top_p,
        thinking: originalRequest.thinking,
      };
    } else {
      // OpenAI 格式
      return {
        model: upstreamConfig.model,
        messages,
        stream: true,
        max_tokens: originalRequest.max_tokens || 4096,
        temperature: originalRequest.temperature,
        top_p: originalRequest.top_p,
      };
    }
  }


  private parseToolCallFromContent(
    content: string,
    delimiter: ToolCallDelimiter
  ): ParsedInvokeCall | null {
    const requestId = this.context.getRequestId();
    const m = delimiter.getMarkers();
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex = new RegExp(
      `${esc(m.TC_START)}[\\s\\S]*?` +
      `${esc(m.NAME_START)}\\s*([\\s\\S]*?)\\s*${esc(m.NAME_END)}[\\s\\S]*?` +
      `${esc(m.ARGS_START)}\\s*([\\s\\S]*?)\\s*${esc(m.ARGS_END)}[\\s\\S]*?` +
      `${esc(m.TC_END)}`,
      "g"
    );

    const match = regex.exec(content);
    if (match) {
      const name = match[1].trim();
      const argsStr = match[2].trim();
      
      // 🔑 使用统一的 ToolifyParser 修复逻辑来解析重试结果
      const parser = new ToolifyParser(delimiter, false, requestId);
      // 利用 parser 内部的 tryParseJson (它是私有的，但我们可以通过这种方式间接复用逻辑，
      // 或者干脆把 tryParseJson 改为静态方法/导出函数)
      // 为保持最简改动，我们临时将 parser.ts 的 tryParseJson 改为 public
      const args = (parser as any).tryParseJson(argsStr);

      if (args !== null) {
        return { name, arguments: args };
      } else {
        log("warn", "Failed to parse retry tool call JSON even after repair", {
          requestId,
          argsStr: argsStr.slice(0, 200)
        });
        return null;
      }
    }
    return null;
  }
}
