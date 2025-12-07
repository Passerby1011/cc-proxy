import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { TextAggregator } from "./aggregator.ts";
import { ProxyConfig } from "./config.ts";

interface StreamContext {
  requestId: string;
  aggregator: TextAggregator;
  writer: SSEWriter;
  nextBlockIndex: number;
  textBlockOpen: boolean;
  finished: boolean;
  totalOutputTokens: number;
}

export class ClaudeStream {
  private context: StreamContext;

  constructor(private writer: SSEWriter, config: ProxyConfig, requestId: string) {
    this.context = {
      requestId,
      writer,
      aggregator: new TextAggregator(config.aggregationIntervalMs, async (text) => await this.flushText(text)),
      nextBlockIndex: 0,
      textBlockOpen: false,
      finished: false,
      totalOutputTokens: 0,
    };
  }

  // 发送 message_start 事件（完全按照官方格式）
  async init() {
    await this.writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${this.context.requestId}`,
          type: "message",
          role: "assistant",
          model: "claude-proxy",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
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
        this.context.aggregator.add(event.content);
      } else if (event.type === "tool_call") {
        await this.context.aggregator.flushAsync();
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
    // 简单估算：每个字符约等于 0.25 个 token
    this.context.totalOutputTokens += Math.ceil(text.length * 0.25);
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

  private async emitToolCall(call: ParsedInvokeCall) {
    await this.endTextBlock();
    const index = this.context.nextBlockIndex++;
    const toolId = `toolu_${index}`;
    await this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
      },
    }, true);

    const inputJson = JSON.stringify(call.arguments);
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
    await this.writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.context.totalOutputTokens || 1,
        },
      },
    }, true);
    // 注意：虽然 ccr 会过滤 message_stop，但我们仍需发送它来标记流结束
    await this.writer.send({
      event: "message_stop",
      data: { type: "message_stop" },
    }, true);
  }
}
