import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { log, logPhase, LogPhase } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";

// 思考标签常量
const THINKING_START_TAG = "<thinking>";
const THINKING_END_TAG = "</thinking>";

export class ToolifyParser {
  private readonly delimiter?: ToolCallDelimiter;
  // 是否开启思考解析，由上游请求的 thinking 配置决定
  private readonly thinkingEnabled: boolean;
  private buffer = "";
  private toolBuffer = "";
  private pendingText = "";
  private bufferingTool = false;
  private thinkingMode = false;
  private thinkingBuffer = "";
  private readonly events: ParserEvent[] = [];
  private readonly requestId?: string;

  constructor(delimiter?: ToolCallDelimiter, thinkingEnabled = false, requestId?: string) {
    this.delimiter = delimiter;
    this.thinkingEnabled = thinkingEnabled;
    this.requestId = requestId;
  }

  feedReasoning(content: string) {
    if (content) {
      this.events.push({ type: "thinking", content });
    }
  }

  feedChar(char: string) {
    // 当没有配置工具协议时，仅处理 thinking 块
    if (!this.delimiter) {
      this.handleCharWithoutTrigger(char);
      return;
    }

    const m = this.delimiter.getMarkers();

    // 1. 处理思考模式
    if (this.thinkingEnabled) {
      this.checkThinkingMode(char);
      if (this.thinkingMode) {
        this.thinkingBuffer += char;
        return;
      }
    }

    // 2. 处理工具调用块缓冲
    if (this.bufferingTool) {
      this.toolBuffer += char;
      // 可以在这里提前检测 TC_END 以优化
      return;
    }

    // 3. 正常内容，检测 TC_START
    this.pendingText += char;
    const combined = this.pendingText;

    if (combined.includes(m.TC_START)) {
      const idx = combined.indexOf(m.TC_START);
      // 发出 TC_START 之前的文本
      const textBefore = combined.slice(0, idx);
      if (textBefore) {
        this.events.push({ type: "text", content: textBefore });
      }
      
      // 开始缓冲工具调用，包含 TC_START
      this.bufferingTool = true;
      this.toolBuffer = combined.slice(idx);
      this.pendingText = "";
      
      log("debug", "Detected tool call start marker", {
        marker: m.TC_START,
        requestId: this.requestId
      });
      return;
    }

    // 4. 防止 pendingText 无限增长，同时保留可能的标记前缀
    const safeEnd = this.findPartialMatchEndIndex(combined, m.TC_START);
    if (safeEnd > 0) {
      const safeText = combined.slice(0, safeEnd);
      this.events.push({ type: "text", content: safeText });
      this.pendingText = combined.slice(safeEnd);
    }
  }

  finish() {
    // 1. 处理未完成的思考块
    if (this.thinkingEnabled && this.thinkingMode && this.thinkingBuffer) {
      let thinkingContent = this.thinkingBuffer;
      thinkingContent = thinkingContent.replace(/^\s*>\s*/, "");
      this.events.push({ type: "thinking", content: thinkingContent });
    }

    // 2. 处理缓冲中的工具调用
    if (this.bufferingTool && this.toolBuffer) {
      this.parseAndEmitToolCall();
    }

    // 3. 发出剩余的 pending 文本
    if (this.pendingText) {
      this.events.push({ type: "text", content: this.pendingText });
    }

    this.events.push({ type: "end" });
    
    // 重置状态
    this.buffer = "";
    this.toolBuffer = "";
    this.pendingText = "";
    this.bufferingTool = false;
    this.thinkingBuffer = "";
    this.thinkingMode = false;
  }

