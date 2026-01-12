import { ProxyConfig, resolveAutoTrigger } from "./config.ts";
import { ClaudeRequest } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { log, logPhase, LogPhase } from "./logging.ts";
import { enrichClaudeRequest } from "./prompt_inject.ts";
import { mapClaudeToOpenAI } from "./map_claude_to_openai.ts";
import { handleOpenAIStream } from "./handle_openai_stream.ts";
import { handleAnthropicStream } from "./handle_anthropic_stream.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";
import { ToolifyParser } from "./parser.ts";
import { countTokensLocally } from "./token_counter.ts";
import { ToolCallDelimiter } from "./signals.ts";

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

  // 先解析模型名前缀（移除 cc+/chat+ 前缀）
  const { actualModelName } = resolveAutoTrigger(
    request.model,
    config.channelConfigs,
    config.webTools?.autoTrigger ?? true
  );

  // 解析模型名：支持 "channel+model" 格式（使用去除前缀后的模型名）
  const modelName = actualModelName;
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
  const { request: enrichedRequest, delimiter } = enrichClaudeRequest(request);
  
  if (delimiter && request.tools && request.tools.length > 0) {
    logPhase(requestId, LogPhase.ENRICHED, `Injected ${request.tools.length} tools`, {
      delimiter: delimiter.getMarkers().TC_START,
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
  
  // 使用增强后的本地计数器计算输入 Token
  const localUsage = await countTokensLocally(enrichedRequest, config, requestId);
  const inputTokens = localUsage.input_tokens;

  if (isStream && writer) {
    if (protocol === "openai") {
      const result = await handleOpenAIStream(
        response,
        writer,
        config,
        requestId,
        delimiter,
        thinkingEnabled,
        inputTokens,
        enrichedRequest, // 🔑 传递增强后的请求对象（包含正确的 messages 和参数）
        finalUrl, // 🔑 传递上游 URL
        headers, // 🔑 传递请求头
        protocol, // 🔑 传递协议类型
        clientApiKey, // 🔑 传递客户端 API Key
      );
      return { inputTokens, outputTokens: result?.outputTokens };
    } else {
      const result = await handleAnthropicStream(
        response,
        writer,
        config,
        requestId,
        delimiter,
        thinkingEnabled,
        inputTokens,
        enrichedRequest, // 🔑 传递增强后的请求对象
        finalUrl, // 🔑 传递上游 URL
        headers, // 🔑 传递请求头
        protocol, // 🔑 传递协议类型
        clientApiKey, // 🔑 传递客户端 API Key
      );
      return { inputTokens, outputTokens: result?.outputTokens };
    }
  } else {
    // 非流式响应处理
    const json = await response.json();
    if (protocol === "openai") {
      // 将 OpenAI 非流式响应转换为 Claude 格式
      const message = json.choices?.[0]?.message;
      const rawContent = message?.content ?? "";
      const reasoningContent = message?.reasoning_content ?? "";
      const parser = new ToolifyParser(delimiter, thinkingEnabled);

      // 优先处理原生推理内容
      if (reasoningContent) {
        parser.feedReasoning(reasoningContent);
      }

      for (const char of rawContent) {
        parser.feedChar(char);
      }

      parser.finish();
      const events = parser.consumeEvents();

      const contentBlocks: any[] = [];
      let outputBuffer = "";
      for (const event of events) {
        if (event.type === "text") {
          contentBlocks.push({ type: "text", text: event.content });
          outputBuffer += event.content;
        } else if (event.type === "thinking") {
          // 在非流式响应中也返回思考块,保持与 Anthropic API 标准一致
          contentBlocks.push({ type: "thinking", thinking: event.content });
          outputBuffer += event.content;
        } else if (event.type === "tool_call") {
          contentBlocks.push({
            type: "tool_use",
            id: `toolu_${crypto.randomUUID().split("-")[0]}`,
            name: event.call.name,
            input: event.call.arguments,
          });
          outputBuffer += JSON.stringify(event.call.arguments);
        } else if (event.type === "tool_call_failed") {
          // 工具调用失败时，将原始内容作为文本返回，并添加提示
          const failedText = event.rawContent || "";
          const note = "Model did not use tool, may not support or chose not to use";
          const fullText = failedText ? `${failedText}\n\n[${note}]` : `[${note}]`;
          contentBlocks.push({
            type: "text",
            text: fullText
          });
          outputBuffer += fullText;
        }
      }

      // 精确重新计算输出 Token
      const outputTokens = countTokensWithTiktoken(outputBuffer, request.model);

      return {
        id: `chatcmpl-${requestId}`,
        type: "message",
        role: "assistant",
        model: request.model, // 确保返回原始模型名
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
        stop_reason: contentBlocks.some((b) => b.type === "tool_use")
          ? "tool_use"
          : (json.choices?.[0]?.finish_reason === "stop" ? "end_turn" : json.choices?.[0]?.finish_reason),
        stop_sequence: null,
        usage: {
          input_tokens: json.usage?.prompt_tokens ?? inputTokens,
          output_tokens: outputTokens || (json.usage?.completion_tokens ?? 0),
        },
      };
    } else {
      // Anthropic 非流式
      // 需要解析 content 中的工具调用分隔符
      const message = json;

      // 如果没有 content 或 content 为空，直接返回
      if (!message.content || !Array.isArray(message.content) || message.content.length === 0) {
        if (json && typeof json === 'object') {
          json.model = request.model;
        }
        return json;
      }

      const parser = new ToolifyParser(delimiter, thinkingEnabled);
      const contentBlocks: any[] = [];
      let outputBuffer = "";

      // 处理每个 content block
      for (const block of message.content) {
        if (block.type === "text") {
          // 解析文本中的工具调用分隔符
          for (const char of block.text) {
            parser.feedChar(char);
          }
        } else {
          // 非文本块直接保留（如原生 tool_use）
          contentBlocks.push(block);
        }
      }

      parser.finish();
      const events = parser.consumeEvents();

      // 处理解析出的事件
      for (const event of events) {
        if (event.type === "text") {
          contentBlocks.push({ type: "text", text: event.content });
          outputBuffer += event.content;
        } else if (event.type === "thinking") {
          contentBlocks.push({ type: "thinking", thinking: event.content });
          outputBuffer += event.content;
        } else if (event.type === "tool_call") {
          contentBlocks.push({
            type: "tool_use",
            id: `toolu_${crypto.randomUUID().split("-")[0]}`,
            name: event.call.name,
            input: event.call.arguments,
          });
          outputBuffer += JSON.stringify(event.call.arguments);
        } else if (event.type === "tool_call_failed") {
          // 工具调用失败时，将原始内容作为文本返回，并添加提示
          const failedText = event.rawContent || "";
          const note = "Model did not use tool, may not support or chose not to use";
          const fullText = failedText ? `${failedText}\n\n[${note}]` : `[${note}]`;
          contentBlocks.push({
            type: "text",
            text: fullText
          });
          outputBuffer += fullText;
        }
      }

      // 精确重新计算输出 Token
      const outputTokens = countTokensWithTiktoken(outputBuffer, request.model);

      return {
        id: message.id || `msg-${requestId}`,
        type: "message",
        role: "assistant",
        model: request.model, // 确保返回原始模型名
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
        stop_reason: contentBlocks.some((b) => b.type === "tool_use")
          ? "tool_use"
          : (message.stop_reason || "end_turn"),
        stop_sequence: message.stop_sequence || null,
        usage: {
          input_tokens: message.usage?.input_tokens ?? inputTokens,
          output_tokens: outputTokens || (message.usage?.output_tokens ?? 0),
        },
      };
    }
  }
}
