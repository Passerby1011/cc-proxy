import { SSEWriter } from "../sse.ts";
import { RequestContext } from "../ai_client/mod.ts";
import { log, LogPhase, logPhase } from "../logging.ts";
import { type OpenAIToolCall, ToolFormatConverter } from "./tool_format_converter.ts";
import { ToolInterceptor } from "./tool_interceptor.ts";
import type { ClaudeMessage, ClaudeToolDefinition } from "../types.ts";
import type { AnthropicWebSearchToolDefinition, SearchInterceptResult, UpstreamInfo } from "./types.ts";
import { isAnthropicWebFetchTool, isAnthropicWebSearchTool } from "./types.ts";

type WebToolKind = "web_search" | "web_fetch";

interface DetectedWebToolCall {
  id: string;
  kind: WebToolKind;
  input: Record<string, unknown>;
}

interface OpenAIStreamToolMeta {
  kind: "function" | "web_search" | "web_fetch";
  name: string;
  arguments: string;
  payload: Record<string, unknown>;
}

export class NativeToolCallStreamHandler {
  private requestId: string;
  private messageHistory: ClaudeMessage[];
  private hasPendingFollowUp = false;
  private streamStarted = false;
  private forceEndTurn = false;
  private nextInlineBlockIndex = 1_000_000;

  constructor(
    private context: RequestContext,
    private writer: SSEWriter,
    private webTools: ClaudeToolDefinition[],
    private interceptor: ToolInterceptor | null,
    initialMessages?: ClaudeMessage[],
  ) {
    this.requestId = context.getRequestId();
    this.messageHistory = initialMessages || [...context.getOriginalRequest().messages];
  }

  hasWebToolCallsToProcess(): boolean {
    return this.hasPendingFollowUp;
  }

  getMessageHistory(): ClaudeMessage[] {
    return this.messageHistory;
  }

  async handleStream(response: Response): Promise<boolean> {
    this.hasPendingFollowUp = false;
    this.forceEndTurn = false;
    const protocol = this.context.getUpstreamConfig().protocol;
    logPhase(this.requestId, LogPhase.STREAM, "Starting native tool call stream handler", {
      protocol,
      webToolsCount: this.webTools.length,
      historyMessages: this.messageHistory.length,
      hasInterceptor: !!this.interceptor,
    });

    if (protocol === "anthropic") {
      this.hasPendingFollowUp = await this.handleAnthropicStream(response);
      return this.hasPendingFollowUp;
    }
    if (protocol === "openai" || protocol === "openai-responses") {
      this.hasPendingFollowUp = await this.handleOpenAICompatibleStream(response, protocol);
      return this.hasPendingFollowUp;
    }

    throw new Error(`Unsupported protocol for native tool calling: ${protocol}`);
  }

  private resolveWebKindByToolName(name: string | undefined): WebToolKind | undefined {
    if (!name) return undefined;
    if (name === "web_search" || name === "web_search_preview" || name === "web_search_20250305") {
      return "web_search";
    }
    if (name === "web_fetch" || name === "web_fetch_preview" || name === "web_fetch_20250910") {
      return "web_fetch";
    }
    return undefined;
  }

  private getSearchToolDefinition(): AnthropicWebSearchToolDefinition {
    const found = this.webTools.find((tool) => isAnthropicWebSearchTool(tool));
    if (found) return found as AnthropicWebSearchToolDefinition;
    return {
      type: "web_search_20250305",
      name: "web_search",
    };
  }

  private getFetchToolDefinition(): Record<string, unknown> {
    const found = this.webTools.find((tool) => isAnthropicWebFetchTool(tool));
    if (found) return found as Record<string, unknown>;
    return {
      type: "web_fetch_20250910",
      name: "web_fetch",
    };
  }

  private getAssistantToolName(kind: WebToolKind): string {
    const protocol = this.context.getUpstreamConfig().protocol;
    if (protocol === "openai" || protocol === "openai-responses") {
      return kind === "web_search" ? "web_search_preview" : "web_fetch";
    }
    return kind;
  }

