import { ProxyConfig } from "./config.ts";
import { SSEWriter } from "./sse.ts";
import { log, logPhase, LogPhase } from "./logging.ts";
import { handleOpenAIStream } from "./handle_openai_stream.ts";
import { handleAnthropicStream } from "./handle_anthropic_stream.ts";
import { countTokensLocally } from "./token_counter.ts";
import { RequestContext, ProtocolAdapterFactory } from "./ai_client/mod.ts";
import { ToolifyParser } from "./parser.ts";
import type { ClaudeContentBlock } from "./types.ts";
import { ToolSeparator } from "./tools/tool_separator.ts";
import { ToolFormatConverter } from "./tools/tool_format_converter.ts";
import { MessageFormatConverter } from "./tools/message_format_converter.ts";
import { NativeToolCallStreamHandler } from "./tools/native_tool_call_stream_handler.ts";

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

  // 🔑 检查是否支持原生工具调用
  const supportsNativeToolCalling = context.supportsNativeToolCall();

  if (isStream && writer) {
    // 流式响应处理
    if (supportsNativeToolCalling && originalRequest.tools && originalRequest.tools.length > 0) {
      // 🔑 原生工具调用路径
      logPhase(requestId, LogPhase.PROTOCOL, `Native tool calling mode`, {
        toolsCount: originalRequest.tools.length,
        protocol: protocol,
        mode: "native",
      });

      return await handleNativeToolCalling(
        context,
        writer,
        abortSignal,
      );
    }

    // 🔑 传统 XML 注入路径（现有逻辑）
    if (delimiter && originalRequest.tools && originalRequest.tools.length > 0) {
      logPhase(requestId, LogPhase.PROTOCOL, `XML injection mode`, {
        toolsCount: originalRequest.tools.length,
        protocol: protocol,
        mode: "xml-injection",
      });
    }

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
      const supportsSystemPrompt = upstreamConfig.supportsSystemPrompt ?? true;
      const openaiReq = mapClaudeToOpenAI(enrichedRequest, upstreamConfig.model, supportsSystemPrompt);
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
    // 非流式响应
    const adapter = ProtocolAdapterFactory.create(protocol);

    // 构建请求头
    const headers = adapter.buildHeaders(upstreamConfig.apiKey);

    // 构建请求体 - 格式化 system 字段
    const requestOptions: any = {
      max_tokens: originalRequest.max_tokens || 4096,
      temperature: originalRequest.temperature,
      top_p: originalRequest.top_p,
      metadata: {
        model: upstreamConfig.model,
        system: systemText, // 使用格式化后的字符串
        supportsSystemPrompt: upstreamConfig.supportsSystemPrompt, // 传递系统提示词支持标志
      },
    };

    // 🔑 如果支持原生工具调用，传递工具定义
    let separatedTools: ReturnType<typeof ToolSeparator.separate> | null = null;
    if (supportsNativeToolCalling && originalRequest.tools && originalRequest.tools.length > 0) {
      logPhase(requestId, LogPhase.ENRICHED, `Using native tool calling mode (non-stream)`, {
        toolsCount: originalRequest.tools.length,
        protocol: protocol,
      });

      const separated = ToolSeparator.separate(originalRequest.tools);
      separatedTools = separated;
      const allTools = [...separated.webTools, ...separated.nativeTools];

      if (protocol === "openai") {
        // OpenAI 格式需要转换工具定义
        requestOptions.tools = ToolFormatConverter.convertToolDefinitionsToOpenAI(allTools);
      } else {
        // Anthropic 格式直接传递
        requestOptions.tools = allTools;
      }

      if (originalRequest.tool_choice) {
        requestOptions.tool_choice = originalRequest.tool_choice;
      }
    }

    // 辅助函数：处理文本内容（支持工具解析）
    const processTextContent = (text: string, targetContent: Array<Record<string, unknown>>) => {
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
              targetContent.push({ type: "text", text: event.content });
            }
          } else if (event.type === "tool_call") {
            targetContent.push({
              type: "tool_use",
              id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              name: event.call.name,
              input: event.call.arguments,
            });
          } else if (event.type === "thinking") {
            if (event.content) {
              targetContent.push({ type: "thinking", thinking: event.content } as any);
            }
          } else if (event.type === "tool_call_failed") {
            // 解析失败，降级为文本
            if (event.content) {
              targetContent.push({ type: "text", text: event.content });
            }
          }
        }
      } else {
        // 没有 delimiter，直接作为文本
        targetContent.push({ type: "text", text: text });
      }
    };

    // 辅助函数：解析响应内容
    const parseResponseContent = (aiResponse: any, targetContent: Array<Record<string, unknown>>) => {
      if (protocol === "anthropic") {
        const raw = aiResponse.raw as Record<string, unknown>;
        const responseContent = raw?.content;

        if (Array.isArray(responseContent)) {
          for (const block of responseContent) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              processTextContent((b.text as string) || "", targetContent);
            } else if (b.type === "tool_use") {
              targetContent.push({
                type: "tool_use",
                id: (b.id as string) || `toolu_${Date.now()}`,
                name: (b.name as string),
                input: (b.input as Record<string, unknown>) || {},
              });
            }
          }
        } else if (typeof aiResponse.content === "string") {
          processTextContent(aiResponse.content, targetContent);
        }
      } else {
        const raw = aiResponse.raw as any;
        const message = raw?.choices?.[0]?.message;

        if (message) {
          if (message.content && typeof message.content === "string") {
            processTextContent(message.content, targetContent);
          }

          const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const func = tc.function as Record<string, unknown> | undefined;
              if (func) {
                targetContent.push({
                  type: "tool_use",
                  id: (tc.id as string) || `toolu_${Date.now()}`,
                  name: (func.name as string) || "",
                  input: func.arguments ? JSON.parse(func.arguments as string) : {},
                });
              }
            }
          }
        } else if (typeof aiResponse.content === "string") {
          processTextContent(aiResponse.content, targetContent);
        }
      }
    };

    // 辅助函数：发送非流式请求并解析响应
    const sendAndParse = async (messages: any[], opts: any) => {
      const body = adapter.buildRequestBody(messages, opts);
      const resp = await fetch(upstreamConfig.baseUrl, {
        method: "POST",
        headers,
        body,
        signal: abortSignal,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        logPhase(requestId, LogPhase.ERROR, `Upstream failed (${resp.status})`, {
          error: errorText.slice(0, 200),
        });
        throw new Error(`Upstream returned ${resp.status}: ${errorText}`);
      }

      const json = await resp.json();
      const aiResp = adapter.parseResponse(json);
      const parsedContent: Array<Record<string, unknown>> = [];
      parseResponseContent(aiResp, parsedContent);

      return { aiResponse: aiResp, content: parsedContent };
    };

    // 首次请求
    const firstResult = await sendAndParse(
      supportsNativeToolCalling ? originalRequest.messages : enrichedRequest.messages,
      requestOptions,
    );

    let content = firstResult.content;
    let lastAiResponse = firstResult.aiResponse;

    // 🔑 非流式原生路径：Web 工具拦截多轮循环
    if (supportsNativeToolCalling && separatedTools && separatedTools.webTools.length > 0) {
      const webToolNames = new Set(separatedTools.webTools.map((t: any) => t.name || ""));

      // 创建 interceptor（如果可用）
      const interceptor = config.webTools && config.firecrawl
        ? new (await import("./tools/tool_interceptor.ts")).ToolInterceptor(
          config.firecrawl,
          config.webTools,
        )
        : null;

      // 维护消息历史用于多轮调用
      let messageHistory = [...(originalRequest.messages || [])];
      let maxRounds = 10;
      let currentRound = 0;

      while (currentRound < maxRounds) {
        // 检查当前 content 中是否有 Web 工具调用
        const webToolUses = content.filter(
          (b) => b.type === "tool_use" && webToolNames.has(b.name as string),
        );

        if (webToolUses.length === 0) break;

        if (!interceptor) {
          log("warn", "Web tool calls found but no ToolInterceptor configured, skipping interception", {
            requestId,
            webToolCount: webToolUses.length,
          });
          break;
        }

        currentRound++;
        logPhase(requestId, LogPhase.ENRICHED, `Non-stream web tool interception round ${currentRound}`, {
          webToolCount: webToolUses.length,
        });

        // 将 assistant 响应添加到消息历史
        messageHistory.push({
          role: "assistant",
          content: content as any,
        });

        // 执行每个 Web 工具调用并收集结果
        const toolResults: any[] = [];
        for (const toolUse of webToolUses) {
          const toolName = toolUse.name as string;
          const toolId = toolUse.id as string;
          const toolInput = toolUse.input as Record<string, unknown>;

          try {
            let resultContent: string;

            if (toolName === "web_search") {
              const query = toolInput.query as string;
              const webSearchTool = separatedTools.webTools.find((t: any) => t.name === "web_search");
              if (webSearchTool && query) {
                const searchResult = await interceptor.handleWebSearchWithQuery(
                  webSearchTool as any,
                  query,
                  requestId,
                );
                resultContent = JSON.stringify(searchResult.toolResult.content);
              } else {
                resultContent = "Error: Invalid web_search parameters";
              }
            } else if (toolName === "web_fetch") {
              const url = toolInput.url as string;
              const webFetchTool = separatedTools.webTools.find((t: any) => t.name === "web_fetch");
              if (webFetchTool && url) {
                const fetchResult = await interceptor.handleWebFetch(
                  webFetchTool as any,
                  url,
                  requestId,
                );
                resultContent = JSON.stringify(fetchResult.toolResult.content);
              } else {
                resultContent = "Error: Invalid web_fetch parameters";
              }
            } else {
              resultContent = `Unknown web tool: ${toolName}`;
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolId,
              content: resultContent,
            });
          } catch (error) {
            log("error", "Non-stream web tool execution failed", {
              requestId,
              toolName,
              error: String(error),
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolId,
              content: `Error executing ${toolName}: ${String(error)}`,
            });
          }
        }

        // 将工具结果添加到消息历史
        messageHistory.push({
          role: "user",
          content: toolResults,
        });

        // 重新发送请求
        const retryResult = await sendAndParse(messageHistory, requestOptions);
        content = retryResult.content;
        lastAiResponse = retryResult.aiResponse;
      }

      if (currentRound >= maxRounds) {
        log("warn", "Non-stream: reached maximum web tool call rounds", {
          requestId,
          maxRounds,
        });
      }
    }

    return {
      id: (lastAiResponse.raw as any)?.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: upstreamConfig.model,
      content,
      stop_reason: lastAiResponse.finish_reason || "end_turn",
      stop_sequence: null,
      usage: lastAiResponse.usage,
    };
  }
}

