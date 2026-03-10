/**
 * AI 璇锋眰涓婁笅鏂囩被
 *
 * 鏍稿績绫伙紝灏佽鎵€鏈?AI 璇锋眰鎵€闇€鐨勫弬鏁帮紝鍦ㄨ姹傚叆鍙ｅ鍒涘缓锛屽叏娴佺▼浼犻€掋€?
 * 璐熻矗锛?
 * 1. 瑙ｆ瀽妯″瀷鍚嶅墠缂€锛坈c+/chat+锛?
 * 2. 瑙ｆ瀽娓犻亾鍚嶏紙channel+model锛?
 * 3. 鏌ユ壘娓犻亾閰嶇疆
 * 4. 搴旂敤閫忎紶閫昏緫
 * 5. 鏋勫缓涓婃父閰嶇疆
 * 6. 澧炲己璇锋眰锛堝伐鍏疯皟鐢ㄦ敞鍏ワ級
 */

import { ClaudeRequest } from "../types.ts";
import { ChannelConfig, ProxyConfig, resolveAutoTrigger } from "../config.ts";
import { ToolCallDelimiter } from "../signals.ts";
import { enrichClaudeRequest } from "../prompt_inject.ts";
import type {
  Protocol,
  RequestContextData,
  RequestFormat,
  ToolCallMode,
  UpstreamConfig,
} from "./types.ts";

export class RequestContext {
  private data: RequestContextData;

  private constructor(data: RequestContextData) {
    this.data = data;
  }

  /**
   * 闈欐€佸伐鍘傛柟娉曪細浠庡師濮嬭姹傚垱寤?RequestContext
   *
   * @param originalRequest 鍘熷 Claude 璇锋眰
   * @param config 浠ｇ悊閰嶇疆
   * @param requestId 璇锋眰 ID
   * @param clientApiKey 瀹㈡埛绔?API 瀵嗛挜锛堢敤浜庨€忎紶锛?
   * @returns RequestContext 瀹炰緥
   */
  static fromRequest(
    originalRequest: ClaudeRequest,
    config: ProxyConfig,
    requestId: string,
    clientApiKey?: string,
  ): RequestContext {
    // 1. 瑙ｆ瀽妯″瀷鍚嶅墠缂€鍜?autoTrigger 閰嶇疆
    const { autoTrigger, actualModelName, channelName } = resolveAutoTrigger(
      originalRequest.model,
      config.channelConfigs,
      config.webTools?.autoTrigger ?? true,
    );

    // 2. 瑙ｆ瀽娓犻亾淇℃伅
    const upstreamConfig = RequestContext.parseChannelInfo(
      actualModelName,
      config,
      clientApiKey,
    );

    // 3. 纭畾宸ュ叿璋冪敤妯″紡
    const toolCallMode: ToolCallMode = upstreamConfig.supportsNativeToolCalling
      ? "native"
      : "prompt_injection";

    // 4. 澧炲己璇锋眰锛堜粎鍦?prompt_injection 妯″紡涓嬫墠娉ㄥ叆宸ュ叿 XML锛?
    let enrichedRequest: ClaudeRequest;
    let delimiter: ToolCallDelimiter | undefined;

    if (toolCallMode === "prompt_injection") {
      const enrichResult = enrichClaudeRequest(originalRequest);
      enrichedRequest = enrichResult.request;
      delimiter = enrichResult.delimiter;
    } else {
      // 鍘熺敓宸ュ叿璋冪敤妯″紡锛屼笉闇€瑕佹敞鍏?XML锛岀洿鎺ヤ娇鐢ㄥ師濮嬭姹?
      enrichedRequest = originalRequest;
      delimiter = undefined;
    }

    // 5. 纭畾璇锋眰鏍煎紡锛堝綋鍓嶄粎鏀寔 anthropic 鏍煎紡锛?
    const requestFormat: RequestFormat = "anthropic";

    // 6. 鏋勫缓涓婁笅鏂囨暟鎹?
    const contextData: RequestContextData = {
      upstreamConfig,
      originalRequest,
      enrichedRequest,
      delimiter,
      config,
      requestId,
      requestFormat,
      toolCallMode,
      clientApiKey,
    };

    return new RequestContext(contextData);
  }