  consumeEvents(): ParserEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private parseAndEmitToolCall() {
    if (!this.delimiter) return;
    const m = this.delimiter.getMarkers();
    const content = this.toolBuffer;

    // 转义正则表达式中的特殊字符
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex = new RegExp(
      `${esc(m.TC_START)}\\s*` +
        `${esc(m.NAME_START)}([\\s\\S]*?)${esc(m.NAME_END)}\\s*` +
        `${esc(m.ARGS_START)}([\\s\\S]*?)${esc(m.ARGS_END)}\\s*` +
        `${esc(m.TC_END)}`,
      "g"
    );

    let found = false;
    let match: RegExpExecArray | null;
    
    // 我们只处理第一个匹配项（按照现有逻辑）
    if ((match = regex.exec(content)) !== null) {
      const name = match[1].trim();
      const argsStr = match[2].trim();

      try {
        const args = JSON.parse(argsStr);
        logPhase(this.requestId || "unknown", LogPhase.TOOL, `${name}()`, {
          args: argsStr.slice(0, 100) + (argsStr.length > 100 ? "..." : "")
        });
        
        this.events.push({
          type: "tool_call",
          call: { name, arguments: args }
        });
        found = true;
      } catch (e) {
        log("warn", "Failed to parse tool call arguments", {
          error: String(e),
          name,
          argsStr: argsStr.slice(0, 500)
        });
      }
    }

    if (!found) {
      // 如果没有解析出有效的工具调用，将缓冲内容作为普通文本发出
      // 或者如果标记不完整，也原样发出
      log("debug", "No valid tool call found in buffer, emitting as text", {
        bufferPreview: content.slice(0, 200)
      });
      this.events.push({ type: "text", content });
    } else {
      // 如果解析成功，可能还需要检查工具调用块之后是否还有多余的内容
      const lastMatchEnd = regex.lastIndex;
      const remaining = content.slice(lastMatchEnd);
      if (remaining.trim()) {
        this.events.push({ type: "text", content: remaining });
      }
    }
    
    this.toolBuffer = "";
    this.bufferingTool = false;
  }

  private findPartialMatchEndIndex(text: string, marker: string): number {
    for (let i = marker.length - 1; i > 0; i--) {
      if (text.endsWith(marker.slice(0, i))) {
        return text.length - i;
      }
    }
    return text.length;
  }

  private handleCharWithoutTrigger(char: string) {
    if (!this.thinkingEnabled) {
      this.buffer += char;
      if (this.buffer.length >= 256) {
        this.events.push({ type: "text", content: this.buffer });
        this.buffer = "";
      }
      return;
    }

    if (this.thinkingMode) {
      this.thinkingBuffer += char;
      if (this.thinkingBuffer.endsWith(THINKING_END_TAG)) {
        let thinkingContent = this.thinkingBuffer.slice(0, -THINKING_END_TAG.length);
        thinkingContent = thinkingContent.replace(/^\s*>\s*/, "");
        if (thinkingContent) {
          this.events.push({ type: "thinking", content: thinkingContent });
        }
        this.thinkingBuffer = "";
        this.thinkingMode = false;
      }
      return;
    }

    this.buffer += char;
    if (this.buffer.endsWith(THINKING_START_TAG)) {
      const textPortion = this.buffer.slice(0, -THINKING_START_TAG.length);
      if (textPortion) {
        this.events.push({ type: "text", content: textPortion });
      }
      this.buffer = "";
      this.thinkingMode = true;
      this.thinkingBuffer = "";
    } else if (this.buffer.length >= 256) {
      this.events.push({ type: "text", content: this.buffer });
      this.buffer = "";
    }
  }

  private checkThinkingMode(char: string) {
    if (!this.thinkingMode) {
      const tempBuffer = this.buffer + char;
      if (tempBuffer.endsWith(THINKING_START_TAG)) {
        const textPortion = this.buffer.slice(0, -THINKING_START_TAG.length + 1);
        if (textPortion) {
          this.events.push({ type: "text", content: textPortion });
        }
        this.buffer = "";
        this.thinkingMode = true;
        this.thinkingBuffer = "";
      } else {
        this.buffer += char;
      }
    } else {
      if (this.thinkingBuffer.endsWith(THINKING_END_TAG)) {
        let thinkingContent = this.thinkingBuffer.slice(0, -THINKING_END_TAG.length);
        thinkingContent = thinkingContent.replace(/^\s*>\s*/, "");
        if (thinkingContent) {
          this.events.push({ type: "thinking", content: thinkingContent });
        }
        this.thinkingBuffer = "";
        this.thinkingMode = false;
      }
    }
  }
}
