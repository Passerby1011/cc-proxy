/**
 * 原生工具调用流式响应处理器
 *
 * 处理支持原生工具调用的上游 API 的流式响应
 * 支持 OpenAI 和 Anthropic 两种格式的上游
 */

import { ToolifyParser } from "../parser.ts";
import { SSEWriter } from "../sse.ts";
import { RequestContext } from "../ai_client/mod.ts";
import { log } from "../logging.ts";
import { ToolSeparator } from "./tool_separator.ts";
import { ToolFormatConverter, type OpenAIToolCall } from "./tool_format_converter.ts";
import { ToolInterceptor } from "./tool_interceptor.ts";
import type { ClaudeToolDefinition, ClaudeToolUseBlock, ClaudeMessage, ClaudeContentBlock } from "../types.ts";
import type { AnthropicWebSearchToolDefinition, AnthropicWebFetchToolDefinition, SearchInterceptResult } from "./types.ts";

/**
 * 原生工具调用流式处理器
 */
export class NativeToolCallStreamHandler {
  private context: RequestContext;
  private writer: SSEWriter;
  private webTools: ClaudeToolDefinition[];
  private requestId: string;
  private interceptor: ToolInterceptor | null;
  private messageHistory: ClaudeMessage[]; // 维护消息历史
  private hasWebToolCalls: boolean = false; // 是否有 Web 工具调用

  constructor(
    context: RequestContext,
    writer: SSEWriter,
    webTools: ClaudeToolDefinition[],
    interceptor: ToolInterceptor | null,
    initialMessages?: ClaudeMessage[],
  ) {
    this.context = context;
    this.writer = writer;
    this.webTools = webTools;
    this.requestId = context.getRequestId();
    this.interceptor = interceptor;
    this.messageHistory = initialMessages || [...context.getOriginalRequest().messages];
  }

  /**
   * 检查是否有 Web 工具调用需要处理
   */
  hasWebToolCallsToProcess(): boolean {
    return this.hasWebToolCalls;
  }

  /**
   * 获取更新后的消息历史
   */
  getMessageHistory(): ClaudeMessage[] {
    return this.messageHistory;
  }

  /**
   * 判断是否为 Web 工具
   */
  private isWebTool(toolName: string): boolean {
    // 使用 ToolSeparator 的逻辑判断
    return this.webTools.some(wt => wt.name === toolName);
  }

  /**
   * 处理流式响应
   */
  async handleStream(response: Response): Promise<void> {
    const protocol = this.context.getUpstreamConfig().protocol;

    if (protocol === "openai") {
      await this.handleOpenAIStream(response);
    } else if (protocol === "anthropic") {
      await this.handleAnthropicStream(response);
    } else {
      throw new Error(`Unsupported protocol for native tool calling: ${protocol}`);
    }
  }

  /**
   * 处理 OpenAI 格式的流式响应
   *
   * OpenAI SSE 格式：
   * data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}
   * data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"get_weather","arguments":"{\"location\""}}]},"index":0}]}
   * data: [DONE]
   */
  private async handleOpenAIStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is null");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    // 累积工具调用（OpenAI 的 tool_calls 是增量传输的）
    const toolCallsAccumulator: Map<number, OpenAIToolCall> = new Map();

    let hasStartedMessage = false;
    let currentBlockIndex = 0;

    // 块状态管理
    let currentBlockType: "text" | "thinking" | null = null;

    // 初始化解析器 (仅用于识别 <thinking>，不解析工具)
    const parser = new ToolifyParser(undefined, true, this.requestId);

    // 辅助函数：确保当前处于正确的块类型
    const ensureBlock = async (type: "text" | "thinking") => {
      if (currentBlockType === type) return;

      // 如果之前有其他类型的块开启，先关闭它
      if (currentBlockType) {
        await this.writer.send({
          event: "content_block_stop",
          data: { type: "content_block_stop", index: currentBlockIndex },
        });
        currentBlockIndex++;
      }

      // 开启新块
      const contentBlock = type === "text"
        ? { type: "text", text: "" }
        : { type: "thinking", thinking: "" };

      await this.writer.send({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: currentBlockIndex,
          content_block: contentBlock,
        },
      });