  /**
   * 闈欐€佸伐鍘傛柟娉曪細浠?UpstreamInfo 鍒涘缓 RequestContext锛堢敤浜庡伐鍏锋嫤鎴櫒涓殑杈呭姪 AI 璇锋眰锛?
   *
   * @param upstreamInfo 涓婃父閰嶇疆淇℃伅
   * @param requestId 璇锋眰 ID
   * @returns RequestContext 瀹炰緥
   */
  static fromUpstreamInfo(
    upstreamInfo: { baseUrl: string; apiKey?: string; model: string; protocol: Protocol },
    requestId: string,
  ): RequestContext {
    // 鍒涘缓涓€涓渶灏忓寲鐨?RequestContext 鐢ㄤ簬宸ュ叿鎷︽埅鍣ㄤ腑鐨勮緟鍔?AI 璇锋眰
    const upstreamConfig: UpstreamConfig = {
      baseUrl: upstreamInfo.baseUrl,
      apiKey: upstreamInfo.apiKey,
      model: upstreamInfo.model,
      protocol: upstreamInfo.protocol,
    };

    // 鍒涘缓鏈€灏忓寲鐨勮姹傚璞?
    const minimalRequest: ClaudeRequest = {
      model: upstreamInfo.model,
      max_tokens: 4096,
      messages: [],
    };

    // 鍒涘缓鏈€灏忓寲鐨勯厤缃璞★紙纭繚 defaultProtocol 绫诲瀷姝ｇ‘锛?
    const protocol = upstreamInfo.protocol === "gemini" ? "openai" : upstreamInfo.protocol;
    const minimalConfig: ProxyConfig = {
      upstreamBaseUrl: upstreamInfo.baseUrl,
      upstreamApiKey: upstreamInfo.apiKey,
      upstreamModelOverride: upstreamInfo.model,
      channelConfigs: [],
      defaultProtocol: protocol as "openai" | "openai-responses" | "anthropic",
      port: 0, // 鍗犱綅鍊?
      host: "0.0.0.0",
      requestTimeoutMs: 120000,
      aggregationIntervalMs: 35,
      maxRequestsPerMinute: 10,
      tokenMultiplier: 1.0,
      autoPort: false,
      passthroughApiKey: false,
    };

    const contextData: RequestContextData = {
      upstreamConfig,
      originalRequest: minimalRequest,
      enrichedRequest: minimalRequest,
      config: minimalConfig,
      requestId,
      requestFormat: "anthropic",
      toolCallMode: "prompt_injection",
    };

    return new RequestContext(contextData);
  }

  /**
   * 瑙ｆ瀽娓犻亾淇℃伅
   *
   * 澶勭悊 channel+model 鏍煎紡锛屾煡鎵炬笭閬撻厤缃紝搴旂敤閫忎紶閫昏緫
   *
   * @param modelName 妯″瀷鍚嶏紙宸茬Щ闄?cc+/chat+ 鍓嶇紑锛?
   * @param config 浠ｇ悊閰嶇疆
   * @param clientApiKey 瀹㈡埛绔?API 瀵嗛挜
   * @returns 涓婃父閰嶇疆
   */
  private static parseChannelInfo(
    modelName: string,
    config: ProxyConfig,
    clientApiKey?: string,
  ): UpstreamConfig {
    let baseUrl: string;
    let apiKey: string | undefined;
    let model: string;
    let protocol: Protocol;
    let supportsNativeToolCalling: boolean = false; // 榛樿涓嶆敮鎸佸師鐢熷伐鍏疯皟鐢?
    let supportsSystemPrompt: boolean = true; // 榛樿鏀寔绯荤粺鎻愮ず璇?

    const plusIndex = modelName.indexOf("+");

    if (plusIndex !== -1) {
      // 鏍煎紡锛歝hannel+model
      const channelName = modelName.slice(0, plusIndex);
      const actualModel = modelName.slice(plusIndex + 1);
      const channel = config.channelConfigs.find((c) => c.name === channelName);

      if (channel) {
        baseUrl = channel.baseUrl;
        apiKey = channel.apiKey;
        model = actualModel;
        protocol = (channel.protocol ?? config.defaultProtocol) as Protocol;
        supportsNativeToolCalling = channel.supportsNativeToolCalling ?? false;
        supportsSystemPrompt = channel.supportsSystemPrompt ?? true;
      } else {
        // 娓犻亾鏈壘鍒帮紝浣跨敤榛樿閰嶇疆
        baseUrl = config.upstreamBaseUrl!;
        apiKey = config.upstreamApiKey;
        model = modelName;
        protocol = config.defaultProtocol as Protocol;
        supportsNativeToolCalling = false;
      }
    } else {
      // 娌℃湁 + 鍙凤紝浣跨敤榛樿娓犻亾鎴栧叏灞€閰嶇疆
      if (config.channelConfigs.length > 0) {
        const channel = config.channelConfigs[0];
        baseUrl = channel.baseUrl;
        apiKey = channel.apiKey;
        model = modelName;
        protocol = (channel.protocol ?? config.defaultProtocol) as Protocol;
        supportsNativeToolCalling = channel.supportsNativeToolCalling ?? false;
        supportsSystemPrompt = channel.supportsSystemPrompt ?? true;
      } else {
        baseUrl = config.upstreamBaseUrl!;
        apiKey = config.upstreamApiKey;
        model = config.upstreamModelOverride ?? modelName;
        protocol = config.defaultProtocol as Protocol;
        supportsNativeToolCalling = false;
      }
    }

    // 搴旂敤閫忎紶閫昏緫锛氬鏋滃惎鐢ㄩ€忎紶涓斿鎴风鎻愪緵浜?API key锛屽垯浼樺厛浣跨敤瀹㈡埛绔殑 key
    if (config.passthroughApiKey && clientApiKey) {
      apiKey = clientApiKey;
    }

    return {
      baseUrl,
      apiKey,
      model,
      protocol,
      supportsNativeToolCalling,
      supportsSystemPrompt,
    };
  }

