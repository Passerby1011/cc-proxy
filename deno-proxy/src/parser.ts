import { ParsedInvokeCall, ParsedThinkingCall, ParserEvent } from "./types.ts";
import { log, logPhase, LogPhase } from "./logging.ts";

// 思考标签常量
const THINKING_START_TAG = "<thinking>";
const THINKING_END_TAG = "</thinking>";

function parseInvokeXml(xml: string): ParsedInvokeCall | null {
  try {
    const invokeMatch = xml.match(/<invoke[^>]*name="([^"]+)"[^>]*>/i);
    if (!invokeMatch) return null;
    const name = invokeMatch[1];
    const params: Record<string, unknown> = {};
    const paramRegex = /<parameter[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
    let match: RegExpExecArray | null;
    while ((match = paramRegex.exec(xml)) !== null) {
      const key = match[1];
      const rawValue = match[2] ?? "";
      const trimmed = rawValue.trim();
      let value: unknown = trimmed;
      if (trimmed) {
        try {
          value = JSON.parse(trimmed);
        } catch {
          value = trimmed;
        }
      } else {
        value = "";
      }
      params[key] = value;
    }
    return { name, arguments: params };
  } catch (error) {
    log("warn", "Failed to parse invoke XML", { error: String(error) });
    return null;
  }
}

export class ToolifyParser {
  private readonly triggerSignal?: string;
  // 是否开启思考解析，由上游请求的 thinking 配置决定
  private readonly thinkingEnabled: boolean;
  private buffer = "";
  private captureBuffer = "";
  private capturing = false;
  private thinkingMode = false;
  private thinkingBuffer = "";
  private readonly events: ParserEvent[] = [];
  private readonly requestId?: string;

  constructor(triggerSignal?: string, thinkingEnabled = false, requestId?: string) {
    this.triggerSignal = triggerSignal;
    this.thinkingEnabled = thinkingEnabled;
    this.requestId = requestId;
  }

  feedChar(char: string) {
    // 当 triggerSignal 未配置时，不启用工具协议，仅在 thinkingEnabled=true 时解析 <thinking>
    if (!this.triggerSignal) {
      this.handleCharWithoutTrigger(char);
      return;
    }

    // 以下为“启用工具协议”的模式，根据 thinkingEnabled 决定是否解析 <thinking> 块

    if (this.thinkingEnabled) {
      // 首先检查是否进入或退出思考模式
      this.checkThinkingMode(char);

      if (this.thinkingMode) {
        this.thinkingBuffer += char;
        this.tryEmitThinking();
        return;
      }
    }

    if (this.capturing) {
      this.captureBuffer += char;
      // Log when we detect potential invoke tags in capture mode
      // Note: This log stays as system log since it's not request-specific
      if (this.captureBuffer.toLowerCase().includes("<invoke")) {
        log("debug", "Detected invoke tag in capture buffer", {
          captureBufferPreview: this.captureBuffer.slice(0, 200),
        });
      }
      this.tryEmitInvokes();
      return;
    }

    this.buffer += char;
    if (this.buffer.endsWith(this.triggerSignal)) {
      // Note: This log stays as system log since it's not request-specific
      log("debug", "Trigger signal detected", {
        triggerSignal: this.triggerSignal,
        bufferBefore: this.buffer.slice(0, 200),
      });
      const textPortion = this.buffer.slice(0, -this.triggerSignal.length);
      if (textPortion) {
        this.events.push({ type: "text", content: textPortion });
      }
      this.buffer = "";
      this.capturing = true;
      this.captureBuffer = "";
    }
    // Log if buffer is getting long without trigger signal
    if (this.buffer.length > 100 && this.buffer.length % 100 === 0) {
      // Note: This log stays as system log since it's not request-specific
      log("debug", "Parser buffer accumulating without trigger", {
        bufferLength: this.buffer.length,
        bufferTail: this.buffer.slice(-100),
        expectedTrigger: this.triggerSignal,
      });
    }
  }

  finish() {
    if (this.buffer) {
      this.events.push({ type: "text", content: this.buffer });
    }
    if (this.thinkingEnabled && this.thinkingMode && this.thinkingBuffer) {
      // 如果在思考模式下结束，发出剩余的思考内容
      // 同样需要修复开头多一个 ">" 的问题
      let thinkingContent = this.thinkingBuffer;
      thinkingContent = thinkingContent.replace(/^\s*>\s*/, "");
      this.events.push({ type: "thinking", content: thinkingContent });
    }
    this.tryEmitInvokes(true);
    this.events.push({ type: "end" });
    this.buffer = "";
    this.captureBuffer = "";
    this.capturing = false;
    this.thinkingBuffer = "";
    this.thinkingMode = false;
  }

