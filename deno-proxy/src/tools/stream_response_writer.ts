import type { SSEWriter } from "../sse.ts";
import type {
  AnthropicServerToolUse,
  AnthropicWebSearchToolResult,
  AnthropicWebFetchToolResult,
  SearchInterceptResult,
  FetchInterceptResult,
  SmartSearchInterceptResult,
} from "./types.ts";
import { log } from "../logging.ts";


/**
 * Web Search/Fetch 流式响应写入器
 * 完全模拟 Anthropic 官方的 SSE 事件序列
 */
export class StreamResponseWriter {
  /**
   * 写入 Web Search 流式响应(简单模式）
   */
  static async writeSearchResponse(
    writer: SSEWriter,
    result: SearchInterceptResult,
    model: string,
  ): Promise<void> {
    const messageId = `msg_${crypto.randomUUID()}`;

    // 记录搜索结果数量，帮助调试
    log("info", "📤 Streaming search results", {
      resultsCount: result.toolResult.content.length,
      toolUseId: result.toolResult.tool_use_id,
    });

    // 1. message_start
    await writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    });

    // 2. content_block_start - server_tool_use
    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: result.serverToolUse.id,
          name: result.serverToolUse.name,
          input: {},
        },
      },
    });

    // 3. content_block_delta - input_json_delta (分块传输 query)
    const query = result.serverToolUse.input.query || "";
    const queryJson = JSON.stringify({ query });

    // 分块传输 JSON，模拟官方的细粒度传输
    const chunks = this.splitJsonIntoChunks(queryJson);
    for (const chunk of chunks) {
      await writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: chunk,
          },
        },
      });
    }

    // 4. content_block_stop - server_tool_use
    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 0,
      },
    });

    // 5. content_block_start - web_search_tool_result
    // 确保搜索结果正确发送
    log("info", "📋 Sending web_search_tool_result content block", {
      resultsCount: result.toolResult.content.length,
      firstResult: result.toolResult.content[0] ? {
        url: result.toolResult.content[0].url,
        title: result.toolResult.content[0].title,
        hasEncryptedContent: !!result.toolResult.content[0].encrypted_content,
        encryptedContentLength: result.toolResult.content[0].encrypted_content?.length,
      } : null,
    });

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: result.toolResult.tool_use_id,
          content: result.toolResult.content,
        },
      },
    });

    // 6. content_block_stop - web_search_tool_result
    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 1,
      },
    });

    // 7. message_delta - 最终统计
    await writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 0,
        },
      },
    });

    // 8. message_stop
    await writer.send({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  }

  /**
   * 写入 Web Search 流式响应（智能模式）
   * 包含 LLM 分析文本和 citations
   */
  static async writeSmartSearchResponse(
    writer: SSEWriter,
    result: SmartSearchInterceptResult,
    model: string,
  ): Promise<void> {
    const messageId = `msg_${crypto.randomUUID()}`;

    // 记录搜索结果数量和分析长度，帮助调试
    log("info", "📤 Streaming smart search results", {
      resultsCount: result.toolResult.content.length,
      analysisLength: result.llmAnalysis.text.length,
      toolUseId: result.toolResult.tool_use_id,
    });

    // 1. message_start
    await writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    });

    // 2-4. server_tool_use 块（与简单模式相同）
    await this.writeServerToolUseBlock(writer, result.serverToolUse, 0);

    // 5-6. web_search_tool_result 块
    log("info", "📋 Sending web_search_tool_result in smart mode", {
      resultsCount: result.toolResult.content.length,
      firstResult: result.toolResult.content[0] ? {
        url: result.toolResult.content[0].url,
        title: result.toolResult.content[0].title,
      } : null,
    });

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: result.toolResult.tool_use_id,
          content: result.toolResult.content,
        },
      },
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 1,
      },
    });

    // 7-8. text 块（LLM 分析）
    const analysisText = result.llmAnalysis.text;
    let currentIndex = 2;

    // 开始文本块
    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: currentIndex,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });

    // 分块传输文本（模拟逐字输出）
    const textChunks = this.splitTextIntoChunks(analysisText);
    for (const chunk of textChunks) {
      await writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: currentIndex,
          delta: {
            type: "text_delta",
            text: chunk,
          },
        },
      });
    }

    // 结束文本块
    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: currentIndex,
      },
    });

    // 9. message_delta
    await writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 0,
        },
      },
    });

    // 10. message_stop
    await writer.send({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  }

  /**
   * 写入 Web Search 流式响应（智能模式 - 真正的流式版本）
   * 先输出搜索结果，然后流式输出 AI 分析
   */
  static async writeSmartSearchResponseStreaming(
    writer: SSEWriter,
    model: string,
    getSearchResult: () => Promise<SearchInterceptResult>,
    streamAnalysis: (onStreamChunk: (text: string) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const messageId = `msg_${crypto.randomUUID()}`;

    log("info", "📤 Starting streaming smart search");

    // 1. message_start
    await writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    });

    // 2. 获取搜索结果
    const result = await getSearchResult();

    // 3-5. server_tool_use 块
    await this.writeServerToolUseBlock(writer, result.serverToolUse, 0);

    // 6-7. web_search_tool_result 块
    log("info", "📋 Sending web_search_tool_result", {
      resultsCount: result.toolResult.content.length,
    });

    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: result.toolResult.tool_use_id,
          content: result.toolResult.content,
        },
      },
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 1,
      },
    });

    // 8. text 块开始
    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });

    // 9. 流式发送 AI 分析
    await streamAnalysis(async (textChunk: string) => {
      // 实时发送文本增量
      if (!writer.isClosed()) {
        await writer.send({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 2,
            delta: {
              type: "text_delta",
              text: textChunk,
            },
          },
        });
      }
    });

    // 10. text 块结束
    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 2,
      },
    });

    // 11. message_delta
    await writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 0,
        },
      },
    });

    // 12. message_stop
    await writer.send({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  }

  /**
   * 写入 Web Fetch 流式响应（简单模式）
   */
  static async writeFetchResponse(
    writer: SSEWriter,
    result: FetchInterceptResult,
    model: string,
  ): Promise<void> {
    const messageId = `msg_${crypto.randomUUID()}`;

    // 1. message_start
    await writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    });

    // 2-4. server_tool_use 块
    await this.writeServerToolUseBlock(writer, result.serverToolUse, 0);

    // 5-6. web_fetch_tool_result 块
    await writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_fetch_tool_result",
          tool_use_id: result.toolResult.tool_use_id,
          content: result.toolResult.content,
        },
      },
    });

    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 1,
      },
    });

    // 7. message_delta
    await writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 0,
        },
      },
    });

    // 8. message_stop
    await writer.send({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  }

  /**
   * 辅助方法：写入 server_tool_use 块
   */
  private static async writeServerToolUseBlock(
    writer: SSEWriter,
    serverToolUse: AnthropicServerToolUse,
    index: number,
  ): Promise<void> {
    // content_block_start
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

    // content_block_delta - input_json_delta
    const inputJson = JSON.stringify(serverToolUse.input);
    const chunks = this.splitJsonIntoChunks(inputJson);

    for (const chunk of chunks) {
      await writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: chunk,
          },
        },
      });
    }

    // content_block_stop
    await writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });
  }

  /**
   * 将 JSON 字符串分割成多个小块，模拟官方的细粒度传输
   */
  private static splitJsonIntoChunks(json: string): string[] {
    const chunks: string[] = [];

    // 空 input 的情况
    if (json === "{}") {
      chunks.push("");
      return chunks;
    }

    // 按照官方样例的分块策略：
    // 1. 空字符串开始
    chunks.push("");

    // 2. 按 token 边界分割（引号、冒号、值等）
    let current = "";
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < json.length; i++) {
      const char = json[i];

      if (escapeNext) {
        current += char;
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        current += char;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        current += char;
        continue;
      }

      if (!inString && (char === ":" || char === "," || char === "{" || char === "}")) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        if (char !== "{" && char !== "}") {
          chunks.push(char + " ");
        }
        continue;
      }

      current += char;

      // 在字符串内部，每隔几个字符分块
      if (inString && current.length >= 6) {
        chunks.push(current);
        current = "";
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  /**
   * 将文本分割成小块，模拟逐字流式输出
   */
  private static splitTextIntoChunks(text: string): string[] {
    const chunks: string[] = [];

    // 简化分块策略：按小段落分割，避免丢字
    // 每 10-15 个字符为一块，在空格或标点处断开
    let current = "";

    for (let i = 0; i < text.length; i++) {
      current += text[i];

      // 当累积到一定长度，且遇到空格、标点或中文字符时分块
      if (current.length >= 10 && (
        text[i] === " " ||
        text[i] === "\n" ||
        text[i] === "," ||
        text[i] === "." ||
        text[i] === ";" ||
        text[i] === "!" ||
        text[i] === "?" ||
        text[i] === "，" ||
        text[i] === "。" ||
        text[i] === "；" ||
        text[i] === "！" ||
        text[i] === "？" ||
        /[\u4e00-\u9fa5]/.test(text[i])
      )) {
        chunks.push(current);
        current = "";
      }
    }

    // 添加剩余部分
    if (current) {
      chunks.push(current);
    }

    return chunks.length > 0 ? chunks : [text];
  }
}