  // ==================== 璁块棶鍣ㄦ柟娉?====================

  /**
   * 鑾峰彇涓婃父閰嶇疆
   */
  getUpstreamConfig(): UpstreamConfig {
    return this.data.upstreamConfig;
  }

  /**
   * 鑾峰彇鍘熷璇锋眰
   */
  getOriginalRequest(): ClaudeRequest {
    return this.data.originalRequest;
  }

  /**
   * 鑾峰彇澧炲己鍚庣殑璇锋眰
   */
  getEnrichedRequest(): ClaudeRequest {
    return this.data.enrichedRequest;
  }

  /**
   * 鑾峰彇宸ュ叿璋冪敤鍒嗛殧绗?
   */
  getDelimiter(): ToolCallDelimiter | undefined {
    return this.data.delimiter;
  }

  /**
   * 鑾峰彇浠ｇ悊閰嶇疆
   */
  getConfig(): ProxyConfig {
    return this.data.config;
  }

  /**
   * 鑾峰彇璇锋眰 ID
   */
  getRequestId(): string {
    return this.data.requestId;
  }

  /**
   * 鑾峰彇璇锋眰鏍煎紡
   */
  getRequestFormat(): RequestFormat {
    return this.data.requestFormat;
  }

  /**
   * 鑾峰彇宸ュ叿璋冪敤妯″紡
   */
  getToolCallMode(): ToolCallMode {
    return this.data.toolCallMode;
  }

  /**
   * 鑾峰彇瀹㈡埛绔?API 瀵嗛挜
   */
  getClientApiKey(): string | undefined {
    return this.data.clientApiKey;
  }

  /**
   * 鑾峰彇娑堟伅鍒楄〃锛堜娇鐢ㄥ寮哄悗鐨勮姹傦級
   */
  getMessages() {
    return this.data.enrichedRequest.messages;
  }

  /**
   * 鑾峰彇妯″瀷鍚嶏紙涓婃父妯″瀷鍚嶏級
   */
  getModel(): string {
    return this.data.upstreamConfig.model;
  }

  /**
   * 鏄惁鍚敤娴佸紡杈撳嚭
   */
  isStreamEnabled(): boolean {
    return this.data.originalRequest.stream === true;
  }

  /**
   * 鍒ゆ柇涓婃父鏄惁鏀寔鍘熺敓宸ュ叿璋冪敤
   *
   * 馃搶 浠庢笭閬撻厤缃腑璇诲彇 supportsNativeToolCalling 瀛楁
   * 馃敭 鏈潵鎵╁睍锛氭牴鎹?protocol 鍜屼笂娓歌兘鍔涘垽鏂?
   */
  supportsNativeToolCall(): boolean {
    return this.data.upstreamConfig.supportsNativeToolCalling ?? false;
  }

  /**
   * 鑾峰彇瀹屾暣鐨勪笂涓嬫枃鏁版嵁锛堢敤浜庤皟璇曪級
   */
  getContextData(): RequestContextData {
    return { ...this.data };
  }
}
