import { FirecrawlClient } from "./firecrawl_client.ts";
import { FormatConverter } from "./format_converter.ts";
import { isAnyWebFetchTool, isAnyWebSearchTool } from "./types.ts";
import type {
  AnthropicServerToolUse,
  AnthropicWebFetchToolDefinition,
  AnthropicWebFetchToolResult,
  AnthropicWebSearchToolDefinition,
  AnthropicWebSearchToolResult,
  FetchInterceptResult,
  FirecrawlConfig,
  SearchInterceptResult,
  SmartSearchInterceptResult,
  UpstreamInfo,
  WebToolsConfig,
} from "./types.ts";
import type { ClaudeContentBlock, ClaudeMessage, ClaudeTextBlock } from "../types.ts";
import { log, LogPhase, logRequest } from "../logging.ts";
import { AIClient, ContextBuilder, RequestContext } from "../ai_client/mod.ts";

/**
 * 宸ュ叿鎷︽埅鍣? * 妫€娴嬪苟鎷︽埅 Web Search 鍜?Web Fetch 宸ュ叿璋冪敤
 */
export class ToolInterceptor {
  private firecrawlClient: FirecrawlClient;
  private webToolsConfig: WebToolsConfig;

  constructor(
    firecrawlConfig: FirecrawlConfig,
    webToolsConfig: WebToolsConfig,
  ) {
    this.firecrawlClient = new FirecrawlClient(firecrawlConfig);
    this.webToolsConfig = webToolsConfig;
  }

  isSmartSearchMode(): boolean {
    return this.webToolsConfig.searchMode === "smart";
  }

  /**
   * 妫€鏌ヨ姹傛槸鍚﹂渶瑕佹嫤鎴?   */
  static shouldIntercept(
    tools: unknown[] | undefined,
    webToolsConfig: WebToolsConfig | undefined,
  ): boolean {
    if (!tools || !webToolsConfig) {
      return false;
    }

    const hasWebSearch = tools.some(
      (tool: unknown) => isAnyWebSearchTool(tool),
    );

    const hasWebFetch = tools.some(
      (tool: unknown) => isAnyWebFetchTool(tool),
    );

    return (
      (hasWebSearch && webToolsConfig.enableSearchIntercept) ||
      (hasWebFetch && webToolsConfig.enableFetchIntercept)
    );
  }

  /**
   * 澶勭悊 Web Search 鎷︽埅锛堢畝鍗曟ā寮?- 浣跨敤宸叉彁渚涚殑 query锛?   */
  async handleWebSearchWithQuery(
    tool: AnthropicWebSearchToolDefinition,
    query: string,
    requestId: string,
  ): Promise<SearchInterceptResult> {
    // 璋冪敤 Firecrawl Search API
    const searchParams = {
      query,
      limit: this.webToolsConfig.maxSearchResults,
      location: tool.user_location,
      scrape_options: {
        formats: ["markdown"],
      },
    };

    const firecrawlResponse = await this.firecrawlClient.search(searchParams);

    logRequest(requestId, "info", `Firecrawl search completed`, {
      query,
      resultsCount: firecrawlResponse.data.web.length,
      creditsUsed: firecrawlResponse.credits_used,
    }, LogPhase.WEB_SEARCH);

    // Filter by allowed domains if specified
    if (tool.allowed_domains && tool.allowed_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        tool.allowed_domains!.some((domain) => result.url.includes(domain))
      );
      logRequest(requestId, "info", `Filtered by allowed_domains`, {
        remainingCount: firecrawlResponse.data.web.length,
        allowedDomains: tool.allowed_domains,
      }, LogPhase.WEB_SEARCH);
    }