  private getUpstreamInfo(): UpstreamInfo {
    const upstreamConfig = this.context.getUpstreamConfig();
    return {
      baseUrl: upstreamConfig.baseUrl,
      apiKey: upstreamConfig.apiKey,
      model: upstreamConfig.model,
      protocol: upstreamConfig.protocol as "openai" | "openai-responses" | "anthropic",
    };
  }

  private buildEffectiveSearchDefinition(input: Record<string, unknown>): AnthropicWebSearchToolDefinition {
    const baseDefinition = this.getSearchToolDefinition();
    const filters = (input.filters && typeof input.filters === "object")
      ? input.filters as Record<string, unknown>
      : undefined;

    return {
      ...baseDefinition,
      allowed_domains: Array.isArray(input.allowed_domains)
        ? input.allowed_domains as string[]
        : Array.isArray(input.domains)
        ? input.domains as string[]
        : Array.isArray(filters?.allowed_domains)
        ? filters.allowed_domains as string[]
        : baseDefinition.allowed_domains,
      blocked_domains: Array.isArray(input.blocked_domains)
        ? input.blocked_domains as string[]
        : Array.isArray(filters?.blocked_domains)
        ? filters.blocked_domains as string[]
        : baseDefinition.blocked_domains,
    };
  }

  private allocateInlineBlockIndex(): number {
    return this.nextInlineBlockIndex++;
  }

