import { log, logPhase, LogPhase } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";
import { ParsedInvokeCall } from "./types.ts";
import { ToolifyParser } from "./parser.ts";
import { RequestContext, ContextBuilder } from "./ai_client/mod.ts";
import { anthropicToOpenAIResponsesRequest } from "./openai_compat.ts";

// 在非原生工具调用模式下，若模型输出的工具调用格式不合法，
// 该处理器会构造一次“纠错重试”请求，让上游只返回修正后的工具调用块。
export class ToolCallRetryHandler {
  constructor(
    private context: RequestContext,
  ) {}

  async retry(
    failedContent: string,
    priorText: string,
    delimiter: ToolCallDelimiter,
    attemptCount: number,
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

    // 记录本次重试开始信息，便于后续排查格式问题。
    log("warn", "Tool call parse failed, initiating retry", {
      requestId,
      attemptCount,
      maxRetries: config.toolCallRetry?.maxRetries || 1,
      failedContentPreview: failedContent.slice(0, 200),
      priorTextLength: priorText.length,
      strategy: "correction",
    });
    logPhase(requestId, LogPhase.RETRY, `Attempt ${attemptCount}`, {
      priorTextPreview: priorText.slice(0, 100),
    });

    // 生成纠错提示词，并拼出一次新的重试上下文。
    const correctionPrompt = this.buildCorrectionPrompt(
      failedContent,
      priorText,
      delimiter,
    );
    const retryMessages = ContextBuilder.buildRetryContext(
      originalRequest.messages,
      failedContent,
      priorText,
      correctionPrompt,
    );

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        config.toolCallRetry?.timeout || 30000,
      );

      log("debug", "Sending retry request to upstream", {
        requestId,
        messageCount: retryMessages.length,
        url: upstreamConfig.baseUrl,
      });

      // 根据上游协议构造重试请求体。
      const protocol = upstreamConfig.protocol;
      const requestBody = this.buildRequestBody(
        retryMessages,
        protocol as "openai" | "openai-responses" | "anthropic",
      );

      // 不同协议需要不同的鉴权头。
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (protocol === "openai" || protocol === "openai-responses") {
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
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        const errorText = await response.text();
        log("error", "Retry request failed", {
          requestId,
          status: response.status,
          error: errorText.slice(0, 500),
        });
        return { success: false, error: `HTTP ${response.status}`, duration };
      }

      clearTimeout(timeoutId);

      // 统一按流式响应读取，兼容 OpenAI / Responses / Anthropic。
      const reader = response.body?.getReader();
      if (!reader) {
        log("error", "No response body reader", { requestId });
        return {
          success: false,
          error: "No response body",
          duration: Date.now() - startTime,
        };
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      let eventType = "";

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
              if (!trimmed.startsWith("data: ")) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === "[DONE]") break;

