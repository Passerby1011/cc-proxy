import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { log, logPhase, LogPhase } from "./logging.ts";
import { ToolCallDelimiter } from "./signals.ts";

// 思考标签常量
const THINKING_START_TAG = "<thinking>";
const THINKING_END_TAG = "</thinking>";

type ParserState = "TEXT" | "THINKING" | "TOOL";

export class ToolifyParser {
  private readonly delimiter?: ToolCallDelimiter;
  private readonly thinkingEnabled: boolean;
  
  private state: ParserState = "TEXT";
  private buffer = ""; // 通用缓冲区
  private thinkingBuffer = "";
  private toolBuffer = "";
  
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
    this.buffer += char;
    this.processBuffer();
  }

  private processBuffer() {
    const m = this.delimiter?.getMarkers();

    if (this.state === "THINKING") {
      // 思考模式中：只寻找结束标签
      if (this.buffer.includes(THINKING_END_TAG)) {
        const idx = this.buffer.indexOf(THINKING_END_TAG);
        this.thinkingBuffer += this.buffer.slice(0, idx);
        
        // 发出思考事件
        let content = this.thinkingBuffer.replace(/^\s*>\s*/, "");
        if (content) {
          this.events.push({ type: "thinking", content });
        }
        
        // 切换回文本模式
        this.thinkingBuffer = "";
        this.state = "TEXT";
        // 剩余部分重新处理
        const remaining = this.buffer.slice(idx + THINKING_END_TAG.length);
        this.buffer = "";
        if (remaining) {
          this.feedChar(""); // 触发递归处理，但其实直接赋值 buffer 更安全
          this.buffer = remaining;
          this.processBuffer();
        }
      }
      // 如果没找到结束标签，buffer 继续增长
      return;
    }

    if (this.state === "TOOL") {
      // 工具模式中：寻找结束标记
      if (m && this.buffer.includes(m.TC_END)) {
        const idx = this.buffer.indexOf(m.TC_END) + m.TC_END.length;
        this.toolBuffer += this.buffer.slice(0, idx);
        
        this.parseAndEmitToolCall();
        
        this.state = "TEXT";
        const remaining = this.buffer.slice(idx);
        this.buffer = "";
        if (remaining) {
          this.buffer = remaining;
          this.processBuffer();
        }
      }
      return;
    }

    // TEXT 状态：寻找思考开始或工具开始
    
    // 1. 优先检测思考开始 (如果启用)
    if (this.thinkingEnabled && this.buffer.includes(THINKING_START_TAG)) {
      const idx = this.buffer.indexOf(THINKING_START_TAG);
      const textBefore = this.buffer.slice(0, idx);
      if (textBefore) {
        this.events.push({ type: "text", content: textBefore });
      }
      
      this.state = "THINKING";
      this.thinkingBuffer = "";
      const remaining = this.buffer.slice(idx + THINKING_START_TAG.length);
      this.buffer = "";
      if (remaining) {
        this.buffer = remaining;
        this.processBuffer();
      }
      return;
    }

    // 2. 检测工具调用开始
    if (m && this.buffer.includes(m.TC_START)) {
      const idx = this.buffer.indexOf(m.TC_START);
      const textBefore = this.buffer.slice(0, idx);
      if (textBefore) {
        this.events.push({ type: "text", content: textBefore });
      }
      
      this.state = "TOOL";
      this.toolBuffer = ""; // TC_START 留在 buffer 里交给 TOOL 状态处理
      const remaining = this.buffer.slice(idx);
      this.buffer = "";
      if (remaining) {
        this.buffer = remaining;
        this.processBuffer();
      }
      return;
    }

    // 3. 保护逻辑：如果 buffer 太长且没有发现任何标记，刷出部分文本
    // 但要保留可能成为标记一部分的后缀
    const maxMarkerLen = Math.max(
      THINKING_START_TAG.length,
      m?.TC_START.length || 0
    );
    
    if (this.buffer.length > 512) {
      const safeLen = this.buffer.length - maxMarkerLen;
      const safeText = this.buffer.slice(0, safeLen);
      this.events.push({ type: "text", content: safeText });
      this.buffer = this.buffer.slice(safeLen);
    }
  }

  finish() {
    if (this.state === "THINKING") {
      let content = this.thinkingBuffer + this.buffer;
      content = content.replace(/^\s*>\s*/, "");
      if (content) {
        this.events.push({ type: "thinking", content });
      }
    } else if (this.state === "TOOL") {
      this.toolBuffer += this.buffer;
      this.parseAndEmitToolCall();
    } else {
      if (this.buffer) {
        this.events.push({ type: "text", content: this.buffer });
      }
    }

    this.events.push({ type: "end" });
    
    // 重置
    this.state = "TEXT";
    this.buffer = "";
    this.thinkingBuffer = "";
    this.toolBuffer = "";
  }

  consumeEvents(): ParserEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private parseAndEmitToolCall() {
    if (!this.delimiter) return;
    const m = this.delimiter.getMarkers();
    const content = this.toolBuffer;

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
      log("debug", "No valid tool call found in buffer, emitting as text", {
        bufferPreview: content.slice(0, 200)
      });
      this.events.push({ type: "text", content });
    } else {
      const lastMatchEnd = regex.lastIndex;
      const remaining = content.slice(lastMatchEnd);
      if (remaining.trim()) {
        this.events.push({ type: "text", content: remaining });
      }
    }
    
    this.toolBuffer = "";
  }
}

