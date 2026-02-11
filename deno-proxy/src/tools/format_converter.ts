import type {
  FirecrawlSearchResponse,
  FirecrawlScrapeResponse,
  AnthropicWebSearchToolResult,
  AnthropicWebSearchResult,
  AnthropicWebFetchToolResult,
  AnthropicDocument,
  AnthropicDocumentSource,
} from "./types.ts";

/**
 * 格式转换器
 * 将 Firecrawl API 的响应格式转换为 Anthropic 的标准格式
 */
export class FormatConverter {
  /**
   * 将 Firecrawl 搜索结果转换为 Anthropic 格式
   */
  static convertSearchResult(
    firecrawlResponse: FirecrawlSearchResponse,
    toolUseId: string,
  ): AnthropicWebSearchToolResult {
    const searchResults: AnthropicWebSearchResult[] =
      firecrawlResponse.data.web.map((result) => {
        // 生成唯一的 encrypted_content
        const encryptedContent = this.generateEncryptedContent(
          result.url,
          result.title,
          result.description || "",
        );

        // 严格匹配官方格式：必须包含 type 字段
        return {
          type: "web_search_result",
          url: result.url,
          title: result.title,
          encrypted_content: encryptedContent,
          page_age: this.calculatePageAge(),
        } as AnthropicWebSearchResult;
      });

    return {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: searchResults,
    };
  }

  /**
   * 将 Firecrawl 抓取结果转换为 Anthropic 格式
   */
  static convertScrapeResult(
    firecrawlResponse: FirecrawlScrapeResponse,
    toolUseId: string,
    url: string,
  ): AnthropicWebFetchToolResult {
    const isPDF = url.toLowerCase().endsWith(".pdf");

    let source: AnthropicDocumentSource;

    if (isPDF) {
      // PDF 使用 base64 编码
      source = {
        type: "base64",
        media_type: "application/pdf",
        data: firecrawlResponse.data.html || firecrawlResponse.data.markdown ||
          "",
      };
    } else {
      // 文本内容
      source = {
        type: "text",
        media_type: "text/plain",
        data: firecrawlResponse.data.markdown ||
          firecrawlResponse.data.html || "",
      };
    }

    const document: AnthropicDocument = {
      type: "document",
      source,
      title: firecrawlResponse.data.metadata?.title,
      retrieved_at: new Date().toISOString(),
    };

    return {
      type: "web_fetch_tool_result",
      tool_use_id: toolUseId,
      content: [document],
    };
  }

  /**
   * 生成加密内容标识
   * 使用 UUID + base64 编码生成不透明标识符
   */
  private static generateEncryptedContent(
    url: string,
    title: string,
    preview: string,
  ): string {
    const id = crypto.randomUUID();
    const data = {
      id,
      url,
      title,
      preview: preview.substring(0, 150),
    };

    // 使用 base64 编码
    const jsonStr = JSON.stringify(data);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(jsonStr);

    // 转换为 base64
    const base64 = btoa(String.fromCharCode(...bytes));

    return base64;
  }

  /**
   * 计算页面年龄（返回简单的时间戳）
   * 由于 Firecrawl 不提供页面发布时间，这里返回 "recent"
   */
  private static calculatePageAge(): string {
    return "recent";
  }
}