  consumeEvents(): ParserEvent[] {
    const pending = this.events.splice(0, this.events.length);
    return pending;
  }

  private tryEmitInvokes(force = false) {
    const lower = this.captureBuffer.toLowerCase();
    const startIdx = lower.indexOf("<invoke");
    
    if (startIdx === -1) {
      if (!force) {
        return;
      }
      if (this.captureBuffer) {
        log("debug", "No invoke tag found, emitting as text", {
          captureBufferPreview: this.captureBuffer.slice(0, 200),
          force,
        });
        this.events.push({ type: "text", content: this.captureBuffer });
        this.captureBuffer = "";
      }
      this.capturing = false;
      return;
    }

    const endIdx = this.captureBuffer.indexOf("</invoke>", startIdx);
    if (endIdx === -1) {
      log("debug", "Incomplete invoke tag, waiting for more data", {
        captureBufferPreview: this.captureBuffer.slice(startIdx, startIdx + 200),
      });
      return;
    }

    const endPos = endIdx + "</invoke>".length;
    const invokeXml = this.captureBuffer.slice(startIdx, endPos);
    
    // 检查 </invoke> 后面的内容
    const afterInvoke = this.captureBuffer.slice(endPos);
    const afterTrimmed = afterInvoke.trimStart();
    
    // 如果后面有非空白字符，且不是另一个 <invoke>，回退到文本模式
    if (afterTrimmed && !afterTrimmed.toLowerCase().startsWith("<invoke") && !force) {
      log("debug", "Non-whitespace content after </invoke>, falling back to text mode", {
        afterContent: afterTrimmed.slice(0, 100),
      });
      this.events.push({ type: "text", content: this.captureBuffer });
      this.captureBuffer = "";
      this.capturing = false;
      return;
    }

    log("debug", "Found complete invoke tag", {
      invokeXml: invokeXml.slice(0, 500),
    });
    
    const before = this.captureBuffer.slice(0, startIdx);
    if (before) {
      this.events.push({ type: "text", content: before });
    }

    const parsed = parseInvokeXml(invokeXml);
    if (parsed) {
      // 使用新的日志格式
      if (this.requestId) {
        const argsPreview = JSON.stringify(parsed.arguments).slice(0, 50);
        logPhase(this.requestId, LogPhase.TOOL, `${parsed.name}()`, {
          args: argsPreview + (JSON.stringify(parsed.arguments).length > 50 ? "..." : ""),
        });
      } else {
        log("debug", "Successfully parsed first invoke call", {
          toolName: parsed.name,
          argumentKeys: Object.keys(parsed.arguments),
        });
      }
      this.events.push({ type: "tool_call", call: parsed });
      
      // 过滤掉第一个工具调用后面的所有 <invoke>...</invoke> 标签
      // 但保留非工具调用的文本内容
      let remaining = afterInvoke;
      let filteredContent = "";
      
      while (true) {
        const trimmed = remaining.trimStart();
        if (!trimmed) break;
        
        // 检查是否是另一个 <invoke> 标签
        if (trimmed.toLowerCase().startsWith("<invoke")) {
          const nextEndIdx = trimmed.indexOf("</invoke>");
          if (nextEndIdx !== -1) {
            // 找到完整的 <invoke>...</invoke>，跳过它
            const skippedTag = trimmed.slice(0, nextEndIdx + "</invoke>".length);
            log("debug", "Filtering out subsequent tool call", {
              skippedTagPreview: skippedTag.slice(0, 200),
            });
            remaining = trimmed.slice(nextEndIdx + "</invoke>".length);
            continue;
          }
        }
        
        // 不是工具调用，保留这部分内容
        filteredContent = remaining;
        break;
      }
      
      if (filteredContent.trim()) {
        log("debug", "Emitting remaining non-tool-call content as text", {
          contentPreview: filteredContent.slice(0, 200),
        });
        this.events.push({ type: "text", content: filteredContent });
      }
    } else {
      log("warn", "Failed to parse invoke XML", {
        invokeXml: invokeXml.slice(0, 500),
      });
      // 解析失败时，将整个捕获内容作为文本输出
      this.events.push({ type: "text", content: this.captureBuffer });
    }
    
    // 清空缓冲区并退出捕获模式
    this.captureBuffer = "";
    this.capturing = false;
  }

