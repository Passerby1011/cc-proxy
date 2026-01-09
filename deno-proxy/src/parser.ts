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
  private textBeforeToolCall = ""; // 🔑 记录工具调用前的所有文本
  
  private readonly events: ParserEvent[] = [];
  private readonly requestId?: string;

  /**
   * 尝试修复模型生成的损坏 JSON
   */
  private repairJson(str: string): string {
    let fixed = str.trim();

    // 1. 处理明显的截断或前后杂质：提取第一个 { 和最后一个 } 之间的内容
    const firstBrace = fixed.indexOf("{");
    const lastBrace = fixed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      fixed = fixed.slice(firstBrace, lastBrace + 1);
    }

    // 2. 移除末尾逗号 (Trailing Commas)
    // 匹配: , 后面跟着紧随其后的 } 或 ]，中间允许有空白
    fixed = fixed.replace(/,\s*([}\]])/g, "$1");

    // 3. 处理字符串内部的非法换行符 (JSON 规范要求字符串内的换行必须转义为 \n)
    // 这个正则寻找在双引号包裹的字符串内容中的真实换行符
    // 逻辑：如果换行符出现在双引号之间，且前面的双引号不是被转义的
    // 注意：这是一个简单启发式，处理不了极其复杂的嵌套，但能解决 90% 模型输出问题
    fixed = fixed.replace(/(".*?[^\\]")|(\n)/g, (match, group1, group2) => {
      if (group2) return "\\n"; // 如果匹配到的是换行符且不在 group1 (双引号块) 中，则替换
      return group1; // 如果匹配到的是双引号块，保持原样
    });

    // 4. 🔑 处理最头疼的“字段内部未转义的双引号” (Case 1 & 2)
    // 策略：寻找那些夹在汉字、字母、数字、标点符号中间，且前后不是 JSON 结构符号的孤立双引号
    fixed = fixed.replace(/([^\{\}\[\]\s:,])"([^\{\}\[\]\s:,])/g, '$1\\"$2');

    // 5. 补全裸奔的属性名 (Unquoted Keys)
    // 匹配类似 { name: "val" } 或 , age: 30 这种 key 没加引号的情况
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // 6. 还原被错误包裹的布尔值、数字和 null
    // 将 "true" -> true, "false" -> false, "null" -> null
    fixed = fixed.replace(/:[ \t]*"(true|false|null)"/gi, (match, val) => {
      return `: ${val.toLowerCase()}`;
    });

    // 1. 括号自动补全 (针对截断的情况)
    // 扫描整个字符串，计算括号平衡
    const stack: ("{" | "[")[] = [];
    for (let i = 0; i < fixed.length; i++) {
      const char = fixed[i];
      if (char === '{') stack.push('{');
      else if (char === '[') stack.push('[');
      else if (char === '}') {
        if (stack[stack.length - 1] === '{') stack.pop();
      } else if (char === ']') {
        if (stack[stack.length - 1] === '[') stack.pop();
      }
    }
    // 按相反顺序补齐缺失的闭合括号
    while (stack.length > 0) {
      const open = stack.pop();
      fixed += (open === '{' ? '}' : ']');
    }

    return fixed;
  }

  public tryParseJson(str: string): any {
    if (!str) return {};
    
    // 首先尝试原始解析
    try {
      return JSON.parse(str);
    } catch (_e) {
      // 原始解析失败，进入修复逻辑
      const repaired = this.repairJson(str);
      try {
        return JSON.parse(repaired);
      } catch (err) {
        // 如果修复后还是失败，尝试最后的挣扎：处理极端换行和控制字符
        try {
          const lastResort = repaired
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t");
          return JSON.parse(lastResort);
        } catch (_finalError) {
          log("debug", "JSON Repair failed", {
            original: str.slice(0, 200),
            repaired: repaired.slice(0, 200),
            error: String(err)
          });
          return null;
        }
      }
    }
  }

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
        this.textBeforeToolCall += textBefore; // 🔑 累积前置文本
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
      this.parseAndEmitToolCall(); // 🔑 尝试解析，可能发出 tool_call_failed 事件
    } else {
      if (this.buffer) {
        this.textBeforeToolCall += this.buffer; // 🔑 累积文本模式下的内容
        this.events.push({ type: "text", content: this.buffer });
      }
    }

    this.events.push({ type: "end" });
    
    // 重置
    this.state = "TEXT";
    this.buffer = "";
    this.thinkingBuffer = "";
    this.toolBuffer = "";
    this.textBeforeToolCall = "";
  }

  consumeEvents(): ParserEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private parseAndEmitToolCall() {
    if (!this.delimiter) return;
    const m = this.delimiter.getMarkers();
    const content = this.toolBuffer;

    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 更加宽松的正则表达式：允许在标记之间存在任意空白符（包括缩进）
    const regex = new RegExp(
      `${esc(m.TC_START)}[\\s\\S]*?` +
        `${esc(m.NAME_START)}\\s*([\\s\\S]*?)\\s*${esc(m.NAME_END)}[\\s\\S]*?` +
        `${esc(m.ARGS_START)}\\s*([\\s\\S]*?)\\s*${esc(m.ARGS_END)}[\\s\\S]*?` +
        `${esc(m.TC_END)}`,
      "g"
    );

    let found = false;
    let match: RegExpExecArray | null;
    let name = "";
    let argsStr = "";

    // 1. 尝试正则匹配
    if ((match = regex.exec(content)) !== null) {
      name = match[1].trim();
      argsStr = match[2].trim();
    } else {
      // 2. 如果正则匹配失败，尝试基于关键标记定位的"模糊匹配"
      const nStart = content.indexOf(m.NAME_START);
      const nEnd = content.indexOf(m.NAME_END, nStart + m.NAME_START.length);
      const aStart = content.indexOf(m.ARGS_START, nEnd + m.NAME_END.length);
      const aEnd = content.indexOf(m.ARGS_END, aStart + m.ARGS_START.length);

      if (nStart !== -1 && nEnd !== -1 && aStart !== -1 && aEnd !== -1) {
        name = content.slice(nStart + m.NAME_START.length, nEnd).trim();
        argsStr = content.slice(aStart + m.ARGS_START.length, aEnd).trim();
        log("debug", "Regex failed, but fuzzy marker matching succeeded", { name, requestId: this.requestId });
      }
    }

    if (name) {
      // 尝试解析或修复 JSON
      const args = this.tryParseJson(argsStr);
      if (args !== null) {
        logPhase(this.requestId || "unknown", LogPhase.TOOL, `${name}()`, {
          args: argsStr.slice(0, 100) + (argsStr.length > 100 ? "..." : ""),
        });

        this.events.push({
          type: "tool_call",
          call: { name, arguments: args },
        });
        found = true;
      } else {
        log("warn", "Failed to parse tool call arguments even after repair", {
          name,
          argsStr: argsStr.slice(0, 1000),
          requestId: this.requestId,
        });
      }
    }

    if (!found) {
      // 🔑 确定失败原因
      const reason = content.includes(m.TC_END) ? "malformed_json" : "incomplete_delimiter";
      
      log("warn", "No valid tool call found in tool buffer", {
        requestId: this.requestId,
        reason,
        bufferSize: content.length,
        bufferPreview: content.slice(0, 1000),
      });
      
      // 🔑 发出 tool_call_failed 事件而不是降级为文本
      this.events.push({ 
        type: "tool_call_failed", 
        content,
        reason,
        priorText: this.textBeforeToolCall
      });
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

