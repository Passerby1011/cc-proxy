import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { TextAggregator } from "./aggregator.ts";
import { ProxyConfig } from "./config.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";

// 工具拦截回调类型
export type ToolInterceptCallback = (toolCall: ParsedInvokeCall, writer: SSEWriter) => Promise<boolean>;

function generateToolId(): string {
  // 生成随机 ID：toolu_ + 12位随机字符
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'toolu_';
  for (let i = 0; i < 12; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

interface StreamContext {
  requestId: string;
  aggregator: TextAggregator;
  writer: SSEWriter;
  nextBlockIndex: number;
  textBlockOpen: boolean;
  thinkingBlockOpen: boolean;
  finished: boolean;
  totalOutputTokens: number;
  outputBuffer: string; // 用于最后一次性精确计算
  model: string; // 用于显示和计费
}

export class ClaudeStream {
  private context: StreamContext;
  private tokenMultiplier: number;
  private toolInterceptCallback?: ToolInterceptCallback; // 工具拦截回调

  constructor(
    private writer: SSEWriter,
    config: ProxyConfig,
    requestId: string,
    inputTokens: number = 0,
    model: string = "claude-3-5-sonnet-20241022",
    toolInterceptCallback?: ToolInterceptCallback
  ) {
    this.context = {
      requestId,
      writer,
      aggregator: new TextAggregator(config.aggregationIntervalMs, async (text) => await this.flushText(text)),
      nextBlockIndex: 0,
      textBlockOpen: false,
      thinkingBlockOpen: false,
      finished: false,
      totalOutputTokens: 0,
      outputBuffer: "",
      model,
    };
    this.tokenMultiplier = Number.isFinite(config.tokenMultiplier) && config.tokenMultiplier > 0
      ? config.tokenMultiplier
      : 1.0;
    (this.context as any).inputTokens = inputTokens;
    this.toolInterceptCallback = toolInterceptCallback;
  }

  getTotalOutputTokens(): number {
    return this.context.totalOutputTokens;
  }

  async init() {
    const inputTokens = (this.context as any).inputTokens || 0;
    await this.writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${this.context.requestId}`,
          type: "message",
          role: "assistant",
          model: this.context.model, // 使用真实模型名，不再硬编码
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
          },
          content: [],
          stop_reason: null,
        },
      },
    }, true);
  }

  async handleEvents(events: ParserEvent[]) {
    for (const event of events) {
      if (event.type === "text") {
        if (this.context.thinkingBlockOpen) {
          await this.endThinkingBlock();
        }
        this.context.aggregator.add(event.content);
      } else if (event.type === "thinking") {
        await this.context.aggregator.flushAsync();
        await this.endTextBlock();
        await this.emitThinking(event.content);
      } else if (event.type === "tool_call") {
        await this.context.aggregator.flushAsync();
        await this.endTextBlock();
        await this.endThinkingBlock();

        // 如果有工具拦截回调，先尝试拦截
        if (this.toolInterceptCallback) {
          const intercepted = await this.toolInterceptCallback(event.call, this.writer);
          if (intercepted) {
            // 工具调用已被拦截并处理，跳过默认发送
            continue;
          }
        }

        // 未被拦截，正常发送工具调用
        await this.emitToolCall(event.call);
      } else if (event.type === "end") {
        await this.finish();
      }
    }
  }

  private async ensureTextBlock() {
    if (!this.context.textBlockOpen) {
      const index = this.context.nextBlockIndex++;
      this.context.textBlockOpen = true;
      await this.writer.send({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      }, true);
    }
  }

  private async flushText(text: string) {
    if (!text) return;
    await this.ensureTextBlock();
    // 累加到 buffer
    this.context.outputBuffer += text;
    // 临时估算以便实时显示（非精确，finish 时会修正）
    const estimatedTokens = countTokensWithTiktoken(text, this.context.model);
    this.context.totalOutputTokens += estimatedTokens;
    await this.writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.context.nextBlockIndex - 1,
        delta: { type: "text_delta", text },
      },
    }, false);
  }

  private async endTextBlock() {
    if (!this.context.textBlockOpen) return;
    this.context.textBlockOpen = false;
    const index = this.context.nextBlockIndex - 1;
    await this.writer.send({
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    }, true);
  }

  private async ensureThinkingBlock() {
    if (!this.context.thinkingBlockOpen) {
      const index = this.context.nextBlockIndex++;
      this.context.thinkingBlockOpen = true;
      await this.writer.send({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        },
      }, true);
    }
  }

  private async endThinkingBlock() {
    if (!this.context.thinkingBlockOpen) return;
    this.context.thinkingBlockOpen = false;
    const index = this.context.nextBlockIndex - 1;
    await this.writer.send({
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    }, true);
  }

  private async emitThinking(content: string) {
    if (!content) return;
    await this.ensureThinkingBlock();
    // 累加到 buffer
    this.context.outputBuffer += content;
    const estimatedTokens = countTokensWithTiktoken(content, this.context.model);
    this.context.totalOutputTokens += estimatedTokens;
    await this.writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.context.nextBlockIndex - 1,
        delta: { type: "thinking_delta", thinking: content },
      },
    }, false);
  }

  private async emitToolCall(call: ParsedInvokeCall) {
    await this.endTextBlock();
    const index = this.context.nextBlockIndex++;
    const toolId = generateToolId();
    await this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
      },
    }, true);

    const inputJson = JSON.stringify(call.arguments);
    // 工具调用也计入 buffer 和统计
    this.context.outputBuffer += inputJson;
    this.context.totalOutputTokens += countTokensWithTiktoken(inputJson, this.context.model);

    await this.writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: inputJson },
      },
    }, true);

    await this.writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    }, true);
  }

  private async finish() {
    if (this.context.finished) return;
    this.context.finished = true;
    await this.context.aggregator.flushAsync();
    await this.endTextBlock();
    await this.endThinkingBlock();

    // 最后进行一次精确的全量重新计算，解决分段计分偏高的问题
    const exactTotalTokens = countTokensWithTiktoken(this.context.outputBuffer, this.context.model);
    this.context.totalOutputTokens = exactTotalTokens;
    
    const raw = exactTotalTokens * this.tokenMultiplier;
    const adjustedOutputTokens = Math.max(
      1,
      Math.ceil(
        Number.isFinite(raw)
          ? raw
          : exactTotalTokens || 1,
      ),
    );
    
    await this.writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: adjustedOutputTokens,
        },
      },
    }, true);
    await this.writer.send({
      event: "message_stop",
      data: { type: "message_stop" },
    }, true);
  }
}