              try {
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta;
                if (delta?.content) {
                  fullContent += delta.content;
                }
              } catch {
                // 忽略单条 SSE 解析失败，继续读取后续内容。
              }
            } else if (protocol === "openai-responses") {
              if (!trimmed.startsWith("data: ")) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === "[DONE]") break;

              try {
                const data = JSON.parse(jsonStr);
                if (data.type === "response.output_text.delta") {
                  fullContent += data.delta || "";
                } else if (data.type === "response.completed" && !fullContent) {
                  for (const item of data.response?.output ?? []) {
                    if (item?.type !== "message") continue;
                    for (const part of item.content ?? []) {
                      if (part?.type === "output_text" && part.text) {
                        fullContent += part.text;
                      }
                    }
                  }
                }
              } catch {
                // 忽略单条 SSE 解析失败，继续读取后续内容。
              }
            } else {
              if (trimmed.startsWith("event: ")) {
                eventType = trimmed.slice(7);
              } else if (trimmed.startsWith("data: ")) {
                const jsonStr = trimmed.slice(6);
                try {
                  const data = JSON.parse(jsonStr);
                  if (eventType === "content_block_delta" && data.delta?.type === "text_delta") {
                    fullContent += data.delta.text || "";
                  }
                } catch {
                  // 忽略单条 SSE 解析失败，继续读取后续内容。
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
        log("warn", "Empty retry response", { requestId });
        return { success: false, error: "Empty response", duration };
      }

      // 再次尝试从修正后的内容中提取工具调用。
      const toolCall = this.parseToolCallFromContent(fullContent, delimiter);

      if (toolCall) {
        log("info", "Tool call retry succeeded", {
          requestId,
          attemptCount,
          toolName: toolCall.name,
          duration: `${duration}ms`,
        });
        logPhase(requestId, LogPhase.RETRY_SUCCESS, toolCall.name, {
          duration: `${(duration / 1000).toFixed(2)}s`,
        });
        return { success: true, result: toolCall, duration };
      }

      log("warn", "Retry response still invalid", {
        requestId,
        attemptCount,
        responsePreview: fullContent.slice(0, 300),
      });
      return { success: false, error: "Invalid retry response", duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      log("error", "Retry request exception", {
        requestId,
        attemptCount,
        error: errorMsg,
        duration: `${duration}ms`,
      });
      logPhase(requestId, LogPhase.RETRY_FAILED, "Exception", {
        error: errorMsg,
      });
      return { success: false, error: errorMsg, duration };
    }
  }

  // 生成用于“纠错重试”的提示词。
  private buildCorrectionPrompt(
    failedContent: string,
    priorText: string,
    delimiter: ToolCallDelimiter,
  ): string {
    const m = delimiter.getMarkers();
    const config = this.context.getConfig();

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

    return `Your previous tool call output was malformed and could not be parsed.

${priorText
  ? `⚠️ IMPORTANT: You already outputted this text:
---
${priorText}
---
**The above response is for reference only.**

`
  : ""}
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

  // 根据目标协议构造重试请求体。
  private buildRequestBody(
    messages: any[],
    protocol: "openai" | "openai-responses" | "anthropic",
  ): any {
    const originalRequest = this.context.getOriginalRequest();
    const upstreamConfig = this.context.getUpstreamConfig();

    if (protocol === "anthropic") {
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
    }

    if (protocol === "openai-responses") {
      return anthropicToOpenAIResponsesRequest(
        {
          ...originalRequest,
          model: upstreamConfig.model,
          messages,
          stream: true,
        },
        upstreamConfig.model,
        upstreamConfig.supportsSystemPrompt ?? true,
      );
    }

    return {
      model: upstreamConfig.model,
      messages,
      stream: true,
      max_tokens: originalRequest.max_tokens || 4096,
      temperature: originalRequest.temperature,
      top_p: originalRequest.top_p,
    };
  }

  // 从重试后的纯文本中再次提取工具调用块。
  private parseToolCallFromContent(
    content: string,
    delimiter: ToolCallDelimiter,
  ): ParsedInvokeCall | null {
    const requestId = this.context.getRequestId();
    const m = delimiter.getMarkers();
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex = new RegExp(
      `${esc(m.TC_START)}[\\s\\S]*?` +
        `${esc(m.NAME_START)}\\s*([\\s\\S]*?)\\s*${esc(m.NAME_END)}[\\s\\S]*?` +
        `${esc(m.ARGS_START)}\\s*([\\s\\S]*?)\\s*${esc(m.ARGS_END)}[\\s\\S]*?` +
        `${esc(m.TC_END)}`,
      "g",
    );

    const match = regex.exec(content);
    if (!match) {
      return null;
    }

    const name = match[1].trim();
    const argsStr = match[2].trim();

    // 复用解析器里的 JSON 修复逻辑，尽量提高容错率。
    const parser = new ToolifyParser(delimiter, false, requestId);
    const args = (parser as any).tryParseJson(argsStr);

    if (args !== null) {
      return { name, arguments: args };
    }

    log("warn", "Failed to parse retry tool call JSON even after repair", {
      requestId,
      argsStr: argsStr.slice(0, 200),
    });
    return null;
  }
}