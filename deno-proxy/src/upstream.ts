import { ProxyConfig } from "./config.ts";
import { ClaudeRequest } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { log } from "./logging.ts";
import { enrichClaudeRequest } from "./prompt_inject.ts";
import { mapClaudeToOpenAI } from "./map_claude_to_openai.ts";
import { handleOpenAIStream } from "./handle_openai_stream.ts";
import { handleAnthropicStream } from "./handle_anthropic_stream.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";

export async function forwardRequest(
  request: ClaudeRequest,
  writer: SSEWriter,
  config: ProxyConfig,
  requestId: string,
  clientApiKey?: string,
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

  // 3. 准备转发请求
  let fetchBody: string;
  let finalUrl = baseUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (protocol === "openai") {
    const openaiReq = mapClaudeToOpenAI(enrichedRequest, requestModel);
    fetchBody = JSON.stringify(openaiReq);
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  } else {
    // Anthropic 协议
    const anthropicReq = {
      ...enrichedRequest,
      model: requestModel,
      stream: true,
    };
    fetchBody = JSON.stringify(anthropicReq);
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";
  }

  log("info", `Forwarding request to ${protocol} upstream`, {
    requestId,
    model: requestModel,
    protocol,
    url: finalUrl,
  });

  // 4. 发送请求
  const response = await fetch(finalUrl, {
    method: "POST",
    headers,
    body: fetchBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    log("error", "Upstream request failed", {
      requestId,
      status: response.status,
      error: errorText,
    });
    throw new Error(`Upstream returned ${response.status}: ${errorText}`);
  }

  // 5. 处理流式响应
  const thinkingEnabled = request.thinking?.type === "enabled";
  const inputTokens = countTokensWithTiktoken(fetchBody, "cl100k_base");

  if (protocol === "openai") {
    await handleOpenAIStream(
      response,
      writer,
      config,
      requestId,
      triggerSignal,
      thinkingEnabled,
      inputTokens
    );
  } else {
    await handleAnthropicStream(
      response,
      writer,
      config,
      requestId,
      triggerSignal,
      thinkingEnabled,
      inputTokens
    );
  }
}
