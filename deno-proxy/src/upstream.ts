import { ProxyConfig } from "./config.ts";
import { SSEWriter } from "./sse.ts";
import { log, LogPhase, logPhase } from "./logging.ts";
import { handleOpenAIStream } from "./handle_openai_stream.ts";
import { handleAnthropicStream } from "./handle_anthropic_stream.ts";
import { countTokensLocally } from "./token_counter.ts";
import { ProtocolAdapterFactory, RequestContext } from "./ai_client/mod.ts";
import { ToolifyParser } from "./parser.ts";
import type { ClaudeContentBlock } from "./types.ts";
import { ToolSeparator } from "./tools/tool_separator.ts";
import { MessageFormatConverter } from "./tools/message_format_converter.ts";
import { NativeToolCallStreamHandler } from "./tools/native_tool_call_stream_handler.ts";
import { anthropicToOpenAIResponsesRequest } from "./openai_compat.ts";
import { isAnthropicWebFetchTool, isAnthropicWebSearchTool } from "./tools/types.ts";

export class UpstreamRequestError extends Error {
  status: number;
  body: string;
  payload?: unknown;

  constructor(status: number, body: string) {
    super(`Upstream returned ${status}: ${body}`);
    this.name = "UpstreamRequestError";
    this.status = status;
    this.body = body;
    try {
      this.payload = JSON.parse(body);
    } catch {
      this.payload = undefined;
    }
  }
}

// 将 system 字段统一格式化为纯文本。
function formatSystem(system: string | ClaudeContentBlock[] | undefined): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.type === "text" ? b.text : "").join("\n");
}

function convertClaudeToolsToOpenAICompatible(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    if (isAnthropicWebSearchTool(tool)) {
      return {
        type: "web_search_preview",
        user_location: tool.user_location,
        allowed_domains: tool.allowed_domains,
        blocked_domains: tool.blocked_domains,
      };
    }

    if (isAnthropicWebFetchTool(tool)) {
      return {
        type: "web_fetch",
      };
    }

    const existingFunction = tool.function;
    if (existingFunction && typeof existingFunction === "object") {
      return tool;
    }

    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    };
  });
}

function resolveWebKindByToolName(name: string | undefined): "web_search" | "web_fetch" | undefined {
  if (!name) return undefined;
  if (name === "web_search" || name === "web_search_preview" || name === "web_search_20250305") {
    return "web_search";
  }
  if (name === "web_fetch" || name === "web_fetch_preview" || name === "web_fetch_20250910") {
    return "web_fetch";
  }
  return undefined;
}