    if (tool.blocked_domains && tool.blocked_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        !tool.blocked_domains!.some((domain) => result.url.includes(domain))
      );
      logRequest(requestId, "info", `Filtered by blocked_domains`, {
        remainingCount: firecrawlResponse.data.web.length,
        blockedDomains: tool.blocked_domains,
      }, LogPhase.WEB_SEARCH);
    }

    // 鐢熸垚鍞竴鐨?tool use id (浣跨敤 server_tool_use 鐨?srvtoolu_ 鍓嶇紑)
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").substring(0, 22)}`;

    // 杞崲涓?Anthropic 鏍煎紡
    const toolResult = FormatConverter.convertSearchResult(
      firecrawlResponse,
      toolUseId,
    );

    logRequest(requestId, "info", `Search result converted`, {
      toolUseId,
      contentCount: toolResult.content.length,
      sampleResult: toolResult.content[0]
        ? {
          url: toolResult.content[0].url.substring(0, 50),
          title: toolResult.content[0].title.substring(0, 50),
          hasEncrypted: !!toolResult.content[0].encrypted_content,
        }
        : null,
    }, LogPhase.FORMAT);

    // 鏋勫缓 server_tool_use
    const serverToolUse: AnthropicServerToolUse = {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: {
        query,
      },
    };

    return {
      serverToolUse,
      toolResult,
    };
  }

  /**
   * 澶勭悊 Web Search 鎷︽埅锛堢畝鍗曟ā寮忥級
   */
  async handleWebSearch(
    tool: AnthropicWebSearchToolDefinition,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): Promise<SearchInterceptResult> {
    // 浣跨敤 AI 鐢熸垚绮剧‘鐨勬悳绱㈣瘝
    const query = await this.extractSearchQuery(messages, upstreamInfo, requestId);

    // 璋冪敤 Firecrawl Search API
    const searchParams = {
      query,
      limit: this.webToolsConfig.maxSearchResults,
      location: tool.user_location,
      scrape_options: {
        formats: ["markdown"],
      },
    };

    const firecrawlResponse = await this.firecrawlClient.search(searchParams);

    log("info", `馃攷 Firecrawl search completed`, {
      requestId,
      query,
      resultsCount: firecrawlResponse.data.web.length,
      creditsUsed: firecrawlResponse.credits_used,
    });

    // Filter by allowed domains if specified
    if (tool.allowed_domains && tool.allowed_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        tool.allowed_domains!.some((domain) => result.url.includes(domain))
      );
      log("info", `馃攳 Filtered by allowed_domains`, {
        requestId,
        remainingCount: firecrawlResponse.data.web.length,
        allowedDomains: tool.allowed_domains,
      });
    }

    if (tool.blocked_domains && tool.blocked_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        !tool.blocked_domains!.some((domain) => result.url.includes(domain))
      );
      log("info", `馃毇 Filtered by blocked_domains`, {
        requestId,
        remainingCount: firecrawlResponse.data.web.length,
        blockedDomains: tool.blocked_domains,
      });
    }

    // 鐢熸垚鍞竴鐨?tool use id (浣跨敤 server_tool_use 鐨?srvtoolu_ 鍓嶇紑)
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").substring(0, 22)}`;

    // 杞崲涓?Anthropic 鏍煎紡
    const toolResult = FormatConverter.convertSearchResult(
      firecrawlResponse,
      toolUseId,
    );

    log("info", `馃摝 Search result converted to Anthropic format`, {
      requestId,
      toolUseId,
      contentCount: toolResult.content.length,
      sampleResult: toolResult.content[0]
        ? {
          url: toolResult.content[0].url.substring(0, 50),
          title: toolResult.content[0].title.substring(0, 50),
          hasEncrypted: !!toolResult.content[0].encrypted_content,
        }
        : null,
    });

    // 鏋勫缓 server_tool_use
    const serverToolUse: AnthropicServerToolUse = {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: {
        query,
      },
    };

    return {
      serverToolUse,
      toolResult,
    };
  }

  /**
   * 澶勭悊 Web Search 鎷︽埅锛堟櫤鑳芥ā寮?- 娴佸紡鐗堟湰锛?   * 鎺ユ敹宸叉湁鐨勬悳绱㈢粨鏋滐紝娴佸紡璋冪敤涓婃父 LLM 杩涜鍒嗘瀽
   * 濡傛灉鍚敤娣卞叆娴忚锛屼細杩涗竴姝ユ姄鍙栨帹鑽愰〉闈㈠苟杩涜鏈€缁堟€荤粨
   *
   * @param searchResult - 宸茶幏鍙栫殑鎼滅储缁撴灉
   * @param onStreamChunk - 鎺ユ敹鏂囨湰澧為噺鐨勫洖璋冨嚱鏁?   */
  async doStreamAnalysis(
    tool: AnthropicWebSearchToolDefinition,
    searchResult: SearchInterceptResult,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
    keepAliveCallback?: () => void,
  ): Promise<void> {
    // 鏋勫缓鎼滅储缁撴灉鐨勬枃鏈憳瑕
    const searchSummary = this.buildSearchSummary(searchResult.toolResult);

    // 鍒ゆ柇鏄惁鍚敤娣卞叆娴忚
    const deepBrowseEnabled = this.webToolsConfig.deepBrowseEnabled;
    const deepBrowseCount = this.webToolsConfig.deepBrowseCount;

    log("info", `馃 Starting streaming analysis`, {
      requestId,
      deepBrowseEnabled,
      deepBrowseCount,
      deepBrowseCountType: typeof deepBrowseCount,
      configObject: {
        deepBrowseEnabled: this.webToolsConfig.deepBrowseEnabled,
        deepBrowseCount: this.webToolsConfig.deepBrowseCount,
      },
    });

    if (!deepBrowseEnabled) {
      // 鏅€氭ā寮忥細鐩存帴娴佸紡杈撳嚭鍒嗘瀽
      await this.streamUpstreamAnalysis(
        messages,
        searchResult.serverToolUse.input.query!,
        searchSummary,
        upstreamInfo,
        requestId,
        onStreamChunk,
      );
    } else {
      // 娣卞叆娴忚妯″紡锛氬厛鑾峰彇閾炬帴鍒楄〃锛屽啀鎶撳彇锛屾渶鍚庢祦寮忚緭鍑烘渶缁堝垎鏋
      const linksList = await this.getDeepBrowseLinks(
        messages,
        searchResult.serverToolUse.input.query!,
        searchSummary,
        upstreamInfo,
        requestId,
        deepBrowseCount,
      );

      if (linksList.length === 0) {
        // 濡傛灉娌℃湁鎺ㄨ崘閾炬帴锛岀洿鎺ユ祦寮忚緭鍑烘櫘閫氬垎鏋
        await this.streamUpstreamAnalysis(
          messages,
          searchResult.serverToolUse.input.query!,
          searchSummary,
          upstreamInfo,
          requestId,
          onStreamChunk,
        );
        return;
      }

      // 闄愬埗娴忚鏁伴噺 - 寮哄埗浣跨敤 Math.min 纭繚涓嶈秴杩囬厤缃€
      const linksToFetch = linksList.slice(0, Math.min(linksList.length, deepBrowseCount));

      log("info", `馃敆 Fetching deep browse pages`, {
        requestId,
        originalLinksCount: linksList.length,
        requestedCount: deepBrowseCount,
        actualFetchCount: linksToFetch.length,
        links: linksToFetch.map((l) => l.substring(0, 100)),
      });

      // 骞跺彂鎶撳彇鎺ㄨ崘鐨勯〉闈
      const browseResults = await this.fetchMultiplePages(
        linksToFetch,
        requestId,
        keepAliveCallback,
      );

      log("info", `馃摎 Browse results obtained`, {
        requestId,
        resultsCount: browseResults.length,
        contentLengths: browseResults.map((r) => r.content.length),
      });

      // 鏋勫缓鏈€缁堝垎鏋愭彁绀鸿瘝
      const finalPrompt = this.buildFinalAnalysisPrompt(
        searchResult.serverToolUse.input.query!,
        searchSummary,
        "", // 涓嶉渶瑕佸垵姝ュ垎鏋
        browseResults,
      );

      log("info", `馃摑 Final analysis prompt built`, {
        requestId,
        promptLength: finalPrompt.length,
        promptPreview: finalPrompt.substring(0, 200),
      });

      // 娴佸紡杈撳嚭鏈€缁堝垎鏋
      await this.streamFinalAnalysis(
        messages,
        finalPrompt,
        upstreamInfo,
        requestId,
        onStreamChunk,
      );
    }
  }

  /**
   * 澶勭悊 Web Search 鎷︽埅锛堟櫤鑳芥ā寮忥級
   * 鍏堣皟鐢?Firecrawl 鑾峰彇鎼滅储缁撴灉锛屽啀璋冪敤涓婃父 LLM 杩涜鍒嗘瀽
   * 濡傛灉鍚敤娣卞叆娴忚锛屼細杩涗竴姝ユ姄鍙栨帹鑽愰〉闈㈠苟杩涜鏈€缁堟€荤粨
   */
  async handleSmartWebSearch(
    tool: AnthropicWebSearchToolDefinition,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    keepAliveCallback?: () => void,
  ): Promise<SmartSearchInterceptResult> {
    // 1. 鍏堣幏鍙栨悳绱㈢粨鏋滐紙浣跨敤绠€鍗曟ā寮忕殑閫昏緫锛屽凡鍖呭惈 AI 鐢熸垚鎼滅储璇嶏級
    const simpleResult = await this.handleWebSearch(tool, messages, upstreamInfo, requestId);

    return await this.handleSmartWebSearchFromSimpleResult(
      simpleResult,
      messages,
      upstreamInfo,
      requestId,
      keepAliveCallback,
    );
  }

  async handleSmartWebSearchWithQuery(
    tool: AnthropicWebSearchToolDefinition,
    query: string,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    keepAliveCallback?: () => void,
  ): Promise<SmartSearchInterceptResult> {
    const simpleResult = await this.handleWebSearchWithQuery(tool, query, requestId);

    return await this.handleSmartWebSearchFromSimpleResult(
      simpleResult,
      messages,
      upstreamInfo,
      requestId,
      keepAliveCallback,
    );
  }

  private async handleSmartWebSearchFromSimpleResult(
    simpleResult: SearchInterceptResult,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    keepAliveCallback?: () => void,
  ): Promise<SmartSearchInterceptResult> {

    // 2. 鏋勫缓鎼滅储缁撴灉鐨勬枃鏈憳瑕
    const searchSummary = this.buildSearchSummary(simpleResult.toolResult);

    // 3. 璋冪敤涓婃父 LLM 杩涜鍒濇鍒嗘瀽
    const deepBrowseEnabled = this.webToolsConfig.deepBrowseEnabled;
    const deepBrowseCount = this.webToolsConfig.deepBrowseCount;

    log("info", `馃 Starting initial analysis`, {
      requestId,
      deepBrowseEnabled,
      deepBrowseCount,
    });

    const initialAnalysisText = await this.callUpstreamForInitialAnalysis(
      messages,
      simpleResult.serverToolUse.input.query!,
      searchSummary,
      upstreamInfo,
      requestId,
      deepBrowseEnabled,
      deepBrowseCount,
    );

    // 4. 濡傛灉鏈惎鐢ㄦ繁鍏ユ祻瑙堬紝鐩存帴杩斿洖鍒濇鍒嗘瀽锛堢Щ闄ゆ爣璁帮級
    if (!deepBrowseEnabled) {
      const cleanedText = this.removeDeepBrowseMarkers(initialAnalysisText);

      log("info", `鉁?Returning simple analysis (deep browse disabled)`, {
        requestId,
        analysisLength: cleanedText.length,
      });

      return {
        serverToolUse: simpleResult.serverToolUse,
        llmAnalysis: {
          type: "text",
          text: cleanedText,
        },
        toolResult: simpleResult.toolResult,
      };
    }

    // 5. 鎻愬彇 AI 鎺ㄨ崘鐨勬繁鍏ユ祻瑙堥摼鎺
    const deepBrowseLinks = this.extractDeepBrowseLinks(initialAnalysisText);

    log("info", `馃敆 Extracted deep browse links`, {
      requestId,
      linksCount: deepBrowseLinks.length,
      links: deepBrowseLinks.map((l) => l.substring(0, 100)),
    });

    // If no recommended links, return initial analysis (remove markers)
    if (deepBrowseLinks.length === 0) {
      const cleanedText = this.removeDeepBrowseMarkers(initialAnalysisText);

      log("info", `鉁?No links to browse, returning initial analysis`, {
        requestId,
      });

      return {
        serverToolUse: simpleResult.serverToolUse,
        llmAnalysis: {
          type: "text",
          text: cleanedText,
        },
        toolResult: simpleResult.toolResult,
      };
    }

    // 6. 闄愬埗娴忚鏁伴噺 - 寮哄埗浣跨敤 Math.min 纭繚涓嶈秴杩囬厤缃€
    const linksToFetch = deepBrowseLinks.slice(
      0,
      Math.min(deepBrowseLinks.length, deepBrowseCount),
    );

    log("info", `馃敆 Deep browse links after limiting`, {
      requestId,
      originalCount: deepBrowseLinks.length,
      requestedCount: deepBrowseCount,
      actualCount: linksToFetch.length,
    });

    // 7. 骞跺彂鎶撳彇鎺ㄨ崘鐨勯〉闈紙浼犲叆 keepAlive 鍥炶皟锛
    const browseResults = await this.fetchMultiplePages(linksToFetch, requestId, keepAliveCallback);

    // 8. 绉婚櫎鏍囪鍚庣殑鍒濇鍒嗘瀽
    const cleanedInitialAnalysis = this.removeDeepBrowseMarkers(initialAnalysisText);

    // 9. 鏋勫缓鏈€缁堝垎鏋愭彁绀鸿瘝
    const finalPrompt = this.buildFinalAnalysisPrompt(
      simpleResult.serverToolUse.input.query!,
      searchSummary,
      cleanedInitialAnalysis,
      browseResults,
    );

    // 10. 璋冪敤涓婃父 LLM 杩涜鏈€缁堟€荤粨
    log("info", `馃 Calling upstream for final analysis`, {
      requestId,
      browseResultsCount: browseResults.length,
    });

    const finalAnalysisText = await this.callUpstreamForFinalAnalysis(
      messages,
      finalPrompt,
      upstreamInfo,
      requestId,
    );

    log("info", `鉁?Final analysis completed`, {
      requestId,
      analysisLength: finalAnalysisText.length,
    });

    // 11. 杩斿洖鏅鸿兘妯″紡缁撴灉锛歀LM 鏈€缁堝垎鏋?+ 鎼滅储缁撴灉
    return {
      serverToolUse: simpleResult.serverToolUse,
      llmAnalysis: {
        type: "text",
        text: finalAnalysisText,
      },
      toolResult: simpleResult.toolResult,
    };
  }

  /**
   * 澶勭悊 Web Fetch 鎷︽埅锛堢畝鍗曟ā寮忥級
   */
  async handleWebFetch(
    tool: AnthropicWebFetchToolDefinition,
    url: string,
    requestId: string,
  ): Promise<FetchInterceptResult> {
    log("info", "馃摜 Starting Firecrawl scrape", {
      requestId,
      url: url.substring(0, 100),
    });

    // 璋冪敤 Firecrawl Scrape API
    const scrapeParams = {
      url,
      formats: ["markdown"],
    };

    const firecrawlResponse = await this.firecrawlClient.scrape(scrapeParams);

    log("info", "鉁?Firecrawl scrape completed", {
      requestId,
      url: url.substring(0, 100),
      contentLength: firecrawlResponse.data.markdown?.length || 0,
      creditsUsed: firecrawlResponse.credits_used,
    });

    // 鐢熸垚鍞竴鐨?tool use id (浣跨敤 server_tool_use 鐨?srvtoolu_ 鍓嶇紑)
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").substring(0, 22)}`;

    // 杞崲涓?Anthropic 鏍煎紡
    const toolResult = FormatConverter.convertScrapeResult(
      firecrawlResponse,
      toolUseId,
      url,
    );

    // 鏋勫缓 server_tool_use
    const serverToolUse: AnthropicServerToolUse = {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_fetch",
      input: {
        url,
      },
    };

    return {
      serverToolUse,
      toolResult,
    };
  }

  /**
   * 浠?UpstreamInfo 鍒涘缓涓存椂 RequestContext 鐢ㄤ簬杈呭姪 AI 璇锋眰
   */
  private createContextFromUpstreamInfo(
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): RequestContext {
    return RequestContext.fromUpstreamInfo(upstreamInfo, requestId);
  }

  /**
   * 浠庢秷鎭腑鎻愬彇鎼滅储鏌ヨ
   * 浣跨敤涓婃父 AI 鐢熸垚绮剧‘鐨勬悳绱㈣瘝
   */
  private async extractSearchQuery(
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): Promise<string> {
    // 鑾峰彇鏈€鍚庝竴鏉＄敤鎴锋秷鎭
    const lastUserMessage = [...messages]
      .reverse()
      .find((msg) => msg.role === "user");

    if (!lastUserMessage) {
      return "";
    }

    // 鎻愬彇鏂囨湰鍐呭
    let userQuestion = "";
    if (typeof lastUserMessage.content === "string") {
      userQuestion = lastUserMessage.content;
    } else if (Array.isArray(lastUserMessage.content)) {
      const textBlocks = lastUserMessage.content.filter((block) =>
        "type" in block && block.type === "text"
      );
      userQuestion = textBlocks.map((block) => "text" in block ? block.text : "").join(
        " ",
      );
    }

    if (!userQuestion) {
      return "";
    }

    log("info", "馃 Generating search query with AI", {
      requestId,
      userQuestion: userQuestion.substring(0, 100) + (userQuestion.length > 100 ? "..." : ""),
      model: upstreamInfo.model,
    });

    // 浣跨敤涓婃父 AI 鐢熸垚鎼滅储璇
    const queryPrompt =
      `Based on the following user question, generate a concise and precise search query (maximum 200 characters) that would be effective for a web search engine. Return ONLY the search query, without any explanations or additional text.

User question: ${userQuestion}

Search query:`;

    // 鏋勫缓璇锋眰娑堟伅
    const queryMessages: ClaudeMessage[] = [
      {
        role: "user",
        content: queryPrompt,
      },
    ];

    // 浣跨敤 AIClient 鍙戦€佽姹
    try {
      const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
      const client = new AIClient(context);

      const response = await client.request(queryMessages, {
        max_tokens: 100,
        temperature: 0.3,
      });

      // 鎻愬彇鐢熸垚鐨勬悳绱㈣瘝
      let generatedQuery = typeof response.content === "string" ? response.content.trim() : "";

      // 闄愬埗闀垮害涓?200 瀛楃
      if (generatedQuery.length > 200) {
        generatedQuery = generatedQuery.substring(0, 200);
      }

      log("info", "鉁?Search query generated", {
        requestId,
        generatedQuery,
        queryLength: generatedQuery.length,
      });

      return generatedQuery || this.fallbackExtractQuery(userQuestion);
    } catch (error) {
      log("warn", "Search query generation error, using fallback", {
        requestId,
        error: String(error),
      });
      return this.fallbackExtractQuery(userQuestion);
    }
  }

  /**
   * 鍚庡鏂规锛氱畝鍗曠殑鍏抽敭璇嶆彁鍙栵紙褰?AI 璋冪敤澶辫触鏃朵娇鐢級
   */
  private fallbackExtractQuery(text: string): string {
    // 绠€鍗曠殑鍏抽敭璇嶆彁鍙栵細绉婚櫎甯歌鐨勫仠鐢ㄨ瘝
    const stopWords = [
      "what",
      "is",
      "are",
      "how",
      "why",
      "when",
      "where",
      "who",
      "the",
      "a",
      "an",
      "can",
      "you",
      "please",
      "tell",
      "me",
      "about",
    ];

    const words = text.toLowerCase().split(/\s+/);
    const keywords = words.filter((word) => !stopWords.includes(word));

    // 闄愬埗闀垮害涓?200 瀛楃
    let query = keywords.join(" ");
    if (query.length > 200) {
      query = query.substring(0, 200);
    }

    return query || text.substring(0, 200);
  }

  /**
   * 鏋勫缓鎼滅储缁撴灉鎽樿锛堢敤浜?LLM 鍒嗘瀽锛?   */
  private buildSearchSummary(toolResult: AnthropicWebSearchToolResult): string {
    const results = toolResult.content;
    if (results.length === 0) {
      return "No search results found.";
    }

    let summary = `Found ${results.length} search results:\n\n`;
    results.forEach((result, index) => {
      summary += `${index + 1}. ${result.title}\n`;
      summary += `   URL: ${result.url}\n`;
      // 瑙ｇ爜 encrypted_content 鑾峰彇棰勮锛堝鏋滃彲鑳斤級
      try {
        const decoded = atob(result.encrypted_content);
        const data = JSON.parse(decoded);
        if (data.preview) {
          summary += `   Preview: ${data.preview}\n`;
        }
      } catch {
        // 蹇界暐瑙ｇ爜閿欒
      }
      summary += `\n`;
    });

    return summary;
  }

  /**
   * 璋冪敤涓婃父 API 杩涜鍒濇鍒嗘瀽锛堝彲鑳藉寘鍚繁鍏ユ祻瑙堥摼鎺ユ爣璁帮級
   */
  private async callUpstreamForInitialAnalysis(
    originalMessages: ClaudeMessage[],
    query: string,
    contentSummary: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    deepBrowseEnabled: boolean,
    deepBrowseCount: number,
  ): Promise<string> {
    log("info", `馃 Calling upstream for initial search analysis`, {
      requestId,
      query: query.substring(0, 100),
      model: upstreamInfo.model,
      summaryLength: contentSummary.length,
      deepBrowseEnabled,
    });

    // 鏋勫缓鍒嗘瀽鎻愮ず璇
    let analysisPrompt: string;

    if (deepBrowseEnabled) {
      // 娣卞叆娴忚妯″紡锛氬彧杈撳嚭鏈変环鍊肩殑閾炬帴鍒楄〃
      analysisPrompt =
        `Based on the following search results for the query "${query}", please select ${deepBrowseCount} most valuable pages that would provide detailed and authoritative information.

${contentSummary}

Please list ONLY the URLs in this format (no additional text):

[DEEP_BROWSE_LINKS]
https://example.com/page1
https://example.com/page2
https://example.com/page3
[/DEEP_BROWSE_LINKS]

The URLs must be from the search results above.
IMPORTANT: Do NOT call web_search again. The search has already been performed above.`;
    } else {
      // 鏅€氭ā寮忥細姝ｅ父鎬荤粨
      analysisPrompt =
        `Based on the following search results for the query "${query}", please provide a comprehensive analysis and answer:\n\n${contentSummary}\n\nProvide a detailed, well-structured response that synthesizes the information from these search results.
IMPORTANT: Do NOT call web_search again. The search has already been performed above.`;
    }

    // 鎻愬彇鐢ㄦ埛鍘熷闂

    // 鏋勫缓娓呯悊鍚庣殑娑堟伅鍒楄〃锛堢Щ闄ゅ伐鍏峰畾涔夛級
    const cleanMessages = this.buildCleanMessages(originalMessages, analysisPrompt);

    // 浣跨敤 AIClient 鍙戦€佽姹
    const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
    const client = new AIClient(context);

    const response = await client.request(cleanMessages, {
      max_tokens: 4096,
    });

    const analysisText = typeof response.content === "string"
      ? response.content
      : "No analysis generated.";

    log("info", `鉁?Initial analysis completed`, {
      requestId,
      analysisLength: analysisText.length,
      hasContent: analysisText !== "No analysis generated.",
    });

    return analysisText;
  }

  /**
   * 璋冪敤涓婃父 API 杩涜鏈€缁堝垎鏋愶紙鍩轰簬娣卞叆娴忚缁撴灉锛?   */
  private async callUpstreamForFinalAnalysis(
    originalMessages: ClaudeMessage[],
    finalPrompt: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): Promise<string> {
    // 鎻愬彇鐢ㄦ埛鍘熷闂

    // 鏋勫缓娓呯悊鍚庣殑娑堟伅鍒楄〃锛堢Щ闄ゅ伐鍏峰畾涔夛級
    const cleanMessages = this.buildCleanMessages(originalMessages, finalPrompt);

    // 浣跨敤 AIClient 鍙戦€佽姹
    const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
    const client = new AIClient(context);

    const response = await client.request(cleanMessages, {
      max_tokens: 4096,
    });

    return typeof response.content === "string" ? response.content : "No analysis generated.";
  }

  /**
   * 浠?AI 鍒嗘瀽鏂囨湰涓彁鍙栨繁鍏ユ祻瑙堥摼鎺?   */
  private extractDeepBrowseLinks(analysisText: string): string[] {
    const regex = /\[DEEP_BROWSE_LINKS\]([\s\S]*?)\[\/DEEP_BROWSE_LINKS\]/;
    const match = analysisText.match(regex);

    if (!match) {
      return [];
    }

    const linksSection = match[1];
    const urlRegex = /https?:\/\/[^\s]+/g;
    const urls = linksSection.match(urlRegex) || [];

    return urls;
  }

  /**
   * 绉婚櫎鏂囨湰涓殑娣卞叆娴忚閾炬帴鏍囪
   */
  private removeDeepBrowseMarkers(analysisText: string): string {
    return analysisText.replace(/\[DEEP_BROWSE_LINKS\][\s\S]*?\[\/DEEP_BROWSE_LINKS\]/g, "").trim();
  }

  /**
   * 骞跺彂鎶撳彇澶氫釜椤甸潰
   */
  private async fetchMultiplePages(
    urls: string[],
    requestId: string,
    keepAliveCallback?: () => void,
  ): Promise<Array<{ url: string; content: string; title?: string }>> {
    log("info", `馃寪 Starting deep browse for ${urls.length} pages`, {
      requestId,
      urls: urls.map((u) => u.substring(0, 100)),
    });

    // 璁剧疆蹇冭烦瀹氭椂鍣
    let keepAliveInterval: number | undefined;
    if (keepAliveCallback) {
      keepAliveInterval = setInterval(() => {
        keepAliveCallback();
      }, 5000); // 姣?5 绉掑彂閫佸績璺
    }

    try {
      const scrapePromises = urls.map(async (url) => {
        try {
          const scrapeParams = {
            url,
            formats: ["markdown"],
          };

          const response = await this.firecrawlClient.scrape(scrapeParams);

          log("info", `鉁?Page scraped successfully`, {
            requestId,
            url: url.substring(0, 100),
            contentLength: response.data.markdown?.length || 0,
          });

          return {
            url,
            content: response.data.markdown || response.data.html || "",
            title: response.data.metadata?.title,
          };
        } catch (error) {
          log("warn", `鉂?Failed to scrape page`, {
            requestId,
            url: url.substring(0, 100),
            error: String(error),
          });
          return {
            url,
            content: `[Failed to fetch: ${String(error)}]`,
            title: undefined,
          };
        }
      });

      const results = await Promise.all(scrapePromises);

      log("info", `鉁?Deep browse completed`, {
        requestId,
        totalPages: results.length,
        successfulPages: results.filter((r) => !r.content.startsWith("[Failed")).length,
      });

      return results;
    } finally {
      // 娓呴櫎蹇冭烦瀹氭椂鍣
      if (keepAliveInterval !== undefined) {
        clearInterval(keepAliveInterval);
      }
    }
  }

  /**
   * 鏋勫缓娣卞叆娴忚鍚庣殑鏈€缁堝垎鏋愭彁绀鸿瘝
   */
  private buildFinalAnalysisPrompt(
    query: string,
    searchSummary: string,
    initialAnalysis: string,
    browseResults: Array<{ url: string; content: string; title?: string }>,
  ): string {
    let prompt =
      `Based on the search query "${query}", I have gathered the following information:\n\n`;

    prompt += `## Search Results Summary\n${searchSummary}\n\n`;

    if (initialAnalysis) {
      prompt += `## Initial Analysis\n${initialAnalysis}\n\n`;
    }

    prompt += `## Deep Browse Results\n`;
    prompt += `I have browsed the following ${browseResults.length} pages in detail:\n\n`;

    // 浣跨敤閰嶇疆鐨勯檺鍒
    const contentLimit = this.webToolsConfig.deepBrowsePageContentLimit || 5000;

    browseResults.forEach((result, index) => {
      prompt += `### Page ${index + 1}: ${result.title || result.url}\n`;
      prompt += `URL: ${result.url}\n`;
      // 浣跨敤閰嶇疆鐨勫瓧绗︽暟闄愬埗
      const content = result.content.substring(0, contentLimit);
      prompt += `Content:\n${content}\n\n`;
    });

    prompt +=
      `\nPlease provide a comprehensive, well-structured final answer that synthesizes all the information above. Focus on directly answering the user's question with accurate details from the browsed pages.`;

    return prompt;
  }

  /**
   * 鑾峰彇娣卞叆娴忚閾炬帴锛堥潪娴佸紡锛屼粎鑾峰彇閾炬帴鍒楄〃锛?   */
  private async getDeepBrowseLinks(
    messages: ClaudeMessage[],
    query: string,
    searchSummary: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    count: number,
  ): Promise<string[]> {
    const prompt =
      `Based on the following search results for the query "${query}", you MUST select EXACTLY ${count} URLs that would provide the most detailed and authoritative information.

${searchSummary}

REQUIREMENTS:
1. You MUST select EXACTLY ${count} URLs (no more, no less)
2. Choose the most valuable and relevant pages
3. URLs MUST be from the search results above
4. Output ONLY the URLs in the format below (no explanations, no additional text)
5. Do NOT call web_search again. The search has already been performed above.

[DEEP_BROWSE_LINKS]
https://example.com/page1
https://example.com/page2
https://example.com/page3
[/DEEP_BROWSE_LINKS]`;

    // 鎻愬彇鐢ㄦ埛鍘熷闂

    // 鏋勫缓娓呯悊鍚庣殑娑堟伅鍒楄〃锛堢Щ闄ゅ伐鍏峰畾涔夛級
    const cleanMessages = this.buildCleanMessages(messages, prompt);

    // 浣跨敤 AIClient 鍙戦€佽姹
    try {
      const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
      const client = new AIClient(context);

      const response = await client.request(cleanMessages, {
        max_tokens: 500,
        temperature: 0.3,
      });

      const responseText = typeof response.content === "string" ? response.content : "";

      log("info", `馃 AI response for deep browse links`, {
        requestId,
        requestedCount: count,
        responseLength: responseText.length,
        responsePreview: responseText.substring(0, 500),
      });

      // 鎻愬彇閾炬帴
      const links = this.extractDeepBrowseLinks(responseText);

      log("info", `馃敆 Got deep browse links`, {
        requestId,
        requestedCount: count,
        extractedCount: links.length,
        links: links.map((l) => l.substring(0, 100)),
      });

      return links;
    } catch (error) {
      log("warn", `Failed to get deep browse links`, {
        requestId,
        error: String(error),
      });
      return [];
    }
  }

  /**
   * 鏋勫缓娓呯悊鍚庣殑娑堟伅鍒楄〃锛堜繚鐣欏畬鏁村璇濅笂涓嬫枃锛屽彧绉婚櫎 tool_use 鍜屽伐鍏峰畾涔夛級
   * 鐢ㄤ簬鍐呴儴 AI 璇锋眰锛岄伩鍏?AI 鍐嶆璋冪敤宸ュ叿
   */
  private buildCleanMessages(
    originalMessages: ClaudeMessage[],
    additionalPrompt: string,
  ): ClaudeMessage[] {
    const cleanMessages: ClaudeMessage[] = [];

    let lastUserMessageIndex = -1;
    for (let i = originalMessages.length - 1; i >= 0; i--) {
      if (originalMessages[i].role === "user") {
        lastUserMessageIndex = i;
        break;
      }
    }

    for (const [messageIndex, msg] of originalMessages.entries()) {
      // 鍙繚鐣?user 鍜?assistant 瑙掕壊鐨勬秷鎭
      if (msg.role !== "user" && msg.role !== "assistant") {
        continue;
      }

      // 澶勭悊娑堟伅鍐呭锛岃繃婊ゆ帀 tool_use 鍧
      let cleanContent: string | ClaudeContentBlock[];
      if (typeof msg.content === "string") {
        // 绾枃鏈唴瀹癸紝濡傛灉鏄渶鍚庝竴鏉＄敤鎴锋秷鎭紝杩藉姞 additionalPrompt
        if (msg.role === "user" && messageIndex === lastUserMessageIndex) {
          cleanContent = `${msg.content}\n\n${additionalPrompt}`;
        } else {
          cleanContent = msg.content;
        }
      } else if (Array.isArray(msg.content)) {
        // 鏁扮粍鍐呭锛岃繃婊ゆ帀 tool_use 鍧
        const filteredBlocks = msg.content.filter((block) => {
          const typedBlock = block as unknown as Record<string, unknown>;
          return typedBlock.type !== "tool_use" && typedBlock.type !== "server_tool_use";
        });

        // 濡傛灉鏄渶鍚庝竴鏉＄敤鎴锋秷鎭紝杩藉姞 additionalPrompt
        if (msg.role === "user" && messageIndex === lastUserMessageIndex) {
          let appended = false;
          for (let blockIndex = filteredBlocks.length - 1; blockIndex >= 0; blockIndex--) {
            const block = filteredBlocks[blockIndex];
            if (!("type" in block) || block.type !== "text") continue;
            const textBlock = block as ClaudeTextBlock;
            filteredBlocks[blockIndex] = {
              ...textBlock,
              text: `${textBlock.text}\n\n${additionalPrompt}`,
            };
            appended = true;
            break;
          }
          if (!appended) {
            filteredBlocks.push({
              type: "text",
              text: additionalPrompt,
            } as ClaudeTextBlock);
          }
        }
        cleanContent = filteredBlocks;
      } else {
        cleanContent = msg.content;
      }

      // 鍙湁闈炵┖鍐呭鎵嶆坊鍔
      if (
        cleanContent &&
        (typeof cleanContent === "string" ? cleanContent.length > 0 : cleanContent.length > 0)
      ) {
        cleanMessages.push({
          role: msg.role,
          content: cleanContent,
        });
      }
    }

    return cleanMessages;
  }

  /**
   * 娴佸紡璋冪敤涓婃父 API 杩涜鍒嗘瀽锛堟櫘閫氭ā寮忥級
   */
  private async streamUpstreamAnalysis(
    messages: ClaudeMessage[],
    query: string,
    searchSummary: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
  ): Promise<void> {
    // 鏋勫缓鍒嗘瀽鎻愮ず璇
    const prompt =
      `Based on the following search results for the query "${query}", please provide a comprehensive analysis and answer:

${searchSummary}

IMPORTANT: Do NOT call web_search again. The search has already been performed above. Simply analyze the search results and provide a direct answer.`;

    // 鎻愬彇鐢ㄦ埛鍘熷闂

    // 鏋勫缓娓呯悊鍚庣殑娑堟伅鍒楄〃锛堢Щ闄ゅ伐鍏峰畾涔夛級
    const cleanMessages = this.buildCleanMessages(messages, prompt);

    await this.streamFromUpstream(cleanMessages, upstreamInfo, requestId, onStreamChunk);
  }

  /**
   * 娴佸紡杈撳嚭鏈€缁堝垎鏋?   */
  private async streamFinalAnalysis(
    messages: ClaudeMessage[],
    finalPrompt: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
  ): Promise<void> {
    // 鎻愬彇鐢ㄦ埛鍘熷闂

    // 鏋勫缓娓呯悊鍚庣殑娑堟伅鍒楄〃锛堢Щ闄ゅ伐鍏峰畾涔夛級
    const cleanMessages = this.buildCleanMessages(messages, finalPrompt);

    await this.streamFromUpstream(cleanMessages, upstreamInfo, requestId, onStreamChunk);
  }

  /**
   * 閫氱敤娴佸紡璋冪敤涓婃父 API
   */
  private async streamFromUpstream(
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
  ): Promise<void> {
    // 浣跨敤 AIClient 杩涜娴佸紡璇锋眰
    const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
    const client = new AIClient(context);

    await client.streamRequest(
      messages,
      {
        max_tokens: 4096,
      },
      async (chunk) => {
        if (chunk.text) {
          await onStreamChunk(chunk.text);
        }
      },
    );
  }
}

