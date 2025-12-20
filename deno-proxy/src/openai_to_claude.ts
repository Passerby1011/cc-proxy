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

function splitIntoChunks(text: string, maxChunkSize = 50): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    // 优先在句子边界处分割
    let end = start + maxChunkSize;
    if (end >= text.length) {
      end = text.length;
    } else {
      // 向后查找句子边界（句号、问号、感叹号、换行符）
      const sentenceBoundaries = ['.', '?', '!', '\n', '。', '？', '！'];
      for (let i = end; i > start; i--) {
        if (sentenceBoundaries.includes(text[i])) {
          end = i + 1;
          break;
        }
      }
      // 如果没有找到句子边界，则查找逗号、分号、空格
      if (end === start + maxChunkSize) {
        const wordBoundaries = [',', ';', ' '];
        for (let i = end; i > start; i--) {
          if (wordBoundaries.includes(text[i])) {
            end = i + 1;
            break;
          }
        }
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function splitJsonIntoChunks(json: string, maxChunkSize = 30): string[] {
  const chunks: string[] = [];
  let start = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
    }
    // 在引号外且遇到 JSON 结构字符时考虑分割
    if (!inString && (ch === '{' || ch === '}' || ch === ',' || ch === ':')) {
      // 检查是否达到最小块大小
      if (i - start >= maxChunkSize) {
        chunks.push(json.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  // 剩余部分
  if (start < json.length) {
    chunks.push(json.slice(start));
  }
  // 如果没有任何分割，则按固定大小分割（但避免在引号内分割）
  if (chunks.length === 0) {
    let s = 0;
    while (s < json.length) {
      let e = s + maxChunkSize;
      if (e >= json.length) {
        e = json.length;
      } else {
        // 如果 e 在引号内，向后调整到引号外
        let inStr = false;
        let esc = false;
        for (let j = s; j < e; j++) {
          if (esc) {
            esc = false;
            continue;
          }
          if (json[j] === '\\') {
            esc = true;
            continue;
          }
          if (json[j] === '"') {
            inStr = !inStr;
          }
        }
        if (inStr) {
          // 找到下一个引号结束位置
          while (e < json.length && (json[e] !== '"' || esc)) {
            if (json[e] === '\\') {
              esc = !esc;
            } else {
              esc = false;
            }
            e++;
          }
          if (e < json.length) e++;
        }
      }
      chunks.push(json.slice(s, e));
      s = e;
    }
  }
  return chunks;
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
  hasToolCalls: boolean;
}

export class ClaudeStream {
  private context: StreamContext;
  private tokenMultiplier: number;
  private pingSent = false;

  constructor(private writer: SSEWriter, config: ProxyConfig, requestId: string, inputTokens: number = 0) {
    this.context = {
      requestId,
      writer,
      aggregator: new TextAggregator(0, async (text) => await this.flushText(text)), // 设置为0立即发送，实现细粒度文本 delta
      nextBlockIndex: 0,
      textBlockOpen: false,
      thinkingBlockOpen: false,
      finished: false,
      totalOutputTokens: 0,
      hasToolCalls: false,
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
            output_tokens: 1, // 优化：设置为非零值，更接近示例
          },
          content: [],
          stop_reason: null,
        },
      },
    }, true);
    // 不再在此处发送 ping，将在第一个内容块开始后发送
  }

  async handleEvents(events: ParserEvent[]) {
    for (const event of events) {
      if (event.type === "text") {
        // 忽略纯空白文本（空格、换行等），避免在思考前创建空文本块
        if (event.content.trim() === "") {
          continue;
        }
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

  private async maybeSendPing() {
    if (!this.pingSent) {
      this.pingSent = true;
      await this.writer.send({
        event: "ping",
        data: { type: "ping" },
      }, true);
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
      await this.maybeSendPing();
    }
  }

  private async flushText(text: string) {
    if (!text || text.trim() === "") return;
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
      await this.maybeSendPing();
    }
  }

  private async endThinkingBlock() {
    if (!this.context.thinkingBlockOpen) return;
    this.context.thinkingBlockOpen = false;
    const index = this.context.nextBlockIndex - 1;
    // 发送 signature_delta 事件（签名为空字符串）
    await this.writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "" },
      },
    }, true);
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
    
    // 将思考内容按句子边界分割成小块以模拟流式
    const chunks = splitIntoChunks(content, 50);
    for (const chunk of chunks) {
      await this.writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.context.nextBlockIndex - 1,
          delta: { type: "thinking_delta", thinking: chunk },
        },
      }, false);
      // 添加微小延迟以模拟流式（可选）
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private async emitToolCall(call: ParsedInvokeCall) {
    await this.endTextBlock();
    const index = this.context.nextBlockIndex++;
    const toolId = generateToolId();
    this.context.hasToolCalls = true;
    await this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
      },
    }, true);

    const inputJson = JSON.stringify(call.arguments);
    // 计算 token 并累加
    const estimatedTokens = countTokensWithTiktoken(inputJson, "cl100k_base");
    this.context.totalOutputTokens += estimatedTokens;
    
    // 发送空 delta 作为开始（示例中有）
    await this.writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: "" },
      },
    }, true);
    
    // 将 JSON 按结构分割成小块以模拟流式
    const chunks = splitJsonIntoChunks(inputJson, 30);
    for (const chunk of chunks) {
      await this.writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: chunk },
        },
      }, true);
      // 添加微小延迟以模拟流式（可选）
      await new Promise(resolve => setTimeout(resolve, 10));
    }

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
    
    const stopReason = this.context.hasToolCalls ? "tool_use" : "end_turn";
    await this.writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
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
