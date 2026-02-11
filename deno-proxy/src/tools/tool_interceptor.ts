import { FirecrawlClient } from "./firecrawl_client.ts";
import { FormatConverter } from "./format_converter.ts";
import type {
  AnthropicWebSearchToolDefinition,
  AnthropicWebFetchToolDefinition,
  AnthropicServerToolUse,
  AnthropicWebSearchToolResult,
  AnthropicWebFetchToolResult,
  WebToolsConfig,
  FirecrawlConfig,
  SearchInterceptResult,
  FetchInterceptResult,
  SmartSearchInterceptResult,
  UpstreamInfo,
} from "./types.ts";
import type {
  ClaudeMessage,
  ClaudeTextBlock,
  ClaudeContentBlock,
} from "../types.ts";
import { log } from "../logging.ts";
import { AIClient, RequestContext, ContextBuilder } from "../ai_client/mod.ts";

/**
 * 工具拦截器
 * 检测并拦截 Web Search 和 Web Fetch 工具调用
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

  /**
   * 检查请求是否需要拦截
   */
  static shouldIntercept(
    tools: unknown[] | undefined,
    webToolsConfig: WebToolsConfig | undefined,
  ): boolean {
    if (!tools || !webToolsConfig) {
      return false;
    }

    const hasWebSearch = tools.some(
      (tool: unknown) =>
        typeof tool === "object" &&
        tool !== null &&
        "type" in tool &&
        tool.type === "web_search_20250305",
    );

    const hasWebFetch = tools.some(
      (tool: unknown) =>
        typeof tool === "object" &&
        tool !== null &&
        "type" in tool &&
        tool.type === "web_fetch_20250910",
    );

    return (
      (hasWebSearch && webToolsConfig.enableSearchIntercept) ||
      (hasWebFetch && webToolsConfig.enableFetchIntercept)
    );
  }

  /**
   * 处理 Web Search 拦截（简单模式 - 使用已提供的 query）
   */
  async handleWebSearchWithQuery(
    tool: AnthropicWebSearchToolDefinition,
    query: string,
    requestId: string,
  ): Promise<SearchInterceptResult> {
    // 调用 Firecrawl Search API
    const searchParams = {
      query,
      limit: this.webToolsConfig.maxSearchResults,
      location: tool.user_location,
      scrape_options: {
        formats: ["markdown"],
      },
    };

    const firecrawlResponse = await this.firecrawlClient.search(searchParams);

    log("info", `🔎 Firecrawl search completed`, {
      requestId,
      query,
      resultsCount: firecrawlResponse.data.web.length,
      creditsUsed: firecrawlResponse.credits_used,
    });

    // 过滤域名（如果有限制）
    if (tool.allowed_domains && tool.allowed_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        tool.allowed_domains!.some((domain) => result.url.includes(domain))
      );
      log("info", `🔍 Filtered by allowed_domains`, {
        requestId,
        remainingCount: firecrawlResponse.data.web.length,
        allowedDomains: tool.allowed_domains,
      });
    }

    if (tool.blocked_domains && tool.blocked_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        !tool.blocked_domains!.some((domain) => result.url.includes(domain))
      );
      log("info", `🚫 Filtered by blocked_domains`, {
        requestId,
        remainingCount: firecrawlResponse.data.web.length,
        blockedDomains: tool.blocked_domains,
      });
    }

    // 生成唯一的 tool use id (使用 server_tool_use 的 srvtoolu_ 前缀)
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").substring(0, 22)}`;

    // 转换为 Anthropic 格式
    const toolResult = FormatConverter.convertSearchResult(
      firecrawlResponse,
      toolUseId,
    );

    log("info", `📦 Search result converted to Anthropic format`, {
      requestId,
      toolUseId,
      contentCount: toolResult.content.length,
      sampleResult: toolResult.content[0] ? {
        url: toolResult.content[0].url.substring(0, 50),
        title: toolResult.content[0].title.substring(0, 50),
        hasEncrypted: !!toolResult.content[0].encrypted_content,
      } : null,
    });

    // 构建 server_tool_use
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
   * 处理 Web Search 拦截（简单模式）
   */
  async handleWebSearch(
    tool: AnthropicWebSearchToolDefinition,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): Promise<SearchInterceptResult> {
    // 使用 AI 生成精确的搜索词
    const query = await this.extractSearchQuery(messages, upstreamInfo, requestId);

    // 调用 Firecrawl Search API
    const searchParams = {
      query,
      limit: this.webToolsConfig.maxSearchResults,
      location: tool.user_location,
      scrape_options: {
        formats: ["markdown"],
      },
    };

    const firecrawlResponse = await this.firecrawlClient.search(searchParams);

    log("info", `🔎 Firecrawl search completed`, {
      requestId,
      query,
      resultsCount: firecrawlResponse.data.web.length,
      creditsUsed: firecrawlResponse.credits_used,
    });

    // 过滤域名（如果有限制）
    if (tool.allowed_domains && tool.allowed_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        tool.allowed_domains!.some((domain) => result.url.includes(domain))
      );
      log("info", `🔍 Filtered by allowed_domains`, {
        requestId,
        remainingCount: firecrawlResponse.data.web.length,
        allowedDomains: tool.allowed_domains,
      });
    }

    if (tool.blocked_domains && tool.blocked_domains.length > 0) {
      firecrawlResponse.data.web = firecrawlResponse.data.web.filter((result) =>
        !tool.blocked_domains!.some((domain) => result.url.includes(domain))
      );
      log("info", `🚫 Filtered by blocked_domains`, {
        requestId,
        remainingCount: firecrawlResponse.data.web.length,
        blockedDomains: tool.blocked_domains,
      });
    }

    // 生成唯一的 tool use id (使用 server_tool_use 的 srvtoolu_ 前缀)
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").substring(0, 22)}`;

    // 转换为 Anthropic 格式
    const toolResult = FormatConverter.convertSearchResult(
      firecrawlResponse,
      toolUseId,
    );

    log("info", `📦 Search result converted to Anthropic format`, {
      requestId,
      toolUseId,
      contentCount: toolResult.content.length,
      sampleResult: toolResult.content[0] ? {
        url: toolResult.content[0].url.substring(0, 50),
        title: toolResult.content[0].title.substring(0, 50),
        hasEncrypted: !!toolResult.content[0].encrypted_content,
      } : null,
    });

    // 构建 server_tool_use
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
   * 处理 Web Search 拦截（智能模式 - 流式版本）
   * 接收已有的搜索结果，流式调用上游 LLM 进行分析
   * 如果启用深入浏览，会进一步抓取推荐页面并进行最终总结
   *
   * @param searchResult - 已获取的搜索结果
   * @param onStreamChunk - 接收文本增量的回调函数
   */
  async doStreamAnalysis(
    tool: AnthropicWebSearchToolDefinition,
    searchResult: SearchInterceptResult,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
    keepAliveCallback?: () => void,
  ): Promise<void> {
    // 构建搜索结果的文本摘要
    const searchSummary = this.buildSearchSummary(searchResult.toolResult);

    // 判断是否启用深入浏览
    const deepBrowseEnabled = this.webToolsConfig.deepBrowseEnabled;
    const deepBrowseCount = this.webToolsConfig.deepBrowseCount;

    log("info", `🤖 Starting streaming analysis`, {
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
      // 普通模式：直接流式输出分析
      await this.streamUpstreamAnalysis(
        messages,
        searchResult.serverToolUse.input.query!,
        searchSummary,
        upstreamInfo,
        requestId,
        onStreamChunk,
      );
    } else {
      // 深入浏览模式：先获取链接列表，再抓取，最后流式输出最终分析
      const linksList = await this.getDeepBrowseLinks(
        messages,
        searchResult.serverToolUse.input.query!,
        searchSummary,
        upstreamInfo,
        requestId,
        deepBrowseCount,
      );

      if (linksList.length === 0) {
        // 如果没有推荐链接，直接流式输出普通分析
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

      // 限制浏览数量 - 强制使用 Math.min 确保不超过配置值
      const linksToFetch = linksList.slice(0, Math.min(linksList.length, deepBrowseCount));

      log("info", `🔗 Fetching deep browse pages`, {
        requestId,
        originalLinksCount: linksList.length,
        requestedCount: deepBrowseCount,
        actualFetchCount: linksToFetch.length,
        links: linksToFetch.map(l => l.substring(0, 100)),
      });

      // 并发抓取推荐的页面
      const browseResults = await this.fetchMultiplePages(linksToFetch, requestId, keepAliveCallback);

      log("info", `📚 Browse results obtained`, {
        requestId,
        resultsCount: browseResults.length,
        contentLengths: browseResults.map(r => r.content.length),
      });

      // 构建最终分析提示词
      const finalPrompt = this.buildFinalAnalysisPrompt(
        searchResult.serverToolUse.input.query!,
        searchSummary,
        "",  // 不需要初步分析
        browseResults,
      );

      log("info", `📝 Final analysis prompt built`, {
        requestId,
        promptLength: finalPrompt.length,
        promptPreview: finalPrompt.substring(0, 200),
      });

      // 流式输出最终分析
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
   * 处理 Web Search 拦截（智能模式）
   * 先调用 Firecrawl 获取搜索结果，再调用上游 LLM 进行分析
   * 如果启用深入浏览，会进一步抓取推荐页面并进行最终总结
   */
  async handleSmartWebSearch(
    tool: AnthropicWebSearchToolDefinition,
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    keepAliveCallback?: () => void,
  ): Promise<SmartSearchInterceptResult> {
    // 1. 先获取搜索结果（使用简单模式的逻辑，已包含 AI 生成搜索词）
    const simpleResult = await this.handleWebSearch(tool, messages, upstreamInfo, requestId);

    // 2. 构建搜索结果的文本摘要
    const searchSummary = this.buildSearchSummary(simpleResult.toolResult);

    // 3. 调用上游 LLM 进行初步分析
    const deepBrowseEnabled = this.webToolsConfig.deepBrowseEnabled;
    const deepBrowseCount = this.webToolsConfig.deepBrowseCount;

    log("info", `🤖 Starting initial analysis`, {
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

    // 4. 如果未启用深入浏览，直接返回初步分析（移除标记）
    if (!deepBrowseEnabled) {
      const cleanedText = this.removeDeepBrowseMarkers(initialAnalysisText);

      log("info", `✅ Returning simple analysis (deep browse disabled)`, {
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

    // 5. 提取 AI 推荐的深入浏览链接
    const deepBrowseLinks = this.extractDeepBrowseLinks(initialAnalysisText);

    log("info", `🔗 Extracted deep browse links`, {
      requestId,
      linksCount: deepBrowseLinks.length,
      links: deepBrowseLinks.map(l => l.substring(0, 100)),
    });

    // 如果没有推荐链接，返回初步分析（移除标记）
    if (deepBrowseLinks.length === 0) {
      const cleanedText = this.removeDeepBrowseMarkers(initialAnalysisText);

      log("info", `✅ No links to browse, returning initial analysis`, {
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

    // 6. 限制浏览数量 - 强制使用 Math.min 确保不超过配置值
    const linksToFetch = deepBrowseLinks.slice(0, Math.min(deepBrowseLinks.length, deepBrowseCount));

    log("info", `🔗 Deep browse links after limiting`, {
      requestId,
      originalCount: deepBrowseLinks.length,
      requestedCount: deepBrowseCount,
      actualCount: linksToFetch.length,
    });

    // 7. 并发抓取推荐的页面（传入 keepAlive 回调）
    const browseResults = await this.fetchMultiplePages(linksToFetch, requestId, keepAliveCallback);

    // 8. 移除标记后的初步分析
    const cleanedInitialAnalysis = this.removeDeepBrowseMarkers(initialAnalysisText);

    // 9. 构建最终分析提示词
    const finalPrompt = this.buildFinalAnalysisPrompt(
      simpleResult.serverToolUse.input.query!,
      searchSummary,
      cleanedInitialAnalysis,
      browseResults,
    );

    // 10. 调用上游 LLM 进行最终总结
    log("info", `🧠 Calling upstream for final analysis`, {
      requestId,
      browseResultsCount: browseResults.length,
    });

    const finalAnalysisText = await this.callUpstreamForFinalAnalysis(
      messages,
      finalPrompt,
      upstreamInfo,
      requestId,
    );

    log("info", `✅ Final analysis completed`, {
      requestId,
      analysisLength: finalAnalysisText.length,
    });

    // 11. 返回智能模式结果：LLM 最终分析 + 搜索结果
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
   * 处理 Web Fetch 拦截（简单模式）
   */
  async handleWebFetch(
    tool: AnthropicWebFetchToolDefinition,
    url: string,
    requestId: string,
  ): Promise<FetchInterceptResult> {
    log("info", "📥 Starting Firecrawl scrape", {
      requestId,
      url: url.substring(0, 100),
    });

    // 调用 Firecrawl Scrape API
    const scrapeParams = {
      url,
      formats: ["markdown"],
    };

    const firecrawlResponse = await this.firecrawlClient.scrape(scrapeParams);

    log("info", "✅ Firecrawl scrape completed", {
      requestId,
      url: url.substring(0, 100),
      contentLength: firecrawlResponse.data.markdown?.length || 0,
      creditsUsed: firecrawlResponse.credits_used,
    });

    // 生成唯一的 tool use id (使用 server_tool_use 的 srvtoolu_ 前缀)
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").substring(0, 22)}`;

    // 转换为 Anthropic 格式
    const toolResult = FormatConverter.convertScrapeResult(
      firecrawlResponse,
      toolUseId,
      url,
    );

    // 构建 server_tool_use
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
   * 从 UpstreamInfo 创建临时 RequestContext 用于辅助 AI 请求
   */
  private createContextFromUpstreamInfo(
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): RequestContext {
    return RequestContext.fromUpstreamInfo(upstreamInfo, requestId);
  }

  /**
   * 从消息中提取搜索查询
   * 使用上游 AI 生成精确的搜索词
   */
  private async extractSearchQuery(
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): Promise<string> {
    // 获取最后一条用户消息
    const lastUserMessage = [...messages]
      .reverse()
      .find((msg) => msg.role === "user");

    if (!lastUserMessage) {
      return "";
    }

    // 提取文本内容
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

    log("info", "🤖 Generating search query with AI", {
      requestId,
      userQuestion: userQuestion.substring(0, 100) + (userQuestion.length > 100 ? "..." : ""),
      model: upstreamInfo.model,
    });

    // 使用上游 AI 生成搜索词
    const queryPrompt = `Based on the following user question, generate a concise and precise search query (maximum 200 characters) that would be effective for a web search engine. Return ONLY the search query, without any explanations or additional text.

User question: ${userQuestion}

Search query:`;

    // 构建请求消息
    const queryMessages: ClaudeMessage[] = [
      {
        role: "user",
        content: queryPrompt,
      },
    ];

    // 使用 AIClient 发送请求
    try {
      const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
      const client = new AIClient(context);

      const response = await client.request(queryMessages, {
        max_tokens: 100,
        temperature: 0.3,
      });

      // 提取生成的搜索词
      let generatedQuery = typeof response.content === "string" ? response.content.trim() : "";

      // 限制长度为 200 字符
      if (generatedQuery.length > 200) {
        generatedQuery = generatedQuery.substring(0, 200);
      }

      log("info", "✅ Search query generated", {
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
   * 后备方案：简单的关键词提取（当 AI 调用失败时使用）
   */
  private fallbackExtractQuery(text: string): string {
    // 简单的关键词提取：移除常见的停用词
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

    // 限制长度为 200 字符
    let query = keywords.join(" ");
    if (query.length > 200) {
      query = query.substring(0, 200);
    }

    return query || text.substring(0, 200);
  }

  /**
   * 构建搜索结果摘要（用于 LLM 分析）
   */
  private buildSearchSummary(toolResult: AnthropicWebSearchToolResult): string {
    const results = toolResult.content;
    if (results.length === 0) {
      return "No search results found.";
    }

    let summary = `Found ${results.length} search results:\n\n`;
    results.forEach((result, index) => {
      summary += `${index + 1}. ${result.title}\n`;
      summary += `   URL: ${result.url}\n`;
      // 解码 encrypted_content 获取预览（如果可能）
      try {
        const decoded = atob(result.encrypted_content);
        const data = JSON.parse(decoded);
        if (data.preview) {
          summary += `   Preview: ${data.preview}\n`;
        }
      } catch {
        // 忽略解码错误
      }
      summary += `\n`;
    });

    return summary;
  }

  /**
   * 调用上游 API 进行初步分析（可能包含深入浏览链接标记）
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
    log("info", `🧠 Calling upstream for initial search analysis`, {
      requestId,
      query: query.substring(0, 100),
      model: upstreamInfo.model,
      summaryLength: contentSummary.length,
      deepBrowseEnabled,
    });

    // 构建分析提示词
    let analysisPrompt: string;

    if (deepBrowseEnabled) {
      // 深入浏览模式：只输出有价值的链接列表
      analysisPrompt = `Based on the following search results for the query "${query}", please select ${deepBrowseCount} most valuable pages that would provide detailed and authoritative information.

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
      // 普通模式：正常总结
      analysisPrompt = `Based on the following search results for the query "${query}", please provide a comprehensive analysis and answer:\n\n${contentSummary}\n\nProvide a detailed, well-structured response that synthesizes the information from these search results.
IMPORTANT: Do NOT call web_search again. The search has already been performed above.`;
    }

    // 提取用户原始问题
    const userQuestion = this.extractUserQuestion(originalMessages);

    // 构建清理后的消息列表（移除工具定义）
    const cleanMessages = this.buildCleanMessages(originalMessages, userQuestion, analysisPrompt);

    // 使用 AIClient 发送请求
    const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
    const client = new AIClient(context);

    const response = await client.request(cleanMessages, {
      max_tokens: 4096,
    });

    const analysisText = typeof response.content === "string" ? response.content : "No analysis generated.";

    log("info", `✅ Initial analysis completed`, {
      requestId,
      analysisLength: analysisText.length,
      hasContent: analysisText !== "No analysis generated.",
    });

    return analysisText;
  }

  /**
   * 调用上游 API 进行最终分析（基于深入浏览结果）
   */
  private async callUpstreamForFinalAnalysis(
    originalMessages: ClaudeMessage[],
    finalPrompt: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
  ): Promise<string> {
    // 提取用户原始问题
    const userQuestion = this.extractUserQuestion(originalMessages);

    // 构建清理后的消息列表（移除工具定义）
    const cleanMessages = this.buildCleanMessages(originalMessages, userQuestion, finalPrompt);

    // 使用 AIClient 发送请求
    const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
    const client = new AIClient(context);

    const response = await client.request(cleanMessages, {
      max_tokens: 4096,
    });

    return typeof response.content === "string" ? response.content : "No analysis generated.";
  }

  /**
   * 从 AI 分析文本中提取深入浏览链接
   */
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
   * 移除文本中的深入浏览链接标记
   */
  private removeDeepBrowseMarkers(analysisText: string): string {
    return analysisText.replace(/\[DEEP_BROWSE_LINKS\][\s\S]*?\[\/DEEP_BROWSE_LINKS\]/g, '').trim();
  }

  /**
   * 并发抓取多个页面
   */
  private async fetchMultiplePages(
    urls: string[],
    requestId: string,
    keepAliveCallback?: () => void,
  ): Promise<Array<{ url: string; content: string; title?: string }>> {
    log("info", `🌐 Starting deep browse for ${urls.length} pages`, {
      requestId,
      urls: urls.map(u => u.substring(0, 100)),
    });

    // 设置心跳定时器
    let keepAliveInterval: number | undefined;
    if (keepAliveCallback) {
      keepAliveInterval = setInterval(() => {
        keepAliveCallback();
      }, 5000); // 每 5 秒发送心跳
    }

    try {
      const scrapePromises = urls.map(async (url) => {
        try {
          const scrapeParams = {
            url,
            formats: ["markdown"],
          };

          const response = await this.firecrawlClient.scrape(scrapeParams);

          log("info", `✅ Page scraped successfully`, {
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
          log("warn", `❌ Failed to scrape page`, {
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

      log("info", `✅ Deep browse completed`, {
        requestId,
        totalPages: results.length,
        successfulPages: results.filter(r => !r.content.startsWith("[Failed")).length,
      });

      return results;
    } finally {
      // 清除心跳定时器
      if (keepAliveInterval !== undefined) {
        clearInterval(keepAliveInterval);
      }
    }
  }

  /**
   * 构建深入浏览后的最终分析提示词
   */
  private buildFinalAnalysisPrompt(
    query: string,
    searchSummary: string,
    initialAnalysis: string,
    browseResults: Array<{ url: string; content: string; title?: string }>,
  ): string {
    let prompt = `Based on the search query "${query}", I have gathered the following information:\n\n`;

    prompt += `## Search Results Summary\n${searchSummary}\n\n`;

    if (initialAnalysis) {
      prompt += `## Initial Analysis\n${initialAnalysis}\n\n`;
    }

    prompt += `## Deep Browse Results\n`;
    prompt += `I have browsed the following ${browseResults.length} pages in detail:\n\n`;

    // 使用配置的限制
    const contentLimit = this.webToolsConfig.deepBrowsePageContentLimit || 5000;

    browseResults.forEach((result, index) => {
      prompt += `### Page ${index + 1}: ${result.title || result.url}\n`;
      prompt += `URL: ${result.url}\n`;
      // 使用配置的字符数限制
      const content = result.content.substring(0, contentLimit);
      prompt += `Content:\n${content}\n\n`;
    });

    prompt += `\nPlease provide a comprehensive, well-structured final answer that synthesizes all the information above. Focus on directly answering the user's question with accurate details from the browsed pages.`;

    return prompt;
  }

  /**
   * 获取深入浏览链接（非流式，仅获取链接列表）
   */
  private async getDeepBrowseLinks(
    messages: ClaudeMessage[],
    query: string,
    searchSummary: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    count: number,
  ): Promise<string[]> {
    const prompt = `Based on the following search results for the query "${query}", you MUST select EXACTLY ${count} URLs that would provide the most detailed and authoritative information.

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

    // 提取用户原始问题
    const userQuestion = this.extractUserQuestion(messages);

    // 构建清理后的消息列表（移除工具定义）
    const cleanMessages = this.buildCleanMessages(messages, userQuestion, prompt);

    // 使用 AIClient 发送请求
    try {
      const context = this.createContextFromUpstreamInfo(upstreamInfo, requestId);
      const client = new AIClient(context);

      const response = await client.request(cleanMessages, {
        max_tokens: 500,
        temperature: 0.3,
      });

      const responseText = typeof response.content === "string" ? response.content : "";

      log("info", `🤖 AI response for deep browse links`, {
        requestId,
        requestedCount: count,
        responseLength: responseText.length,
        responsePreview: responseText.substring(0, 500),
      });

      // 提取链接
      const links = this.extractDeepBrowseLinks(responseText);

      log("info", `🔗 Got deep browse links`, {
        requestId,
        requestedCount: count,
        extractedCount: links.length,
        links: links.map(l => l.substring(0, 100)),
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
   * 从消息中提取用户原始问题（移除工具定义和 tool_use 消息）
   * 用于内部 AI 请求，避免 AI 再次调用工具
   */
  private extractUserQuestion(messages: ClaudeMessage[]): string {
    // 找到最后一条用户消息
    const lastUserMessage = [...messages]
      .reverse()
      .find((msg) => msg.role === "user");

    if (!lastUserMessage) {
      return "";
    }

    // 提取文本内容
    if (typeof lastUserMessage.content === "string") {
      return lastUserMessage.content;
    } else if (Array.isArray(lastUserMessage.content)) {
      const textBlocks = lastUserMessage.content.filter((block) =>
        "type" in block && block.type === "text"
      );
      return textBlocks.map((block) => "text" in block ? block.text : "").join(
        " ",
      );
    }

    return "";
  }

  /**
   * 构建清理后的消息列表（保留完整对话上下文，只移除 tool_use 和工具定义）
   * 用于内部 AI 请求，避免 AI 再次调用工具
   */
  private buildCleanMessages(
    originalMessages: ClaudeMessage[],
    userQuestion: string,
    additionalPrompt: string,
  ): ClaudeMessage[] {
    const cleanMessages: ClaudeMessage[] = [];

    for (const msg of originalMessages) {
      // 只保留 user 和 assistant 角色的消息
      if (msg.role !== "user" && msg.role !== "assistant") {
        continue;
      }

      // 处理消息内容，过滤掉 tool_use 块
      let cleanContent: string | ClaudeContentBlock[];
      if (typeof msg.content === "string") {
        // 纯文本内容，如果是最后一条用户消息，追加 additionalPrompt
        if (msg.role === "user" && msg.content === userQuestion) {
          cleanContent = `${msg.content}\n\n${additionalPrompt}`;
        } else {
          cleanContent = msg.content;
        }
      } else if (Array.isArray(msg.content)) {
        // 数组内容，过滤掉 tool_use 块
        const filteredBlocks = msg.content.filter((block) =>
          !("type" in block && block.type === "tool_use")
        );

        // 如果是最后一条用户消息，追加 additionalPrompt
        if (msg.role === "user" && filteredBlocks.some(b => "type" in b && b.type === "text")) {
          const textBlocks = filteredBlocks.filter((b): b is ClaudeTextBlock =>
            "type" in b && b.type === "text"
          );
          if (textBlocks.length > 0) {
            const lastTextIndex = filteredBlocks.findIndex(b => "type" in b && b.type === "text");
            filteredBlocks[lastTextIndex] = {
              ...textBlocks[0],
              text: `${textBlocks[0].text}\n\n${additionalPrompt}`
            };
          }
        }
        cleanContent = filteredBlocks;
      } else {
        cleanContent = msg.content;
      }

      // 只有非空内容才添加
      if (cleanContent &&
          (typeof cleanContent === "string" ? cleanContent.length > 0 : cleanContent.length > 0)) {
        cleanMessages.push({
          role: msg.role,
          content: cleanContent,
        });
      }
    }

    return cleanMessages;
  }

  /**
   * 流式调用上游 API 进行分析（普通模式）
   */
  private async streamUpstreamAnalysis(
    messages: ClaudeMessage[],
    query: string,
    searchSummary: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
  ): Promise<void> {
    // 构建分析提示词
    const prompt = `Based on the following search results for the query "${query}", please provide a comprehensive analysis and answer:

${searchSummary}

IMPORTANT: Do NOT call web_search again. The search has already been performed above. Simply analyze the search results and provide a direct answer.`;

    // 提取用户原始问题
    const userQuestion = this.extractUserQuestion(messages);

    // 构建清理后的消息列表（移除工具定义）
    const cleanMessages = this.buildCleanMessages(messages, userQuestion, prompt);

    await this.streamFromUpstream(cleanMessages, upstreamInfo, requestId, onStreamChunk);
  }

  /**
   * 流式输出最终分析
   */
  private async streamFinalAnalysis(
    messages: ClaudeMessage[],
    finalPrompt: string,
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
  ): Promise<void> {
    // 提取用户原始问题
    const userQuestion = this.extractUserQuestion(messages);

    // 构建清理后的消息列表（移除工具定义）
    const cleanMessages = this.buildCleanMessages(messages, userQuestion, finalPrompt);

    await this.streamFromUpstream(cleanMessages, upstreamInfo, requestId, onStreamChunk);
  }

  /**
   * 通用流式调用上游 API
   */
  private async streamFromUpstream(
    messages: ClaudeMessage[],
    upstreamInfo: UpstreamInfo,
    requestId: string,
    onStreamChunk: (text: string) => Promise<void>,
  ): Promise<void> {
    // 使用 AIClient 进行流式请求
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

