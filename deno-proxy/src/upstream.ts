import { ProxyConfig } from "./config.ts";
import { SSEWriter } from "./sse.ts";
import { log, logPhase, LogPhase } from "./logging.ts";
import { handleOpenAIStream } from "./handle_openai_stream.ts";
import { handleAnthropicStream } from "./handle_anthropic_stream.ts";
import { countTokensLocally } from "./token_counter.ts";
import { RequestContext, ProtocolAdapterFactory } from "./ai_client/mod.ts";
import { ToolifyParser } from "./parser.ts";
import type { ClaudeContentBlock } from "./types.ts";

/**
 * 格式化 system 字段（支持字符串或数组格式）
 */
function formatSystem(system: string | ClaudeContentBlock[] | undefined): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  // 处理数组格式
  return system.map(b => b.type === "text" ? b.text : "").join("\n");
}

export async function forwardRequest(
  context: RequestContext,
  writer: SSEWriter | undefined,
  abortSignal?: AbortSignal,
) {
  // 从 RequestContext 获取所有必要信息
  const requestId = context.getRequestId();
  const config = context.getConfig();
  const upstreamConfig = context.getUpstreamConfig();
  const enrichedRequest = context.getEnrichedRequest();
  const originalRequest = context.getOriginalRequest();
  const delimiter = context.getDelimiter();

  // 🔑 调试日志：检查工具注入状态
  const systemText = formatSystem(enrichedRequest.system);
  log("debug", "Tool call check", {
    requestId,
    hasOriginalTools: !!originalRequest.tools,
    originalToolsCount: originalRequest.tools?.length || 0,
    hasDelimiter: !!delimiter,
    hasEnrichedSystem: !!systemText,
    systemPreview: systemText?.substring(0, 100),
    enrichedMessagesCount: enrichedRequest.messages.length,
  });

  // 记录工具注入信息
  if (delimiter && originalRequest.tools && originalRequest.tools.length > 0) {
    logPhase(requestId, LogPhase.ENRICHED, `Injected ${originalRequest.tools.length} tools`, {
      delimiter: delimiter.getMarkers().TC_START,
    });
  }

  // 准备请求参数
  const isStream = originalRequest.stream === true;
  const protocol = upstreamConfig.protocol as "openai" | "anthropic";

  logPhase(requestId, LogPhase.UPSTREAM, `Forwarding to ${protocol.toUpperCase()}`, {
    model: upstreamConfig.model,
    url: upstreamConfig.baseUrl.split("/").pop(),
  });

  // 计算输入 Token
  const localUsage = await countTokensLocally(enrichedRequest, config, requestId);
  const inputTokens = localUsage.input_tokens;

  // 处理响应
  const thinkingEnabled = originalRequest.thinking?.type === "enabled";

  if (isStream && writer) {
    // 流式响应：使用原始逻辑（包含完整的工具调用处理）
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

    // 构建请求体
    let fetchBody: string;
    if (protocol === "openai") {
      const { mapClaudeToOpenAI } = await import("./map_claude_to_openai.ts");
      const openaiReq = mapClaudeToOpenAI(enrichedRequest, upstreamConfig.model);
      openaiReq.stream = true;
      fetchBody = JSON.stringify(openaiReq);
    } else {
      const anthropicReq = {
        ...enrichedRequest,
        model: upstreamConfig.model,
        stream: true,
      };
      fetchBody = JSON.stringify(anthropicReq);
    }

    // 发送请求
    const upstreamStartTime = Date.now();
    const response = await fetch(upstreamConfig.baseUrl, {
      method: "POST",
      headers,
      body: fetchBody,
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logPhase(requestId, LogPhase.ERROR, `Upstream failed (${response.status})`, {
        error: errorText.slice(0, 200),
      });
      throw new Error(`Upstream returned ${response.status}: ${errorText}`);
    }

    const ttfb = Date.now() - upstreamStartTime;
    logPhase(requestId, LogPhase.STREAM, `Receiving response (TTFB: ${ttfb}ms)`);

    if (protocol === "openai") {
      return await handleOpenAIStream(
        response,
        writer,
        config,
        requestId,
        delimiter,
        thinkingEnabled,
        inputTokens,
        originalRequest,
        upstreamConfig.baseUrl,
        headers,
        protocol,
        undefined,
        context,
      );
    } else {
      return await handleAnthropicStream(
        response,
        writer,
        config,
        requestId,
        delimiter,
        thinkingEnabled,
        inputTokens,
        originalRequest,
        upstreamConfig.baseUrl,
        headers,
        protocol,
        undefined,
        context,
      );
    }
  } else {
    // 非流式响应：使用 ProtocolAdapter 构建请求并处理响应
    const adapter = ProtocolAdapterFactory.create(protocol);

    // 构建请求头
    const headers = adapter.buildHeaders(upstreamConfig.apiKey);

    // 构建请求体 - 格式化 system 字段
    const requestBody = adapter.buildRequestBody(enrichedRequest.messages, {
      max_tokens: originalRequest.max_tokens || 4096,
      temperature: originalRequest.temperature,
      top_p: originalRequest.top_p,
      metadata: {
        model: upstreamConfig.model,
        system: systemText, // 使用格式化后的字符串
      },
    });

    // 发送请求
    const response = await fetch(upstreamConfig.baseUrl, {
      method: "POST",
      headers,
      body: requestBody,
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logPhase(requestId, LogPhase.ERROR, `Upstream failed (${response.status})`, {
        error: errorText.slice(0, 200),
      });
      throw new Error(`Upstream returned ${response.status}: ${errorText}`);
    }

    const json = await response.json();

    // 使用 ProtocolAdapter 解析响应
    const aiResponse = adapter.parseResponse(json);

    // 解析工具调用（如果有）
    const content: Array<Record<string, unknown>> = [];

    // 辅助函数：处理文本内容（支持工具解析）
    const processTextContent = (text: string) => {
      if (delimiter) {
        // 如果有 delimiter，尝试解析其中的工具调用
        const parser = new ToolifyParser(delimiter, thinkingEnabled, requestId);
        for (const char of text) {
          parser.feedChar(char);
        }
        parser.finish();
        
        const events = parser.consumeEvents();
        for (const event of events) {
          if (event.type === "text") {
            if (event.content) {
              content.push({ type: "text", text: event.content });
            }
          } else if (event.type === "tool_call") {
            content.push({
              type: "tool_use",
              id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              name: event.call.name,
              input: event.call.arguments,
            });
          } else if (event.type === "thinking") {
            // 将 thinking 作为 text 输出，或者作为特殊的 thinking 块（如果客户端支持）
            // 这里为了保持兼容性，作为 text 输出，但加上前缀
            // 也可以选择忽略或者作为特殊块。
            // 考虑到 Claude 3.5 Sonnet 的 thinking 是原生的，这里如果是注入的 thinking，
            // 可能是文本的一部分。为了安全起见，我们将其包含在 text 中。
            // 但如果用户确实想要 thinking block，我们可以尝试添加 type: "thinking"
            // 目前只处理 text 和 tool_use
            if (event.content) {
              // 暂时作为 text 处理，并在前面加上 thinking 标记，方便调试或查看
              // 或者，如果客户端支持 thinking 类型，可以直接 push
              // 根据 types.ts，ClaudeContentBlock 支持 thinking
              content.push({ type: "thinking", thinking: event.content } as any);
            }
          } else if (event.type === "tool_call_failed") {
            // 解析失败，降级为文本
            if (event.content) {
              content.push({ type: "text", text: event.content });
            }
          }
        }
      } else {
        // 没有 delimiter，直接作为文本
        content.push({ type: "text", text: text });
      }
    };

    if (protocol === "anthropic") {
      // Anthropic 协议：解析 content 数组
      const raw = aiResponse.raw as Record<string, unknown>;
      const responseContent = raw?.content;

      if (Array.isArray(responseContent)) {
        for (const block of responseContent) {
          const b = block as Record<string, unknown>;
          if (b.type === "text") {
            processTextContent((b.text as string) || "");
          } else if (b.type === "tool_use") {
            content.push({
              type: "tool_use",
              id: (b.id as string) || `toolu_${Date.now()}`,
              name: (b.name as string),
              input: (b.input as Record<string, unknown>) || {},
            });
          }
          // 忽略其他类型的块
        }
      } else if (typeof aiResponse.content === "string") {
        processTextContent(aiResponse.content);
      }
    } else {
      // OpenAI 协议：解析 message.content 和 tool_calls
      const raw = aiResponse.raw as any;
      const message = raw?.choices?.[0]?.message;

      if (message) {
        // 解析文本内容
        if (message.content && typeof message.content === "string") {
          processTextContent(message.content);
        }

        // 解析原生工具调用（如果有）
        const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const func = tc.function as Record<string, unknown> | undefined;
            if (func) {
              content.push({
                type: "tool_use",
                id: (tc.id as string) || `toolu_${Date.now()}`,
                name: (func.name as string) || "",
                input: func.arguments ? JSON.parse(func.arguments as string) : {},
              });
            }
          }
        }
      } else if (typeof aiResponse.content === "string") {
        processTextContent(aiResponse.content);
      }
    }

    return {
      id: (aiResponse.raw as any)?.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: upstreamConfig.model,
      content,
      stop_reason: aiResponse.finish_reason || "end_turn",
      stop_sequence: null,
      usage: aiResponse.usage,
    };
  }
}
