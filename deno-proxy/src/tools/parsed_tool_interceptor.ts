/**
 * 解析后的工具调用拦截器
 * 用于拦截通过 ToolifyParser 解析出的工具调用
 */

import { SSEWriter } from "../sse.ts";
import { log } from "../logging.ts";
import { ToolInterceptor } from "./tool_interceptor.ts";
import type {
  AnthropicServerToolUse,
  AnthropicWebFetchToolResult,
  AnthropicWebSearchToolResult,
  FirecrawlConfig,
  UpstreamInfo,
  WebToolsConfig,
} from "./types.ts";
import type { ParsedInvokeCall } from "../types.ts";

export class ParsedToolInterceptor {
  private toolInterceptor: ToolInterceptor;
  private webToolsConfig: WebToolsConfig;
  private requestId: string;
  private messages: any[];
  private upstreamInfo: UpstreamInfo;
  private nextInlineBlockIndex = 1_000_000;

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
    const isWebSearchName = toolName === "web_search_20250305" ||
      toolName === "web_search_preview" ||
      toolName === "web_search";
    const isWebFetchName = toolName === "web_fetch_20250910" ||
      toolName === "web_fetch_preview" ||
      toolName === "web_fetch";

    if (isWebSearchName && this.webToolsConfig.enableSearchIntercept) {
      await this.handleWebSearch(toolCall, writer);
      return true;
    }

    if (isWebFetchName && this.webToolsConfig.enableFetchIntercept) {
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

    const filters = (toolCall.arguments.filters && typeof toolCall.arguments.filters === "object")
      ? toolCall.arguments.filters as Record<string, unknown>
      : undefined;

    const allowedDomains = Array.isArray(toolCall.arguments.allowed_domains)
      ? toolCall.arguments.allowed_domains as string[]
      : Array.isArray(toolCall.arguments.domains)
      ? toolCall.arguments.domains as string[]
      : Array.isArray(filters?.allowed_domains)
      ? filters?.allowed_domains as string[]
      : undefined;

    const blockedDomains = Array.isArray(toolCall.arguments.blocked_domains)
      ? toolCall.arguments.blocked_domains as string[]
      : Array.isArray(filters?.blocked_domains)
      ? filters?.blocked_domains as string[]
      : undefined;

    const webSearchTool = {
      type: "web_search_20250305" as const,
      name: "web_search" as const,
      max_uses: 15,
      allowed_domains: allowedDomains,
      blocked_domains: blockedDomains,
    };

    const searchResult = await this.toolInterceptor.handleWebSearchWithQuery(
      webSearchTool,
      query,
      this.requestId,
    );

    await this.writeServerToolUseInline(writer, searchResult.serverToolUse);
    await this.writeWebSearchResultInline(writer, searchResult.toolResult);

    const isSmartMode = this.webToolsConfig.searchMode === "smart";
    if (!isSmartMode) {
      return;
    }

    await this.writeStreamingTextInline(writer, async (onStreamChunk) => {
      await this.toolInterceptor.doStreamAnalysis(
        webSearchTool,
        searchResult,
        this.messages,
        this.upstreamInfo,
        this.requestId,
        onStreamChunk,
        () => {
          try {
            if (!writer.isClosed()) {
              writer.send({ event: "ping", data: { type: "ping" } }, false);
            }
          } catch {
          }
        },
      );
    });
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

    await this.writeServerToolUseInline(writer, fetchResult.serverToolUse);
    await this.writeWebFetchResultInline(writer, fetchResult.toolResult);
  }

  private allocateInlineBlockIndex(): number {
    return this.nextInlineBlockIndex++;
  }

  private async writeServerToolUseInline(
    writer: SSEWriter,
    serverToolUse: AnthropicServerToolUse,
  ): Promise<void> {
    const index = this.allocateInlineBlockIndex();

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: {
          type: "server_tool_use",
          id: serverToolUse.id,
          name: serverToolUse.name,
          input: {},
        },
      },
    });

    await writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(serverToolUse.input ?? {}),
        },
      },
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });
  }

  private async writeWebSearchResultInline(
    writer: SSEWriter,
    toolResult: AnthropicWebSearchToolResult,
  ): Promise<void> {
    const index = this.allocateInlineBlockIndex();

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: toolResult.tool_use_id,
          content: toolResult.content,
        },
      },
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });
  }

  private async writeWebFetchResultInline(
    writer: SSEWriter,
    toolResult: AnthropicWebFetchToolResult,
  ): Promise<void> {
    const index = this.allocateInlineBlockIndex();

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: {
          type: "web_fetch_tool_result",
          tool_use_id: toolResult.tool_use_id,
          content: toolResult.content,
        },
      },
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });
  }

  private async writeStreamingTextInline(
    writer: SSEWriter,
    streamAnalysis: (onStreamChunk: (text: string) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const index = this.allocateInlineBlockIndex();

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });

    await streamAnalysis(async (textChunk: string) => {
      if (!textChunk || writer.isClosed()) return;
      await writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: {
            type: "text_delta",
            text: textChunk,
          },
        },
      });
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });
  }
}