/**
 * 处理原生工具调用模式的请求
 *
 * 关键逻辑：
 * 1. 分离 Web 工具和其他工具
 * 2. 将工具定义转换为上游格式
 * 3. 发送请求到上游
 * 4. 使用 NativeToolCallStreamHandler 处理响应
 */
async function handleNativeToolCalling(
  context: RequestContext,
  writer: SSEWriter,
  abortSignal?: AbortSignal,
): Promise<void> {
  const requestId = context.getRequestId();
  const config = context.getConfig();
  const upstreamConfig = context.getUpstreamConfig();
  const originalRequest = context.getOriginalRequest();
  const protocol = upstreamConfig.protocol as "openai" | "anthropic";

  // 1. 分离工具
  const { webTools, nativeTools } = ToolSeparator.separate(originalRequest.tools);

  logPhase(requestId, LogPhase.ENRICHED, `Separated tools`, {
    webToolsCount: webTools.length,
    nativeToolsCount: nativeTools.length,
  });

  // 2. 创建 ToolInterceptor（用于执行 Web 工具）
  const interceptor = config.webTools && config.firecrawl
    ? new (await import("./tools/tool_interceptor.ts")).ToolInterceptor(
      config.firecrawl,
      config.webTools,
    )
    : null;

  // 3. 构建请求
  let requestBody: string;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (protocol === "openai") {
    // 设置认证头
    if (upstreamConfig.apiKey) {
      headers["Authorization"] = `Bearer ${upstreamConfig.apiKey}`;
    }

    // 转换为 OpenAI 格式，传递系统提示词支持标志
    const supportsSystemPrompt = upstreamConfig.supportsSystemPrompt ?? true;
    const openaiRequest = MessageFormatConverter.anthropicToOpenAI(originalRequest, supportsSystemPrompt);

    // 转换工具定义（包括 Web 工具和原生工具）
    const allTools = [...webTools, ...nativeTools];
    if (allTools.length > 0) {
      openaiRequest.tools = ToolFormatConverter.convertToolDefinitionsToOpenAI(allTools);
    } else {
      delete openaiRequest.tools; // 如果没有工具，删除 tools 字段
    }

    // 覆盖模型名
    openaiRequest.model = upstreamConfig.model;
    openaiRequest.stream = true;

    requestBody = JSON.stringify(openaiRequest);
  } else if (protocol === "anthropic") {
    // 设置认证头
    if (upstreamConfig.apiKey) {
      headers["x-api-key"] = upstreamConfig.apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";

    // Anthropic 格式，直接使用原始请求，传递所有工具
    const allTools = [...webTools, ...nativeTools];
    const anthropicRequest = {
      ...originalRequest,
      model: upstreamConfig.model,
      stream: true,
      tools: allTools.length > 0 ? allTools : undefined,
    };

    // 移除 undefined 字段
    if (!anthropicRequest.tools) {
      delete anthropicRequest.tools;
    }

    requestBody = JSON.stringify(anthropicRequest);
  } else {
    throw new Error(`Unsupported protocol for native tool calling: ${protocol}`);
  }

  // 3. 发送请求
  logPhase(requestId, LogPhase.UPSTREAM, `Sending native tool call request`, {
    protocol,
    url: upstreamConfig.baseUrl,
    nativeToolsCount: nativeTools.length,
  });

  const upstreamStartTime = Date.now();
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

  const ttfb = Date.now() - upstreamStartTime;
  logPhase(requestId, LogPhase.STREAM, `Receiving native tool call response (TTFB: ${ttfb}ms)`);

  // 4. 处理流式响应（支持多轮工具调用）
  if (webTools.length > 0 && !interceptor) {
    throw new Error("ToolInterceptor is required for handling web tools in native tool calling mode");
  }

  const handler = new NativeToolCallStreamHandler(context, writer, webTools, interceptor);
  await handler.handleStream(response);

  // 5. 不再进行多轮循环，直接结束
  // 根据用户要求，原生模式也要像非原生模式一样，将工具调用结果返回给客户端
  // 由客户端决定是否发起下一轮请求
  log("info", "Native tool call stream finished (no auto-loop)", {
    requestId,
  });
}