  private async streamSmartAnalysisInline(
    tool: AnthropicWebSearchToolDefinition,
    searchResult: SearchInterceptResult,
  ): Promise<void> {
    if (!this.interceptor) return;

    const index = this.allocateInlineBlockIndex();
    await this.writer.send({
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

    await this.interceptor.doStreamAnalysis(
      tool,
      searchResult,
      this.messageHistory,
      this.getUpstreamInfo(),
      this.requestId,
      async (textChunk) => {
        if (!textChunk || this.writer.isClosed()) return;
        await this.writer.send({
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
      },
    );

    await this.writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });
  }

  private async processRoundWebToolCalls(
    webToolCalls: DetectedWebToolCall[],
    hasNonWebToolCall: boolean,
  ): Promise<boolean> {
    if (webToolCalls.length === 0) return false;

    if (hasNonWebToolCall) {
      log("warn", "Skip auto web interception due to mixed tool calls", {
        requestId: this.requestId,
        webToolCalls: webToolCalls.length,
      });
      return false;
    }

    if (!this.interceptor) {
      log("warn", "Skip auto web interception because ToolInterceptor is missing", {
        requestId: this.requestId,
        webToolCalls: webToolCalls.length,
      });
      return false;
    }

    const canUseSmartSearch = this.interceptor.isSmartSearchMode() &&
      webToolCalls.length === 1 &&
      webToolCalls[0].kind === "web_search";
    const assistantToolUses: Array<Record<string, unknown>> = [];
    const toolResults: Array<Record<string, unknown>> = [];

    for (const toolCall of webToolCalls) {
      const toolId = toolCall.id;
      try {
        if (toolCall.kind === "web_search") {
          const query = typeof toolCall.input.query === "string" ? toolCall.input.query : "";
          if (!query) {
            throw new Error("Missing query for web_search");
          }

          const effectiveDefinition = this.buildEffectiveSearchDefinition(toolCall.input);

          const searchResult = await this.interceptor.handleWebSearchWithQuery(
            effectiveDefinition,
            query,
            this.requestId,
          );

          if (canUseSmartSearch) {
            try {
              await this.streamSmartAnalysisInline(effectiveDefinition, searchResult);
              this.forceEndTurn = true;
              logPhase(this.requestId, LogPhase.TOOL_INTERCEPT, "Applied smart web_search interception", {
                queryLength: query.length,
                deepBrowseEnabled: this.context.getConfig().webTools?.deepBrowseEnabled ?? false,
              });
              continue;
            } catch (error) {
              log("warn", "Smart web_search interception failed, fallback to closed-loop tool_result", {
                requestId: this.requestId,
                error: String(error),
              });
              this.forceEndTurn = false;
            }
          }

          assistantToolUses.push({
            type: "tool_use",
            id: toolId,
            name: this.getAssistantToolName("web_search"),
            input: toolCall.input,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolId,
            content: JSON.stringify(searchResult.toolResult.content),
          });
          continue;
        }

        const url = typeof toolCall.input.url === "string" ? toolCall.input.url : "";
        if (!url) {
          throw new Error("Missing url for web_fetch");
        }

        const fetchResult = await this.interceptor.handleWebFetch(
          this.getFetchToolDefinition() as any,
          url,
          this.requestId,
        );

        assistantToolUses.push({
          type: "tool_use",
          id: toolId,
          name: this.getAssistantToolName("web_fetch"),
          input: toolCall.input,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolId,
          content: JSON.stringify(fetchResult.toolResult.content),
        });
      } catch (error) {
        log("error", "Native stream web tool auto interception failed", {
          requestId: this.requestId,
          toolId,
          kind: toolCall.kind,
          error: String(error),
        });
        assistantToolUses.push({
          type: "tool_use",
          id: toolId,
          name: this.getAssistantToolName(toolCall.kind),
          input: toolCall.input,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolId,
          content: `Error executing ${toolCall.kind}: ${String(error)}`,
        });
      }
    }

    if (this.forceEndTurn) {
      return false;
    }

    if (assistantToolUses.length === 0 || toolResults.length === 0) {
      return false;
    }

    this.messageHistory.push({
      role: "assistant",
      content: assistantToolUses as any,
    });
    this.messageHistory.push({
      role: "user",
      content: toolResults as any,
    });

    logPhase(this.requestId, LogPhase.TOOL_INTERCEPT, "Auto intercepted native web tool calls", {
      count: webToolCalls.length,
      historyMessages: this.messageHistory.length,
    });

    return true;
  }

  private async handleAnthropicStream(response: Response): Promise<boolean> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is null");

    const decoder = new TextDecoder();
    let buffer = "";
    const completedWebToolCalls = new Map<string, DetectedWebToolCall>();
    const trackedWebBlocks = new Map<number, { id: string; kind: WebToolKind; rawJson: string; input: Record<string, unknown> }>();
    const webToolIdsWithResults = new Set<string>();
    const terminalEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    let hasNonWebToolCall = false;

    logPhase(this.requestId, LogPhase.STREAM, "Proxying Anthropic native stream", {
      protocol: "anthropic",
      webToolsCount: this.webTools.length,
    });

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

          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            const eventType = typeof data.type === "string" ? data.type : "message";
            const block = data.content_block as Record<string, unknown> | undefined;
            const blockIndex = typeof data.index === "number" ? data.index : undefined;

            if (
              eventType === "content_block_start" &&
              block &&
              (block.type === "server_tool_use" || block.type === "tool_use")
            ) {
              const name = typeof block.name === "string" ? block.name : undefined;
              const kind = this.resolveWebKindByToolName(name);
              if (kind && blockIndex !== undefined) {
                trackedWebBlocks.set(blockIndex, {
                  id: typeof block.id === "string" ? block.id : `tool_${crypto.randomUUID()}`,
                  kind,
                  rawJson: "",
                  input: {},
                });
              } else if (block.type === "tool_use") {
                hasNonWebToolCall = true;
              }
            }

            if (
              eventType === "content_block_start" &&
              block &&
              (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result")
            ) {
              if (typeof block.tool_use_id === "string") {
                webToolIdsWithResults.add(block.tool_use_id);
              }
            }

            if (eventType === "content_block_delta" && blockIndex !== undefined) {
              const tracked = trackedWebBlocks.get(blockIndex);
              const delta = data.delta as Record<string, unknown> | undefined;
              if (tracked && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                tracked.rawJson += delta.partial_json;
                try {
                  tracked.input = JSON.parse(tracked.rawJson);
                } catch {
                  tracked.input = tracked.input ?? {};
                }
              }
            }

            if (eventType === "content_block_stop" && blockIndex !== undefined) {
              const tracked = trackedWebBlocks.get(blockIndex);
              if (tracked) {
                completedWebToolCalls.set(tracked.id, {
                  id: tracked.id,
                  kind: tracked.kind,
                  input: tracked.input ?? {},
                });
                trackedWebBlocks.delete(blockIndex);
              }
            }

            if (eventType === "message_delta" || eventType === "message_stop") {
              terminalEvents.push({ event: eventType, data });
              continue;
            }

            if (eventType === "message_start") {
              if (this.streamStarted) continue;
              this.streamStarted = true;
            }

            await this.writer.send({ event: eventType, data });
          } catch (error) {
            log("error", "Failed to parse anthropic native stream chunk", {
              requestId: this.requestId,
              error,
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const webToolCalls = [...completedWebToolCalls.values()].filter((call) =>
      !webToolIdsWithResults.has(call.id)
    );
    const shouldContinue = await this.processRoundWebToolCalls(webToolCalls, hasNonWebToolCall);
    if (shouldContinue) return true;

    if (this.forceEndTurn) {
      await this.writer.send({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 0 },
        },
      });
      await this.writer.send({
        event: "message_stop",
        data: { type: "message_stop" },
      });
      return false;
    }

    for (const terminal of terminalEvents) {
      await this.writer.send(terminal);
    }
    return false;
  }

  private async handleOpenAICompatibleStream(
    response: Response,
    protocol: "openai" | "openai-responses",
  ): Promise<boolean> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is null");

    const decoder = new TextDecoder();
    let buffer = "";
    let legacyTextItemId: string | null = null;
    let nextBlockIndex = 0;
    let emittedToolCall = false;
    let hasNonWebToolCall = false;
    const roundWebToolCalls: DetectedWebToolCall[] = [];
    const recordedWebToolIds = new Set<string>();

    const toolCalls = new Map<number, OpenAIToolCall>();
    const itemToBlockIndex = new Map<string, number>();
    const outputIndexToItemId = new Map<number, string>();
    const textByItemId = new Map<string, string>();
    const toolMeta = new Map<string, OpenAIStreamToolMeta>();

    logPhase(this.requestId, LogPhase.STREAM, "Proxying OpenAI-compatible native stream", {
      protocol,
      webToolsCount: this.webTools.length,
    });

    const ensureMessageStart = async () => {
      if (this.streamStarted) return;
      await this.writer.send({
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: `msg_${this.requestId}`,
            type: "message",
            role: "assistant",
            model: this.context.getModel(),
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      });
      this.streamStarted = true;
    };

    const resolveItemId = (data: Record<string, any>): string | undefined => {
      if (typeof data.item_id === "string") return data.item_id;
      if (typeof data.output_index === "number") return outputIndexToItemId.get(data.output_index);
      return undefined;
    };

    const ensureTextBlock = async (itemId: string): Promise<number> => {
      const existingIndex = itemToBlockIndex.get(itemId);
      if (existingIndex !== undefined) return existingIndex;

      const blockIndex = nextBlockIndex++;
      itemToBlockIndex.set(itemId, blockIndex);
      textByItemId.set(itemId, textByItemId.get(itemId) ?? "");
      await this.writer.send({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        },
      });
      return blockIndex;
    };

    const appendText = async (itemId: string, text: string) => {
      if (!text) return;
      const blockIndex = await ensureTextBlock(itemId);
      textByItemId.set(itemId, `${textByItemId.get(itemId) ?? ""}${text}`);
      await this.writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        },
      });
    };

    const ensureLegacyTextBlock = async () => {
      if (!legacyTextItemId) {
        legacyTextItemId = `text_${this.requestId}`;
      }
      return await ensureTextBlock(legacyTextItemId);
    };

    const finalizeText = async (itemId: string, finalText?: string) => {
      const blockIndex = itemToBlockIndex.get(itemId);
      if (finalText && finalText !== textByItemId.get(itemId)) {
        const previous = textByItemId.get(itemId) ?? "";
        const delta = finalText.startsWith(previous) ? finalText.slice(previous.length) : finalText;
        await appendText(itemId, delta);
      }
      if (blockIndex === undefined) return;
      await this.writer.send({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: blockIndex },
      });
      itemToBlockIndex.delete(itemId);
      textByItemId.delete(itemId);
      if (legacyTextItemId === itemId) {
        legacyTextItemId = null;
      }
    };

    const ensureToolBlock = async (
      itemId: string,
      kind: "function" | "web_search" | "web_fetch",
      name: string,
    ): Promise<number> => {
      const existingIndex = itemToBlockIndex.get(itemId);
      if (existingIndex !== undefined) return existingIndex;

      const blockIndex = nextBlockIndex++;
      itemToBlockIndex.set(itemId, blockIndex);
      toolMeta.set(itemId, {
        kind,
        name,
        arguments: toolMeta.get(itemId)?.arguments ?? "",
        payload: toolMeta.get(itemId)?.payload ?? {},
      });
      logPhase(this.requestId, LogPhase.TOOL, "Detected native tool call", {
        protocol,
        itemId,
        kind,
        name,
      });
      await this.writer.send({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: blockIndex,
          content_block: kind === "function"
            ? { type: "tool_use", id: itemId, name, input: {} }
            : { type: "server_tool_use", id: itemId, name, input: {} },
        },
      });
      return blockIndex;
    };

    const appendToolDelta = async (itemId: string, delta: string) => {
      const meta = toolMeta.get(itemId);
      const blockIndex = itemToBlockIndex.get(itemId);
      if (!meta || blockIndex === undefined || !delta) return;
      meta.arguments += delta;
      try {
        meta.payload = JSON.parse(meta.arguments || "{}");
      } catch {
      }
      await this.writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: delta,
          },
        },
      });
    };

    const finalizeTool = async (
      itemId: string,
      finalArguments?: string,
      extraPayload?: Record<string, unknown>,
    ) => {
      const meta = toolMeta.get(itemId);
      const blockIndex = itemToBlockIndex.get(itemId);
      if (!meta || blockIndex === undefined) return;

      if (
        typeof finalArguments === "string" && finalArguments.length > 0 &&
        finalArguments !== meta.arguments
      ) {
        const delta = finalArguments.startsWith(meta.arguments)
          ? finalArguments.slice(meta.arguments.length)
          : finalArguments;
        await appendToolDelta(itemId, delta);
        meta.arguments = finalArguments;
      }

      if (extraPayload) {
        meta.payload = { ...meta.payload, ...extraPayload };
      }

      logPhase(this.requestId, LogPhase.TOOL_RESULT, "Completed native tool call", {
        protocol,
        itemId,
        kind: meta.kind,
        name: meta.name,
        hasResults: Array.isArray((meta.payload as { results?: unknown[] }).results),
        hasContent: Array.isArray((meta.payload as { content?: unknown[] }).content),
      });

      await this.writer.send({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: blockIndex },
      });

      if (meta.kind === "web_search" && Array.isArray(meta.payload.results)) {
        const resultIndex = nextBlockIndex++;
        await this.writer.send({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: resultIndex,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: itemId,
              content: meta.payload.results,
            },
          },
        });
        await this.writer.send({
          event: "content_block_stop",
          data: { type: "content_block_stop", index: resultIndex },
        });
      }

      if (meta.kind === "web_fetch" && Array.isArray(meta.payload.content)) {
        const resultIndex = nextBlockIndex++;
        await this.writer.send({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: resultIndex,
            content_block: {
              type: "web_fetch_tool_result",
              tool_use_id: itemId,
              content: meta.payload.content,
            },
          },
        });
        await this.writer.send({
          event: "content_block_stop",
          data: { type: "content_block_stop", index: resultIndex },
        });
      }

      itemToBlockIndex.delete(itemId);
      toolMeta.delete(itemId);
      emittedToolCall = true;

      if (meta.kind === "function") {
        hasNonWebToolCall = true;
      } else if (!recordedWebToolIds.has(itemId)) {
        const hasEmbeddedResults = meta.kind === "web_search"
          ? Array.isArray(meta.payload.results)
          : Array.isArray(meta.payload.content);
        if (!hasEmbeddedResults) {
          roundWebToolCalls.push({
            id: itemId,
            kind: meta.kind,
            input: meta.payload ?? {},
          });
          recordedWebToolIds.add(itemId);
        }
      }
    };

    const closeLegacyTextBlock = async () => {
      if (!legacyTextItemId) return;
      await finalizeText(legacyTextItemId);
    };

    const flushToolCalls = async () => {
      if (toolCalls.size === 0) return;
      await closeLegacyTextBlock();

      for (const toolCall of toolCalls.values()) {
        const toolUse = ToolFormatConverter.convertToolCallToAnthropic(toolCall);
        const itemId = toolUse.id;
        const webKind = this.resolveWebKindByToolName(toolUse.name);
        if (webKind) {
          await ensureToolBlock(itemId, webKind, webKind);
        } else {
          await ensureToolBlock(itemId, "function", toolUse.name);
        }
        await appendToolDelta(itemId, JSON.stringify(toolUse.input ?? {}));
        await finalizeTool(itemId);
      }

      toolCalls.clear();
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
          if (dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);
            await ensureMessageStart();

            if (protocol === "openai") {
              const choice = data.choices?.[0];
              const delta = choice?.delta;
              if (delta?.content) {
                const index = await ensureLegacyTextBlock();
                await this.writer.send({
                  event: "content_block_delta",
                  data: {
                    type: "content_block_delta",
                    index,
                    delta: { type: "text_delta", text: delta.content },
                  },
                });
              }

              if (Array.isArray(delta?.tool_calls)) {
                for (const toolCallDelta of delta.tool_calls) {
                  const index = toolCallDelta.index ?? 0;
                  const existing = toolCalls.get(index) ?? {
                    id: toolCallDelta.id || `call_${index}`,
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                  if (toolCallDelta.id) existing.id = toolCallDelta.id;
                  if (toolCallDelta.function?.name) {
                    existing.function.name = toolCallDelta.function.name;
                  }
                  if (toolCallDelta.function?.arguments) {
                    existing.function.arguments += toolCallDelta.function.arguments;
                  }
                  toolCalls.set(index, existing);
                }
              }

              if (choice?.finish_reason === "tool_calls") {
                await flushToolCalls();
              }
              if (choice?.finish_reason === "stop") {
                await closeLegacyTextBlock();
              }
            } else {
              if (data.type === "response.created") {
                continue;
              }

              if (data.type === "response.output_item.added") {
                const outputIndex = typeof data.output_index === "number" ? data.output_index : 0;
                const item = data.item ?? {};
                const itemId = item.id || item.call_id || `item_${outputIndex}`;
                outputIndexToItemId.set(outputIndex, itemId);

                if (item.type === "message") {
                  const initialText = Array.isArray(item.content)
                    ? item.content
                      .filter((part: Record<string, unknown>) => part.type === "output_text")
                      .map((part: Record<string, unknown>) => String(part.text ?? ""))
                      .join("")
                    : "";
                  if (initialText) {
                    await appendText(itemId, initialText);
                  }
                }

                if (item.type === "function_call") {
                  const webKind = this.resolveWebKindByToolName(item.name);
                  if (webKind) {
                    await ensureToolBlock(itemId, webKind, webKind);
                  } else {
                    await ensureToolBlock(itemId, "function", item.name || "function");
                  }
                  if (item.arguments) {
                    await appendToolDelta(itemId, item.arguments);
                  }
                }

                if (item.type === "web_search_call") {
                  await ensureToolBlock(itemId, "web_search", "web_search");
                  const payload = JSON.stringify({ query: item.query ?? "" });
                  if (payload !== "{}") {
                    await appendToolDelta(itemId, payload);
                  }
                }

                if (item.type === "web_fetch_call") {
                  await ensureToolBlock(itemId, "web_fetch", "web_fetch");
                  const payload = JSON.stringify({ url: item.url ?? "" });
                  if (payload !== "{}") {
                    await appendToolDelta(itemId, payload);
                  }
                }
              }

              if (data.type === "response.output_text.delta") {
                const itemId = resolveItemId(data);
                if (itemId) {
                  await appendText(itemId, data.delta || "");
                }
              }

              if (data.type === "response.output_text.done") {
                const itemId = resolveItemId(data);
                if (itemId) {
                  await finalizeText(itemId, data.text);
                }
              }

              if (data.type === "response.function_call_arguments.delta") {
                const itemId = resolveItemId(data);
                if (itemId) {
                  await appendToolDelta(itemId, data.delta || "");
                }
              }

              if (data.type === "response.function_call_arguments.done") {
                const itemId = resolveItemId(data);
                if (itemId) {
                  await finalizeTool(itemId, data.arguments);
                }
              }

              if (data.type === "response.output_item.done") {
                const item = data.item ?? {};
                const itemId = item.id || item.call_id || resolveItemId(data);
                if (itemId && item.type === "message") {
                  const finalText = Array.isArray(item.content)
                    ? item.content
                      .filter((part: Record<string, unknown>) => part.type === "output_text")
                      .map((part: Record<string, unknown>) => String(part.text ?? ""))
                      .join("")
                    : undefined;
                  await finalizeText(itemId, finalText);
                }

                if (itemId && item.type === "function_call") {
                  await finalizeTool(itemId, item.arguments);
                }

                if (itemId && item.type === "web_search_call") {
                  await finalizeTool(itemId, undefined, {
                    query: item.query,
                    results: item.results,
                  });
                }

                if (itemId && item.type === "web_fetch_call") {
                  await finalizeTool(itemId, undefined, {
                    url: item.url,
                    content: item.content,
                  });
                }
              }

              if (data.type === "response.completed") {
                for (const [itemId] of [...textByItemId.entries()]) {
                  await finalizeText(itemId);
                }
                for (const [itemId] of [...toolMeta.entries()]) {
                  await finalizeTool(itemId);
                }
              }
            }
          } catch (error) {
            log("error", "Failed to parse openai native stream chunk", {
              requestId: this.requestId,
              protocol,
              error,
            });
          }
        }
      }

      if (protocol === "openai") {
        await closeLegacyTextBlock();
        await flushToolCalls();
      } else {
        for (const [itemId] of [...textByItemId.entries()]) {
          await finalizeText(itemId);
        }
        for (const [itemId] of [...toolMeta.entries()]) {
          await finalizeTool(itemId);
        }
      }

      logPhase(this.requestId, LogPhase.STREAM, "Native tool call stream handler finished", {
        protocol,
        emittedToolCall,
        remainingTextBlocks: textByItemId.size,
        remainingToolBlocks: toolMeta.size,
      });

      const shouldContinue = await this.processRoundWebToolCalls(roundWebToolCalls, hasNonWebToolCall);
      if (shouldContinue) {
        return true;
      }

      const stopReason = this.forceEndTurn
        ? "end_turn"
        : (emittedToolCall ? "tool_use" : "end_turn");
      await this.writer.send({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 0 },
        },
      });
      await this.writer.send({
        event: "message_stop",
        data: { type: "message_stop" },
      });
      return false;
    } finally {
      reader.releaseLock();
    }
  }
}
