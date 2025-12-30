import { ProxyConfig } from "./config.ts";
import { ClaudeRequest } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { log, logPhase, LogPhase } from "./logging.ts";
import { enrichClaudeRequest } from "./prompt_inject.ts";
import { mapClaudeToOpenAI } from "./map_claude_to_openai.ts";
import { handleOpenAIStream } from "./handle_openai_stream.ts";
import { handleAnthropicStream } from "./handle_anthropic_stream.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";
import { ToolifyParser } from "./parser.ts";

export async function forwardRequest(
  request: ClaudeRequest,
  writer: SSEWriter | undefined,
  config: ProxyConfig,
  requestId: string,
  clientApiKey?: string,
  abortSignal?: AbortSignal,
) {
  // 1. 自动选择上游配置
  let baseUrl: string;
  let apiKey: string | undefined;
  let requestModel: string;
  let protocol: "openai" | "anthropic";

  // 解析模型名：支持 "channel+model" 格式
  const modelName = request.model;
  const plusIndex = modelName.indexOf("+");
  
  if (plusIndex !== -1) {
    const channelName = modelName.slice(0, plusIndex);
    const actualModel = modelName.slice(plusIndex + 1);
    const channel = config.channelConfigs.find(c => c.name === channelName);
    
    if (channel) {
      baseUrl = channel.baseUrl;
      apiKey = channel.apiKey;
      requestModel = actualModel;
      protocol = channel.protocol ?? config.defaultProtocol;
    } else {
      // 找不到渠道，回退逻辑
      baseUrl = config.upstreamBaseUrl!;
      apiKey = config.upstreamApiKey;
      requestModel = modelName;
      protocol = config.defaultProtocol;
    }
  } else {
    // 没带冒号，使用默认上游或第一个渠道（如果存在）
    if (config.channelConfigs.length > 0) {
      const channel = config.channelConfigs[0];
      baseUrl = channel.baseUrl;
      apiKey = channel.apiKey;
      requestModel = modelName;
      protocol = channel.protocol ?? config.defaultProtocol;
    } else {
      baseUrl = config.upstreamBaseUrl!;
      apiKey = config.upstreamApiKey;
      requestModel = config.upstreamModelOverride ?? modelName;
      protocol = config.defaultProtocol;
    }
  }

  // 如果启用了透传 API key，则优先使用客户端提供的 key
  if (config.passthroughApiKey && clientApiKey) {
    apiKey = clientApiKey;
  }

  // 2. 增强请求（注入工具、处理 Tool Blocks）
  const { request: enrichedRequest, triggerSignal } = enrichClaudeRequest(request);
  
  if (triggerSignal && request.tools && request.tools.length > 0) {
    logPhase(requestId, LogPhase.ENRICHED, `Injected ${request.tools.length} tools`, {
      signal: triggerSignal.slice(0, 15) + "...",
    });
  }

  // 3. 准备转发请求
  let fetchBody: string;
  let finalUrl = baseUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const isStream = request.stream === true;

  if (protocol === "openai") {
    const openaiReq = mapClaudeToOpenAI(enrichedRequest, requestModel);
    openaiReq.stream = isStream;
    fetchBody = JSON.stringify(openaiReq);
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  } else {
    // Anthropic 协议
    const anthropicReq = {
      ...enrichedRequest,
      model: requestModel,
      stream: isStream,
    };
    fetchBody = JSON.stringify(anthropicReq);
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";
  }

  logPhase(requestId, LogPhase.UPSTREAM, `Forwarding to ${protocol.toUpperCase()}`, {
    model: requestModel,
    url: finalUrl.split("/").pop(),
  });

  // 4. 发送请求
  const upstreamStartTime = Date.now();
  const response = await fetch(finalUrl, {
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

  // 5. 处理响应
  const thinkingEnabled = request.thinking?.type === "enabled";
  const inputTokens = countTokensWithTiktoken(fetchBody, "cl100k_base");

  if (isStream && writer) {
    if (protocol === "openai") {
      const result = await handleOpenAIStream(
        response,
        writer,
        config,
        requestId,
        triggerSignal,
        thinkingEnabled,
        inputTokens,
      );
      return { inputTokens, outputTokens: result?.outputTokens };
    } else {
      const result = await handleAnthropicStream(
        response,
        writer,
        config,
        requestId,
        triggerSignal,
        thinkingEnabled,
        inputTokens,
      );
      return { inputTokens, outputTokens: result?.outputTokens };
    }
  } else {
    // 非流式响应处理
    const json = await response.json();
    if (protocol === "openai") {
      // 将 OpenAI 非流式响应转换为 Claude 格式
      // 注意：这里需要模拟 Toolify 解析逻辑，因为非流式响应也可能包含工具调用 XML
      const rawContent = json.choices?.[0]?.message?.content ?? "";
      const parser = new ToolifyParser(triggerSignal, thinkingEnabled);
      for (const char of rawContent) {
        parser.feedChar(char);
      }
      parser.finish();
      const events = parser.consumeEvents();

      const contentBlocks: any[] = [];
      for (const event of events) {
        if (event.type === "text") {
          contentBlocks.push({ type: "text", text: event.content });
        } else if (event.type === "thinking") {
          // 非流式请求中，Anthropic 官方 API 不返回 thinking 块
          // 因此我们不将其放入 contentBlocks
          log("debug", "Excluding thinking block from non-streaming response", { requestId });
        } else if (event.type === "tool_call") {
          contentBlocks.push({
            type: "tool_use",
            id: `toolu_${crypto.randomUUID().split("-")[0]}`,
            name: event.call.name,
            input: event.call.arguments,
          });
        }
      }

      return {
        id: `chatcmpl-${requestId}`,
        type: "message",
        role: "assistant",
        model: requestModel,
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
        stop_reason: contentBlocks.some((b) => b.type === "tool_use")
          ? "tool_use"
          : (json.choices?.[0]?.finish_reason === "stop" ? "end_turn" : json.choices?.[0]?.finish_reason),
        stop_sequence: null,
        usage: {
          input_tokens: json.usage?.prompt_tokens ?? inputTokens,
          output_tokens: json.usage?.completion_tokens ?? 0,
        },
      };
    } else {
      // Anthropic 非流式本身就是 Claude 格式，直接透传
      return json;
    }
  }
}