  /**
   * 在未启用工具协议（无 triggerSignal）时的解析逻辑：
   * - 只解析 <thinking>...</thinking>，并发出 thinking 事件；
   * - 其余内容全部作为普通文本 text 事件；
   * - 不进行任何 <invoke> / 工具调用解析。
   */
  private handleCharWithoutTrigger(char: string) {
    // 未开启思考解析时，简单地把所有内容当作文本处理
    if (!this.thinkingEnabled) {
      this.buffer += char;
      if (this.buffer.length >= 256) {
        this.events.push({ type: "text", content: this.buffer });
        this.buffer = "";
      }
      return;
    }
    if (this.thinkingMode) {
      // 已处于思考模式：累积思考内容并检查结束标签
      this.thinkingBuffer += char;
      if (this.thinkingBuffer.endsWith(THINKING_END_TAG)) {
        log("debug", "Exiting thinking mode (no-trigger)", {
          thinkingContent: this.thinkingBuffer.slice(0, -THINKING_END_TAG.length),
        });
        let thinkingContent = this.thinkingBuffer.slice(0, -THINKING_END_TAG.length);
        // 与启用工具时保持一致：去掉开头多余的 ">" 和空白
        thinkingContent = thinkingContent.replace(/^\s*>\s*/, "");
        if (thinkingContent) {
          this.events.push({ type: "thinking", content: thinkingContent });
        }
        this.thinkingBuffer = "";
        this.thinkingMode = false;
      }
      return;
    }

    // 未处于思考模式：累积到普通缓冲区，检测 <thinking> 起始标签
    this.buffer += char;
    if (this.buffer.endsWith(THINKING_START_TAG)) {
      log("debug", "Entering thinking mode (no-trigger)", {
        bufferBefore: this.buffer.slice(0, -THINKING_START_TAG.length),
      });
      const textPortion = this.buffer.slice(0, -THINKING_START_TAG.length);
      if (textPortion) {
        this.events.push({ type: "text", content: textPortion });
      }
      this.buffer = "";
      this.thinkingMode = true;
      this.thinkingBuffer = "";
      return;
    }

    // 为了避免无限积累缓冲区，这里做一个简单的流式折中：
    // 当缓冲区超出一定长度时，直接作为文本输出。
    if (this.buffer.length >= 256) {
      this.events.push({ type: "text", content: this.buffer });
      this.buffer = "";
    }
  }

  private checkThinkingMode(char: string) {
    if (!this.thinkingEnabled) return;
    // 检查是否进入思考模式
    if (!this.thinkingMode) {
      const tempBuffer = this.buffer + char;
      if (tempBuffer.endsWith(THINKING_START_TAG)) {
        log("debug", "Entering thinking mode", {
          bufferBefore: this.buffer.slice(0, -THINKING_START_TAG.length + 1),
        });
        // 发出思考标签之前的文本
        const textPortion = this.buffer.slice(0, -THINKING_START_TAG.length + 1);
        if (textPortion) {
          this.events.push({ type: "text", content: textPortion });
        }
        this.buffer = "";
        this.thinkingMode = true;
        this.thinkingBuffer = "";
        return;
      }
    } else {
      // 检查是否退出思考模式
      if (this.thinkingBuffer.endsWith(THINKING_END_TAG)) {
        log("debug", "Exiting thinking mode", {
          thinkingContent: this.thinkingBuffer.slice(0, -THINKING_END_TAG.length),
        });
        // 发出思考内容（不包含结束标签）
        let thinkingContent = this.thinkingBuffer.slice(0, -THINKING_END_TAG.length);
        // 修复思考块开头多一个 ">" 的问题：由于当前解析逻辑在进入思考模式时，
        // 会把 "<thinking>" 的结尾 ">" 作为首个思考字符写入 thinkingBuffer，
        // 这里在真正发出事件前将前导的 ">" 和紧随其后的空白去掉。
        thinkingContent = thinkingContent.replace(/^\s*>\s*/, "");
        if (thinkingContent) {
          this.events.push({ type: "thinking", content: thinkingContent });
        }
        this.thinkingBuffer = "";
        this.thinkingMode = false;
        return;
      }
    }
  }
  
  private tryEmitThinking() {
    // 暂时不实现流式思考内容发出，等待完整的思考块
    // 这样可以保持与工具调用类似的处理方式
  }
}