      currentBlockType = type;
    };

    // 辅助函数：关闭当前块
    const closeCurrentBlock = async () => {
      if (currentBlockType) {
        await this.writer.send({
          event: "content_block_stop",
          data: { type: "content_block_stop", index: currentBlockIndex },
        });
        currentBlockIndex++;
        currentBlockType = null;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") {
            // 流结束，先处理完解析器剩余内容
            parser.finish();
            const events = parser.consumeEvents();
            for (const event of events) {
              if (event.type === "text" && event.content) {
                await ensureBlock("text");
                await this.writer.send({
                  event: "content_block_delta",
                  data: {
                    type: "content_block_delta",
                    index: currentBlockIndex,
                    delta: { type: "text_delta", text: event.content },
                  },
                });
              } else if (event.type === "thinking" && event.content) {
                await ensureBlock("thinking");
                await this.writer.send({
                  event: "content_block_delta",
                  data: {
                    type: "content_block_delta",
                    index: currentBlockIndex,
                    delta: { type: "thinking_delta", thinking: event.content },
                  },
                });
              }
            }
            await closeCurrentBlock();

            // 处理累积的工具调用
            if (toolCallsAccumulator.size > 0) {
              await this.handleAccumulatedToolCalls(toolCallsAccumulator);
            }
            continue;
          }

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // 发送 message_start 事件（只发送一次）
            if (!hasStartedMessage) {
              await this.writer.send({
                event: "message_start",
                data: {
                  type: "message_start",
                  message: {
                    id: `msg_${this.requestId}`,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: this.context.getModel(),
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                },
              });
              hasStartedMessage = true;
            }

            // 处理 DeepSeek/OpenAI 思考内容 (reasoning_content)
            if (delta.reasoning_content) {
              await ensureBlock("thinking");
              await this.writer.send({
                event: "content_block_delta",
                data: {
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: { type: "thinking_delta", thinking: delta.reasoning_content },
                },
              });
            }

            // 处理普通文本内容 (content) - 通过 Parser 处理以支持 <thinking> 标签
            if (delta.content) {
              for (const char of delta.content) {
                parser.feedChar(char);
                const events = parser.consumeEvents();
                for (const event of events) {
                  if (event.type === "text" && event.content) {
                    await ensureBlock("text");
                    await this.writer.send({
                      event: "content_block_delta",
                      data: {
                        type: "content_block_delta",
                        index: currentBlockIndex,
                        delta: { type: "text_delta", text: event.content },
                      },
                    });
                  } else if (event.type === "thinking" && event.content) {
                    await ensureBlock("thinking");
                    await this.writer.send({
                      event: "content_block_delta",
                      data: {
                        type: "content_block_delta",
                        index: currentBlockIndex,
                        delta: { type: "thinking_delta", thinking: event.content },
                      },
                    });
                  }
                }
              }
            }

            // 处理工具调用（增量累积）
            if (delta.tool_calls) {
              // 工具调用开始，先关闭当前的文本/思考块
              await closeCurrentBlock();

              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index;
                let toolCall = toolCallsAccumulator.get(index);

                if (!toolCall) {
                  // 初始化新的工具调用
                  toolCall = {
                    id: toolCallDelta.id || "",
                    type: "function",
                    function: {
                      name: "",
                      arguments: "",
                    },
                  };
                  toolCallsAccumulator.set(index, toolCall);
                }

                // 累积数据
                if (toolCallDelta.id) {
                  toolCall.id = toolCallDelta.id;
                }
                if (toolCallDelta.function?.name) {
                  toolCall.function.name = toolCallDelta.function.name;
                }
                if (toolCallDelta.function?.arguments) {
                  toolCall.function.arguments += toolCallDelta.function.arguments;
                }
              }
            }

            // 检查是否完成（finish_reason）
            if (choice.finish_reason === "tool_calls") {
              await closeCurrentBlock();
              // 工具调用完成，处理累积的工具调用
              if (toolCallsAccumulator.size > 0) {
                await this.handleAccumulatedToolCalls(toolCallsAccumulator);
                toolCallsAccumulator.clear();
              }
            } else if (choice.finish_reason === "stop") {
              // 正常结束，关闭文本块
              if (hasStartedTextBlock) {
                await this.writer.send({
                  event: "content_block_stop",
                  data: { type: "content_block_stop", index: currentBlockIndex },
                });
                currentBlockIndex++;
                hasStartedTextBlock = false;
              }

              await this.writer.send({
                event: "message_delta",
                data: {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 0 },
                },
              });
            }
          } catch (e) {
            log("error", `Failed to parse OpenAI stream chunk: ${dataStr}`, {
              requestId: this.requestId,
              error: e,
            });
          }
        }
      }

      // 发送 message_stop 事件
      await this.writer.send({
        event: "message_stop",
        data: { type: "message_stop" },
      });
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 处理累积的工具调用
   */
  private async handleAccumulatedToolCalls(
    toolCallsAccumulator: Map<number, OpenAIToolCall>,
  ): Promise<void> {
    const toolCalls = Array.from(toolCallsAccumulator.values());

    for (const openAIToolCall of toolCalls) {
      // 转换为 Anthropic 格式
      const anthropicToolUse = ToolFormatConverter.convertToolCallToAnthropic(openAIToolCall);

      // 判断是否为 Web 工具
      if (this.isWebTool(anthropicToolUse.name)) {
        // Web 工具：拦截并执行
        await this.handleWebToolCall(anthropicToolUse);
      } else {
        // 其他工具：发送给客户端
        await this.sendToolCallToClient(anthropicToolUse);
      }
    }
  }

  /**
   * 处理 Anthropic 格式的流式响应
   *
   * Anthropic SSE 格式：
   * event: message_start
   * data: {"type":"message_start","message":{...}}
   *
   * event: content_block_start
   * data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_xxx","name":"get_weather"}}
   *
   * event: content_block_delta
   * data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"location\""}}
   */
  private async handleAnthropicStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is null");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    let currentToolUse: ClaudeToolUseBlock | null = null;
    let toolInputBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("event: ")) {
            // 事件类型行，跳过
            continue;
          }

          if (!trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          try {
            const data = JSON.parse(dataStr);

            // 直接转发大部分事件
            if (
              data.type === "message_start" ||
              data.type === "message_delta" ||
              data.type === "message_stop"
            ) {
              await this.writer.send({
                event: data.type,
                data,
              });
              continue;
            }

            // 处理文本内容块
            if (
              data.type === "content_block_start" &&
              data.content_block?.type === "text"
            ) {
              await this.writer.send({ event: data.type, data });
              continue;
            }

            // 处理思考内容块 (Thinking Check)
            if (
              data.type === "content_block_start" &&
              data.content_block?.type === "thinking"
            ) {
              await this.writer.send({ event: data.type, data });
              continue;
            }

            // 处理思考内容增量
            if (
              data.type === "content_block_delta" &&
              data.delta?.type === "thinking_delta"
            ) {
              await this.writer.send({ event: data.type, data });
              continue;
            }

            if (
              data.type === "content_block_delta" &&
              data.delta?.type === "text_delta"
            ) {
              await this.writer.send({ event: data.type, data });
              continue;
            }

            if (data.type === "content_block_stop") {
              // 如果有累积的工具调用，处理它
              if (currentToolUse) {
                // 判断是否为 Web 工具
                if (this.isWebTool(currentToolUse.name)) {
                  await this.handleWebToolCall(currentToolUse);
                } else {
                  // 其他工具：发送 content_block_stop
                  await this.writer.send({ event: data.type, data });
                }

                currentToolUse = null;
                toolInputBuffer = "";
              } else {
                await this.writer.send({ event: data.type, data });
              }
              continue;
            }

            // 处理工具调用块
            if (
              data.type === "content_block_start" &&
              data.content_block?.type === "tool_use"
            ) {
              currentToolUse = {
                type: "tool_use",
                id: data.content_block.id,
                name: data.content_block.name,
                input: {}, // 稍后填充
              };
              toolInputBuffer = "";

              // 如果不是 Web 工具，转发给客户端
              if (!this.isWebTool(currentToolUse.name)) {
                await this.writer.send({ event: data.type, data });
              }
              continue;
            }

            if (
              data.type === "content_block_delta" &&
              data.delta?.type === "input_json_delta"
            ) {
              // 累积工具输入的 JSON
              toolInputBuffer += data.delta.partial_json;

              // 如果不是 Web 工具，转发给客户端
              if (currentToolUse && !this.isWebTool(currentToolUse.name)) {
                await this.writer.send({ event: data.type, data });
              }
              continue;
            }
          } catch (e) {
            log("error", `Failed to parse Anthropic stream chunk: ${dataStr}`, {
              requestId: this.requestId,
              error: e,
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 处理 Web 工具调用（拦截并执行）
   */
  private async handleWebToolCall(toolUse: ClaudeToolUseBlock): Promise<void> {
    log("info", `Intercepting web tool: ${toolUse.name}`, {
      requestId: this.requestId,
      toolName: toolUse.name,
      toolInput: toolUse.input,
    });

    // 发送 tool_use 事件
    await this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: toolUse,
      },
    });

    await this.writer.send({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });

    // 执行 Web 工具
    try {
      if (!this.interceptor) {
        const errorResult = `Web tool ${toolUse.name} is not available: no ToolInterceptor configured`;
        await this.sendToolResult(toolUse.id, errorResult);
        this.addToolCallToHistory(toolUse, errorResult);
        return;
      }

      if (toolUse.name === "web_search") {
        await this.handleWebSearch(toolUse);
      } else if (toolUse.name === "web_fetch") {
        await this.handleWebFetch(toolUse);
      } else {
        const result = `Unknown web tool: ${toolUse.name}`;
        await this.sendToolResult(toolUse.id, result);
        this.addToolCallToHistory(toolUse, result);
      }
    } catch (error) {
      log("error", "Web tool execution failed", {
        requestId: this.requestId,
        toolName: toolUse.name,
        error: String(error),
      });
      const errorResult = `Error executing ${toolUse.name}: ${String(error)}`;
      await this.sendToolResult(toolUse.id, errorResult);
      this.addToolCallToHistory(toolUse, errorResult);
    }
  }

  /**
   * 处理 Web Search
   */
  private async handleWebSearch(toolUse: ClaudeToolUseBlock): Promise<void> {
    const query = toolUse.input.query as string;
    const webSearchTool = this.webTools.find(t => t.name === "web_search");

    if (!webSearchTool || !query) {
      const errorResult = "Error: Invalid web_search parameters";
      await this.sendToolResult(toolUse.id, errorResult);
      this.addToolCallToHistory(toolUse, errorResult);
      return;
    }

    // 执行搜索
    const searchResult = await this.interceptor!.handleWebSearchWithQuery(
      webSearchTool as unknown as AnthropicWebSearchToolDefinition,
      query,
      this.requestId,
    );

    // 获取配置
    const config = this.context.getConfig();
    const webToolsConfig = config.webTools;
    const isSmartMode = webToolsConfig?.searchMode === "smart";

    if (isSmartMode) {
      // 智能模式：调用上游分析搜索结果
      await this.handleSmartSearchAnalysis(toolUse, searchResult, webSearchTool as unknown as AnthropicWebSearchToolDefinition);
    } else {
      // 简单模式：直接返回搜索结果
      const result = JSON.stringify(searchResult.toolResult.content);
      await this.sendToolResult(toolUse.id, result);
      this.addToolCallToHistory(toolUse, result);
    }
  }

  /**
   * 处理 Web Fetch
   */
  private async handleWebFetch(toolUse: ClaudeToolUseBlock): Promise<void> {
    const url = toolUse.input.url as string;
    const webFetchTool = this.webTools.find(t => t.name === "web_fetch");

    if (!webFetchTool || !url) {
      const errorResult = "Error: Invalid web_fetch parameters";
      await this.sendToolResult(toolUse.id, errorResult);
      this.addToolCallToHistory(toolUse, errorResult);
      return;
    }

    // 执行抓取
    const fetchResult = await this.interceptor!.handleWebFetch(
      webFetchTool as unknown as AnthropicWebFetchToolDefinition,
      url,
      this.requestId,
    );

    // 直接返回抓取结果
    const result = JSON.stringify(fetchResult.toolResult.content);
    await this.sendToolResult(toolUse.id, result);
    this.addToolCallToHistory(toolUse, result);
  }

  /**
   * 处理智能模式的搜索分析
   */
  private async handleSmartSearchAnalysis(
    toolUse: ClaudeToolUseBlock,
    searchResult: any,
    webSearchTool: AnthropicWebSearchToolDefinition,
  ): Promise<void> {
    const config = this.context.getConfig();
    const webToolsConfig = config.webTools!;
    const upstreamConfig = this.context.getUpstreamConfig();

    // 调用 doStreamAnalysis 进行流式分析
    await this.interceptor!.doStreamAnalysis(
      webSearchTool,
      searchResult,
      this.messageHistory,
      {
        baseUrl: upstreamConfig.baseUrl,
        apiKey: upstreamConfig.apiKey,
        model: upstreamConfig.model,
        protocol: upstreamConfig.protocol as "openai" | "anthropic",
      },
      this.requestId,
      async (text: string) => {
        // 流式输出分析文本
        await this.writer.send({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "text_delta",
              text,
            },
          },
        });
      },
    );

    // 智能模式不触发多轮调用，直接结束
    this.hasWebToolCalls = false;
  }

  /**
   * 发送工具结果事件
   */
  private async sendToolResult(toolUseId: string, result: string): Promise<void> {
    await this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result,
        },
      },
    });

    await this.writer.send({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    });
  }

  /**
   * 将工具调用和结果添加到消息历史
   */
  private addToolCallToHistory(toolUse: ClaudeToolUseBlock, result: string): void {
    this.hasWebToolCalls = true;

    // 1. 添加 assistant 消息（包含工具调用）
    this.messageHistory.push({
      role: "assistant",
      content: [toolUse],
    });

    // 2. 添加 user 消息（包含工具结果）
    this.messageHistory.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        },
      ],
    });
  }

  /**
   * 发送工具调用给客户端
   */
  private async sendToolCallToClient(toolUse: ClaudeToolUseBlock): Promise<void> {
    // 工具调用已在流中转发，无需额外处理
    // 这个方法主要用于 OpenAI 格式的工具调用
    log("info", `Sending tool call to client: ${toolUse.name}`, {
      requestId: this.requestId,
      toolName: toolUse.name,
    });

    await this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0, // 简化处理
        content_block: toolUse,
      },
    });

    await this.writer.send({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });
  }
}
