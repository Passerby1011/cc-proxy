/**
 * 解析后的工具调用拦截器
 * 用于拦截通过 ToolifyParser 解析出的工具调用
 */

import { SSEWriter } from "../sse.ts";
import { log } from "../logging.ts";
import { ToolInterceptor } from "./tool_interceptor.ts";
import { StreamResponseWriter } from "./stream_response_writer.ts";
import type { WebToolsConfig, FirecrawlConfig, UpstreamInfo } from "./types.ts";
import type { ParsedInvokeCall } from "../types.ts";

export class ParsedToolInterceptor {
  private toolInterceptor: ToolInterceptor;
  private webToolsConfig: WebToolsConfig;
  private requestId: string;
  private messages: any[];
  private upstreamInfo: UpstreamInfo;

  constructor(
    firecrawlConfig: FirecrawlConfig,
    webToolsConfig: WebToolsConfig,
    requestId: string,
    messages: any[],
    upstreamInfo: UpstreamInfo,
  ) {
    this.toolInterceptor = new ToolInterceptor(firecrawlConfig, webToolsConfig);
    this.webToolsConfig = webToolsConfig;
    this.requestId = requestId;
    this.messages = messages;
    this.upstreamInfo = upstreamInfo;
  }

  /**
   * 尝试拦截工具调用
   * @returns true 表示已拦截，false 表示不拦截
   */
  async interceptToolCall(toolCall: ParsedInvokeCall, writer: SSEWriter): Promise<boolean> {
    const toolName = toolCall.name;

    // 判断是否需要拦截
    if (toolName === "web_search" && this.webToolsConfig.enableSearchIntercept) {
      await this.handleWebSearch(toolCall, writer);
      return true;
    }

    if (toolName === "web_fetch" && this.webToolsConfig.enableFetchIntercept) {
      await this.handleWebFetch(toolCall, writer);
      return true;
    }

    return false;
  }

  /**
   * 处理 Web Search 拦截
   */
  private async handleWebSearch(toolCall: ParsedInvokeCall, writer: SSEWriter): Promise<void> {
    const query = toolCall.arguments.query as string | undefined;

    if (!query) {
      log("error", "No query found in web_search arguments", {
        requestId: this.requestId,
        arguments: toolCall.arguments,
      });
      return;
    }

    log("info", `🔍 Intercepting web_search: ${query}`, {
      requestId: this.requestId,
    });

    const webSearchTool = {
      type: "web_search_20250305" as const,
      name: "web_search" as const,
      max_uses: 15,
      allowed_domains: toolCall.arguments.allowed_domains as string[] | undefined,
      blocked_domains: toolCall.arguments.blocked_domains as string[] | undefined,
    };

    // 执行搜索
    const searchResult = await this.toolInterceptor.handleWebSearch(
      webSearchTool,
      this.messages,
      this.upstreamInfo,
      this.requestId,
    );

    const model = this.upstreamInfo.model;
    const isSmartMode = this.webToolsConfig.searchMode === "smart";

    if (isSmartMode) {
      // 智能模式：流式输出分析
      await StreamResponseWriter.writeSmartSearchResponseStreaming(
        writer,
        model,
        async () => searchResult,
        async (onStreamChunk) => {
          await this.toolInterceptor.doStreamAnalysis(
            webSearchTool,
            searchResult,
            this.messages,
            this.upstreamInfo,
            this.requestId,
            onStreamChunk,
            // keepAlive 回调
            () => {
              try {
                if (!writer.isClosed()) {
                  writer.send({ event: "ping", data: { type: "ping" } }, false);
                }
              } catch {
                // 忽略错误
              }
            },
          );
        },
      );
    } else {
      // 简单模式：直接输出搜索结果
      await StreamResponseWriter.writeSearchResponse(
        writer,
        searchResult,
        model,
      );
    }
  }

  /**
   * 处理 Web Fetch 拦截
   */
  private async handleWebFetch(toolCall: ParsedInvokeCall, writer: SSEWriter): Promise<void> {
    const url = toolCall.arguments.url as string | undefined;

    if (!url) {
      log("error", "No URL found in web_fetch arguments", {
        requestId: this.requestId,
        arguments: toolCall.arguments,
      });
      return;
    }

    log("info", `🌐 Intercepting web_fetch: ${url}`, {
      requestId: this.requestId,
    });

    const webFetchTool = {
      type: "web_fetch_20250910" as const,
      name: "web_fetch" as const,
    };

    const fetchResult = await this.toolInterceptor.handleWebFetch(
      webFetchTool,
      url,
      this.requestId,
    );

    const model = this.upstreamInfo.model;

    await StreamResponseWriter.writeFetchResponse(
      writer,
      fetchResult,
      model,
    );
  }
}
