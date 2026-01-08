import { log, logPhase, LogPhase } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";
import { ParsedInvokeCall } from "./types.ts";
import { ProxyConfig } from "./config.ts";

export class ToolCallRetryHandler {
  constructor(
    private config: ProxyConfig,
    private requestId: string,
    private originalMessages: any[],
    private upstreamUrl: string,
    private upstreamHeaders: Record<string, string>,
    private protocol: "openai" | "anthropic",
    private model: string,  // 🔑 新增：使用原始请求的模型
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
    const startTime = Date.now();
    
    // 🔑 日志：重试开始
    log("warn", "Tool call parse failed, initiating retry", {
      requestId: this.requestId,
      attemptCount,
      maxRetries: this.config.toolCallRetry?.maxRetries || 1,
      failedContentPreview: failedContent.slice(0, 200),
      priorTextLength: priorText.length,
      strategy: "correction"
    });
    logPhase(this.requestId, LogPhase.RETRY, `Attempt ${attemptCount}`, {
      priorTextPreview: priorText.slice(0, 100)
    });

    // 构造修正提示
    const correctionPrompt = this.buildCorrectionPrompt(
      failedContent,
      priorText,
      delimiter
    );

    // 🔑 构造重试请求（包含之前的完整输出）
    const retryMessages = [
      ...this.originalMessages,
      {
        role: "assistant",
        content: priorText + failedContent  // 完整的失败输出
      },
      {
        role: "user",
        content: correctionPrompt
      }
    ];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.toolCallRetry?.timeout || 30000
      );

      log("debug", "Sending retry request to upstream", {
        requestId: this.requestId,
        messageCount: retryMessages.length,
        url: this.upstreamUrl
      });

      const requestBody = this.buildRequestBody(retryMessages);

      const response = await fetch(this.upstreamUrl, {
        method: "POST",
        headers: this.upstreamHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        const errorText = await response.text();
        log("error", "Retry request failed", {
          requestId: this.requestId,
          status: response.status,
          error: errorText.slice(0, 500)
        });
        return { success: false, error: `HTTP ${response.status}`, duration };
      }

      clearTimeout(timeoutId);

      // 🔑 改用流式处理重试响应
      const reader = response.body?.getReader();
      if (!reader) {
        log("error", "No response body reader", { requestId: this.requestId });
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

            if (this.protocol === "openai") {
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
          requestId: this.requestId
        });
        return { success: false, error: "Empty response", duration };
      }

      // 解析工具调用
      const toolCall = this.parseToolCallFromContent(fullContent, delimiter);

      if (toolCall) {
        // 🔑 日志：重试成功
        log("info", "Tool call retry succeeded", {
          requestId: this.requestId,
          attemptCount,
          toolName: toolCall.name,
          duration: `${duration}ms`
        });
        logPhase(this.requestId, LogPhase.RETRY_SUCCESS, toolCall.name, {
          duration: `${(duration / 1000).toFixed(2)}s`
        });
        return { success: true, result: toolCall, duration };
      } else {
        // 🔑 日志：重试响应仍然无效
        log("warn", "Retry response still invalid", {
          requestId: this.requestId,
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
        requestId: this.requestId,
        attemptCount,
        error: errorMsg,
        duration: `${duration}ms`
      });
      logPhase(this.requestId, LogPhase.RETRY_FAILED, "Exception", {
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
    
    // 使用自定义模板
    if (this.config.toolCallRetry?.promptTemplate) {
      return this.config.toolCallRetry.promptTemplate
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

${priorText ? `⚠️ IMPORTANT: You already outputted this text:
---
${priorText}
---

**DO NOT REPEAT THIS TEXT IN YOUR RESPONSE.**

` : ''}Please output **ONLY** the corrected tool call using the exact format below:

${m.TC_START}
${m.NAME_START}function_name${m.NAME_END}
${m.ARGS_START}{"param": "value"}${m.ARGS_END}
${m.TC_END}

Critical requirements:
1. Include ALL delimiters exactly as shown above
2. Ensure JSON arguments are valid (no trailing commas, proper escaping)
3. Do NOT include any text before or after the tool call block
4. Start your response immediately with: ${m.TC_START}
5. Do not repeat any previously outputted text

Your response should contain ONLY the tool call block, nothing else.`;
  }

  private buildRequestBody(messages: any[]): any {
    // 🔑 使用原始请求的模型和协议，改用流式
    if (this.protocol === "anthropic") {
      // Anthropic 格式
      return {
        model: this.model,  // 使用传入的模型
        max_tokens: 4096,
        messages,
        stream: true,  // 🔑 改用流式
      };
    } else {
      // OpenAI 格式
      return {
        model: this.model,  // 使用传入的模型
        messages,
        stream: true,  // 🔑 改用流式
        max_tokens: 4096,
      };
    }
  }


  private parseToolCallFromContent(
    content: string,
    delimiter: ToolCallDelimiter
  ): ParsedInvokeCall | null {
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
      try {
        const args = JSON.parse(argsStr);
        return { name, arguments: args };
      } catch (e) {
        log("warn", "Failed to parse retry tool call JSON", {
          requestId: this.requestId,
          argsStr: argsStr.slice(0, 200),
          error: String(e)
        });
        return null;
      }
    }
    return null;
  }
}