// 将内部请求按目标协议转发到上游，并处理流式/非流式响应。
export async function forwardRequest(
  context: RequestContext,
  writer: SSEWriter | undefined,
  abortSignal?: AbortSignal,
) {
  const requestId = context.getRequestId();
  const config = context.getConfig();
  const upstreamConfig = context.getUpstreamConfig();
  const enrichedRequest = context.getEnrichedRequest();
  const originalRequest = context.getOriginalRequest();
  const delimiter = context.getDelimiter();

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

  if (delimiter && originalRequest.tools && originalRequest.tools.length > 0) {
    logPhase(requestId, LogPhase.ENRICHED, `Injected ${originalRequest.tools.length} tools`, {
      delimiter: delimiter.getMarkers().TC_START,
    });
  }

  const isStream = originalRequest.stream === true;
  const protocol = upstreamConfig.protocol as "openai" | "openai-responses" | "anthropic";

  logPhase(requestId, LogPhase.UPSTREAM, `Forwarding to ${protocol.toUpperCase()}`, {
    model: upstreamConfig.model,
    url: upstreamConfig.baseUrl.split("/").pop(),
  });

  const localUsage = await countTokensLocally(enrichedRequest, config, requestId);
  const inputTokens = localUsage.input_tokens;

  const thinkingEnabled = originalRequest.thinking?.type === "enabled";

  const supportsNativeToolCalling = context.supportsNativeToolCall();

  if (isStream && writer) {
    if (supportsNativeToolCalling && originalRequest.tools && originalRequest.tools.length > 0) {
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

    let fetchBody: string;
    if (protocol === "openai") {
      const { mapClaudeToOpenAI } = await import("./map_claude_to_openai.ts");
      const supportsSystemPrompt = upstreamConfig.supportsSystemPrompt ?? true;
      const openaiReq = mapClaudeToOpenAI(
        enrichedRequest,
        upstreamConfig.model,
        supportsSystemPrompt,
      );
      openaiReq.stream = true;
      fetchBody = JSON.stringify(openaiReq);
      logPhase(requestId, LogPhase.FORMAT, "Built OpenAI Chat upstream payload", {
        protocol,
        stream: true,
        requestBytes: fetchBody.length,
        toolsCount: originalRequest.tools?.length ?? 0,
      });
    } else if (protocol === "openai-responses") {
      const supportsSystemPrompt = upstreamConfig.supportsSystemPrompt ?? true;
      fetchBody = JSON.stringify(
        anthropicToOpenAIResponsesRequest(
          enrichedRequest,
          upstreamConfig.model,
          supportsSystemPrompt,
        ),
      );
      logPhase(requestId, LogPhase.FORMAT, "Built OpenAI Responses upstream payload", {
        protocol,
        stream: true,
        requestBytes: fetchBody.length,
        toolsCount: originalRequest.tools?.length ?? 0,
      });
    } else {
      const anthropicReq = {
        ...enrichedRequest,
        model: upstreamConfig.model,
        stream: true,
      };
      fetchBody = JSON.stringify(anthropicReq);
      logPhase(requestId, LogPhase.FORMAT, "Built Anthropic upstream payload", {
        protocol,
        stream: true,
        requestBytes: fetchBody.length,
        toolsCount: originalRequest.tools?.length ?? 0,
      });
    }

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
      throw new UpstreamRequestError(response.status, errorText);
    }

    const ttfb = Date.now() - upstreamStartTime;
    logPhase(requestId, LogPhase.STREAM, `Receiving response (TTFB: ${ttfb}ms)`);

    if (protocol === "openai" || protocol === "openai-responses") {
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
    const adapter = ProtocolAdapterFactory.create(protocol);

    const headers = adapter.buildHeaders(upstreamConfig.apiKey);

    const requestOptions: any = {
      max_tokens: originalRequest.max_tokens || 4096,
      temperature: originalRequest.temperature,
      top_p: originalRequest.top_p,
      metadata: {
        ...(originalRequest.metadata && typeof originalRequest.metadata === "object"
          ? originalRequest.metadata as Record<string, unknown>
          : {}),
        model: upstreamConfig.model,
        system: systemText, 
        supportsSystemPrompt: upstreamConfig.supportsSystemPrompt, 
      },
    };

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
        requestOptions.tools = convertClaudeToolsToOpenAICompatible(
          allTools as Array<Record<string, unknown>>,
        );
      } else {
        requestOptions.tools = allTools;
      }

      if (originalRequest.tool_choice) {
        requestOptions.tool_choice = originalRequest.tool_choice;
      }
    }

    const processTextContent = (text: string, targetContent: Array<Record<string, unknown>>) => {
      if (delimiter) {
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
            if (event.content) {
              targetContent.push({ type: "text", text: event.content });
            }
          }
        }
      } else {
        targetContent.push({ type: "text", text: text });
      }
    };

    const parseResponseContent = (
      aiResponse: any,
      targetContent: Array<Record<string, unknown>>,
    ) => {
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
      } else if (protocol === "openai-responses") {
        if (Array.isArray(aiResponse.content)) {
          const completedServerToolIds = new Set<string>();
          for (const block of aiResponse.content) {
            const b = block as Record<string, unknown>;
            if (
              (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") &&
              typeof b.tool_use_id === "string"
            ) {
              completedServerToolIds.add(b.tool_use_id);
            }
          }

          for (const block of aiResponse.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              processTextContent(String(b.text ?? ""), targetContent);
              continue;
            }

            if (b.type === "thinking") {
              const thinkingText = String(b.thinking ?? "");
              if (thinkingText) {
                targetContent.push({ type: "thinking", thinking: thinkingText } as any);
              }
              continue;
            }

            if (b.type === "tool_use" || b.type === "server_tool_use") {
              if (b.type === "server_tool_use" && typeof b.id === "string" && completedServerToolIds.has(b.id)) {
                continue;
              }
              targetContent.push({
                type: "tool_use",
                id: (b.id as string) || `toolu_${Date.now()}`,
                name: (b.name as string) || "",
                input: (b.input as Record<string, unknown>) || {},
              });
              continue;
            }

            if (b.type === "image") {
              targetContent.push(b);
            }
          }
          return;
        }

        if (typeof aiResponse.content === "string") {
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
                let parsedArguments: Record<string, unknown> = {};
                if (typeof func.arguments === "string") {
                  try {
                    parsedArguments = JSON.parse(func.arguments) as Record<string, unknown>;
                  } catch {
                    parsedArguments = {};
                  }
                } else if (func.arguments && typeof func.arguments === "object") {
                  parsedArguments = func.arguments as Record<string, unknown>;
                }

                targetContent.push({
                  type: "tool_use",
                  id: (tc.id as string) || `toolu_${Date.now()}`,
                  name: (func.name as string) || "",
                  input: parsedArguments,
                });
              }
            }
          }
        } else if (typeof aiResponse.content === "string") {
          processTextContent(aiResponse.content, targetContent);
        }
      }
    };

    const serializeCompatibilityContent = (value: unknown): string => {
      if (typeof value === "string") {
        return value;
      }
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const block = item as Record<string, unknown>;
            if (block.type === "text") return String(block.text ?? "");
            if (block.type === "tool_result") return String(block.content ?? "");
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (value && typeof value === "object") {
        return JSON.stringify(value);
      }
      return "";
    };

    const buildCompatibilityRetryMessages = (messages: any[], sourceMessages: any[]): any[] | null => {
      const lookupMessages = sourceMessages.length > 0 ? sourceMessages : messages;
      const assistantMessages = lookupMessages.filter((msg) => msg?.role === "assistant");
      const userMessages = lookupMessages.filter((msg) => msg?.role === "user");
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      const lastUser = userMessages[userMessages.length - 1];

      const assistantBlocks = Array.isArray(lastAssistant?.content) ? lastAssistant.content : [];
      const userBlocks = Array.isArray(lastUser?.content) ? lastUser.content : [];

      const latestToolUse = [...assistantBlocks].reverse().find((block: any) => block?.type === "tool_use");
      const latestToolResult = [...userBlocks].reverse().find((block: any) => block?.type === "tool_result");

      if (!latestToolUse || !latestToolResult) {
        return null;
      }

      const toolName = String(latestToolUse.name ?? "tool");
      const toolResult = serializeCompatibilityContent(latestToolResult.content).trim();
      if (!toolResult) {
        return null;
      }

      return [{
        role: "user",
        content: `The tool ${toolName} returned ${toolResult}. Please answer the user's request using this result only.`,
      }];
    };

    const sendAndParse = async (messages: any[], opts: any, allowCompatibilityRetry = true) => {
      const body = adapter.buildRequestBody(messages, opts);
      const resp = await fetch(upstreamConfig.baseUrl, {
        method: "POST",
        headers,
        body,
        signal: abortSignal,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        const canRetryCompatibility = allowCompatibilityRetry &&
          !supportsNativeToolCalling &&
          !originalRequest.tools?.length &&
          errorText.includes("EMPTY_RESPONSE");

        if (canRetryCompatibility) {
          const compatibilityMessages = buildCompatibilityRetryMessages(messages, originalRequest.messages ?? []);
          if (compatibilityMessages) {
            logPhase(requestId, LogPhase.PROTOCOL, "Retrying non-native follow-up with compatibility summary", {
              protocol,
              originalMessageCount: messages.length,
              retriedMessageCount: compatibilityMessages.length,
            });
            return await sendAndParse(compatibilityMessages, opts, false);
          }
        }

        logPhase(requestId, LogPhase.ERROR, `Upstream failed (${resp.status})`, {
          error: errorText.slice(0, 200),
        });
        throw new UpstreamRequestError(resp.status, errorText);
      }

      const json = await resp.json();
      const aiResp = adapter.parseResponse(json);
      const parsedContent: Array<Record<string, unknown>> = [];
      parseResponseContent(aiResp, parsedContent);

      return { aiResponse: aiResp, content: parsedContent };
    };

    const firstResult = await sendAndParse(
      supportsNativeToolCalling ? originalRequest.messages : enrichedRequest.messages,
      requestOptions,
    );

    let content = firstResult.content;
    let lastAiResponse = firstResult.aiResponse;
    let stopReasonOverride: string | undefined;

    if (supportsNativeToolCalling && separatedTools && separatedTools.webTools.length > 0) {
      const webSearchToolDefinition = separatedTools.webTools.find((tool) =>
        isAnthropicWebSearchTool(tool)
      ) as Record<string, unknown> | undefined;
      const webFetchToolDefinition = separatedTools.webTools.find((tool) =>
        isAnthropicWebFetchTool(tool)
      );

      const interceptor = config.webTools && config.firecrawl
        ? new (await import("./tools/tool_interceptor.ts")).ToolInterceptor(
          config.firecrawl,
          config.webTools,
        )
        : null;

      let messageHistory = [...(originalRequest.messages || [])];
      let maxRounds = 10;
      let currentRound = 0;
      const upstreamInfo = {
        baseUrl: upstreamConfig.baseUrl,
        apiKey: upstreamConfig.apiKey,
        model: upstreamConfig.model,
        protocol: upstreamConfig.protocol as "openai" | "openai-responses" | "anthropic",
      };

      const buildEffectiveSearchDefinition = (toolInput: Record<string, unknown>) => {
        if (!webSearchToolDefinition) return undefined;
        const filters = (toolInput.filters && typeof toolInput.filters === "object")
          ? toolInput.filters as Record<string, unknown>
          : undefined;

        return {
          ...webSearchToolDefinition,
          allowed_domains: Array.isArray(toolInput.allowed_domains)
            ? toolInput.allowed_domains
            : Array.isArray(toolInput.domains)
            ? toolInput.domains
            : Array.isArray(filters?.allowed_domains)
            ? filters.allowed_domains
            : webSearchToolDefinition.allowed_domains,
          blocked_domains: Array.isArray(toolInput.blocked_domains)
            ? toolInput.blocked_domains
            : Array.isArray(filters?.blocked_domains)
            ? filters.blocked_domains
            : webSearchToolDefinition.blocked_domains,
        };
      };

      while (currentRound < maxRounds) {
        const webToolUses = content.filter(
          (b) => b.type === "tool_use" && !!resolveWebKindByToolName(String(b.name ?? "")),
        );

        if (webToolUses.length === 0) break;

        if (!interceptor) {
          log(
            "warn",
            "Web tool calls found but no ToolInterceptor configured, skipping interception",
            {
              requestId,
              webToolCount: webToolUses.length,
            },
          );
          break;
        }

        currentRound++;
        logPhase(
          requestId,
          LogPhase.ENRICHED,
          `Non-stream web tool interception round ${currentRound}`,
          {
            webToolCount: webToolUses.length,
          },
        );

        messageHistory.push({
          role: "assistant",
          content: content as any,
        });

        const canUseSmartSearch = interceptor.isSmartSearchMode() &&
          webToolUses.length === 1 &&
          resolveWebKindByToolName(String(webToolUses[0].name ?? "")) === "web_search";
        if (canUseSmartSearch) {
          const smartToolUse = webToolUses[0];
          const smartToolInput = (smartToolUse.input as Record<string, unknown>) || {};
          const query = typeof smartToolInput.query === "string" ? smartToolInput.query : "";
          const effectiveSearchTool = buildEffectiveSearchDefinition(smartToolInput);

          if (query && effectiveSearchTool) {
            const smartResult = await interceptor.handleSmartWebSearchWithQuery(
              effectiveSearchTool as any,
              query,
              messageHistory,
              upstreamInfo,
              requestId,
            );

            content = [
              smartResult.serverToolUse as any,
              smartResult.toolResult as any,
              { type: "text", text: smartResult.llmAnalysis.text },
            ];
            stopReasonOverride = "end_turn";
            break;
          }
        }

        const toolResults: any[] = [];
        for (const toolUse of webToolUses) {
          const toolName = toolUse.name as string;
          const toolId = toolUse.id as string;
          const toolInput = toolUse.input as Record<string, unknown>;
          const webKind = resolveWebKindByToolName(toolName);

          try {
            let resultContent: string;

            if (webKind === "web_search") {
              const query = toolInput.query as string;
              const effectiveSearchTool = buildEffectiveSearchDefinition(toolInput);
              if (effectiveSearchTool && query) {
                const searchResult = await interceptor.handleWebSearchWithQuery(
                  effectiveSearchTool as any,
                  query,
                  requestId,
                );
                resultContent = JSON.stringify(searchResult.toolResult.content);
              } else {
                resultContent = "Error: Invalid web_search parameters";
              }
            } else if (webKind === "web_fetch") {
              const url = toolInput.url as string;
              if (webFetchToolDefinition && url) {
                const fetchResult = await interceptor.handleWebFetch(
                  webFetchToolDefinition as any,
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

        messageHistory.push({
          role: "user",
          content: toolResults,
        });

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
      stop_reason: stopReasonOverride || lastAiResponse.finish_reason || "end_turn",
      stop_sequence: null,
      usage: lastAiResponse.usage,
    };
  }
}

// 处理支持原生工具调用的上游请求。
async function handleNativeToolCalling(
  context: RequestContext,
  writer: SSEWriter,
  abortSignal?: AbortSignal,
): Promise<void> {
  const requestId = context.getRequestId();
  const config = context.getConfig();
  const upstreamConfig = context.getUpstreamConfig();
  const originalRequest = context.getOriginalRequest();
  const protocol = upstreamConfig.protocol as "openai" | "openai-responses" | "anthropic";

  const { webTools, nativeTools } = ToolSeparator.separate(originalRequest.tools);

  logPhase(requestId, LogPhase.ENRICHED, `Separated tools`, {
    webToolsCount: webTools.length,
    nativeToolsCount: nativeTools.length,
  });

  const interceptor = config.webTools && config.firecrawl
    ? new (await import("./tools/tool_interceptor.ts")).ToolInterceptor(
      config.firecrawl,
      config.webTools,
    )
    : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const allTools = [...webTools, ...nativeTools];

  if (protocol === "openai") {
    if (upstreamConfig.apiKey) {
      headers["Authorization"] = `Bearer ${upstreamConfig.apiKey}`;
    }

    // noop
  } else if (protocol === "openai-responses") {
    if (upstreamConfig.apiKey) {
      headers["Authorization"] = `Bearer ${upstreamConfig.apiKey}`;
    }

    // noop
  } else if (protocol === "anthropic") {
    if (upstreamConfig.apiKey) {
      headers["x-api-key"] = upstreamConfig.apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";

    // noop
  } else {
    throw new Error(`Unsupported protocol for native tool calling: ${protocol}`);
  }

  if (webTools.length > 0 && !interceptor) {
    throw new Error(
      "ToolInterceptor is required for handling web tools in native tool calling mode",
    );
  }

  const supportsSystemPrompt = upstreamConfig.supportsSystemPrompt ?? true;
  const maxRounds = 10;

  const buildRequestBody = (messages: any[]): string => {
    if (protocol === "openai") {
      const openaiRequest = MessageFormatConverter.anthropicToOpenAI(
        {
          ...originalRequest,
          messages,
          tools: allTools.length > 0 ? allTools : undefined,
        } as any,
        supportsSystemPrompt,
      );
      openaiRequest.model = upstreamConfig.model;
      openaiRequest.stream = true;
      return JSON.stringify(openaiRequest);
    }

    if (protocol === "openai-responses") {
      return JSON.stringify(
        anthropicToOpenAIResponsesRequest(
          {
            ...originalRequest,
            messages,
            model: upstreamConfig.model,
            tools: allTools.length > 0 ? allTools : undefined,
            stream: true,
          } as any,
          upstreamConfig.model,
          supportsSystemPrompt,
        ),
      );
    }

    const anthropicRequest: Record<string, unknown> = {
      model: upstreamConfig.model,
      max_tokens: originalRequest.max_tokens || 4096,
      messages,
      stream: true,
      system: originalRequest.system,
      temperature: originalRequest.temperature,
      top_p: originalRequest.top_p,
      stop_sequences: (originalRequest as any).stop_sequences,
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: originalRequest.tool_choice,
      thinking: originalRequest.thinking,
    };
    Object.keys(anthropicRequest).forEach((key) => {
      if (anthropicRequest[key] === undefined) {
        delete anthropicRequest[key];
      }
    });
    return JSON.stringify(anthropicRequest);
  };

  let messageHistory = [...(originalRequest.messages || [])];
  const handler = new NativeToolCallStreamHandler(context, writer, webTools, interceptor, messageHistory);
  let executedRounds = 0;
  let hasPendingFollowUp = false;

  for (let round = 1; round <= maxRounds; round++) {
    const requestBody = buildRequestBody(messageHistory);

    logPhase(requestId, LogPhase.UPSTREAM, `Sending native tool call request (round ${round})`, {
      protocol,
      url: upstreamConfig.baseUrl,
      nativeToolsCount: nativeTools.length,
      webToolsCount: webTools.length,
      nativeToolNames: nativeTools.map((tool: any) => tool.name ?? tool.type).filter(Boolean),
      webToolNames: webTools.map((tool: any) => tool.name ?? tool.type).filter(Boolean),
      bodyLength: requestBody.length,
    });

    log("debug", "Request body for native tool calling", {
      requestId,
      round,
      bodyPreview: requestBody.substring(0, 500),
      bodyLength: requestBody.length,
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
        round,
        error: errorText.slice(0, 200),
      });
      throw new UpstreamRequestError(response.status, errorText);
    }

    const ttfb = Date.now() - upstreamStartTime;
    logPhase(requestId, LogPhase.STREAM, `Receiving native tool call response (round ${round}, TTFB: ${ttfb}ms)`);

    hasPendingFollowUp = await handler.handleStream(response);
    executedRounds = round;
    messageHistory = handler.getMessageHistory();

    if (!hasPendingFollowUp) {
      break;
    }
  }

  if (hasPendingFollowUp && executedRounds >= maxRounds) {
    log("warn", "Native tool call stream reached max auto-intercept rounds", {
      requestId,
      maxRounds,
    });
    await writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      },
    });
    await writer.send({
      event: "message_stop",
      data: { type: "message_stop" },
    });
  }

  log("info", "Native tool call stream finished", {
    requestId,
    rounds: executedRounds,
    autoIntercepted: hasPendingFollowUp ? maxRounds : Math.max(0, executedRounds - 1),
  });
}
