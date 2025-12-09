import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { TextAggregator } from "./aggregator.ts";
import { ProxyConfig } from "./config.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";

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
}

export class ClaudeStream {
  private context: StreamContext;
  private tokenMultiplier: number;

  constructor(private writer: SSEWriter, config: ProxyConfig, requestId: string, inputTokens: number = 0) {
    this.context = {
      requestId,
      writer,
      aggregator: new TextAggregator(config.aggregationIntervalMs, async (text) => await this.flushText(text)),
      nextBlockIndex: 0,
      textBlockOpen: false,
      thinkingBlockOpen: false,
      finished: false,
      totalOutputTokens: 0,
    };
    // 对 tokenMultiplier 做防御性处理，避免后续出现 NaN/Infinity
    this.tokenMultiplier = Number.isFinite(config.tokenMultiplier) && config.tokenMultiplier > 0
      ? config.tokenMultiplier
      : 1.0;
    // 存储 input tokens 以便在 message_start 中使用
    (this.context as any).inputTokens = inputTokens;
  }

  // 发送 message_start 事件（完全按照官方格式）
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
          model: "claude-proxy",
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
        // 一旦开始输出可见文本，就不应该再继续向 thinking block 写入
        // 确保任何打开的 thinking block 在进入文本阶段之前先关闭
        if (this.context.thinkingBlockOpen) {
          await this.endThinkingBlock();
        }
        this.context.aggregator.add(event.content);
      } else if (event.type === "thinking") {
        // 思考内容前先把已有文本内容刷完并关闭 text block，避免 block 交叉复用 index
        await this.context.aggregator.flushAsync();
        await this.endTextBlock();
        await this.emitThinking(event.content);
      } else if (event.type === "tool_call") {
        // 工具调用前需要关闭所有打开的内容块（text/thinking），
        // 保证 tool_use block 的 index 不会和之前 block 复用
        await this.context.aggregator.flushAsync();
        await this.endTextBlock();
        await this.endThinkingBlock();
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
    // 使用 tiktoken 精确计算 token，然后应用倍数
    const estimatedTokens = countTokensWithTiktoken(text, "cl100k_base");
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
    // 使用 tiktoken 精确计算 token，然后应用倍数
    const estimatedTokens = countTokensWithTiktoken(content, "cl100k_base");
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
    
    // 应用 token 倍数到输出 token，防止出现 NaN/0
    const raw = this.context.totalOutputTokens * this.tokenMultiplier;
    const adjustedOutputTokens = Math.max(
      1,
      Math.ceil(
        Number.isFinite(raw)
          ? raw
          : this.context.totalOutputTokens || 1,
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
    // 注意：虽然 ccr 会过滤 message_stop，但我们仍需发送它来标记流结束
    await this.writer.send({
      event: "message_stop",
      data: { type: "message_stop" },
    }, true);
  }
}
