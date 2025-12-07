import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { log } from "./logging.ts";

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
  private buffer = "";
  private captureBuffer = "";
  private capturing = false;
  private readonly events: ParserEvent[] = [];

  constructor(triggerSignal?: string) {
    this.triggerSignal = triggerSignal;
  }

  feedChar(char: string) {
    if (!this.triggerSignal) {
      this.events.push({ type: "text", content: char });
      return;
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
    this.tryEmitInvokes(true);
    this.events.push({ type: "end" });
    this.buffer = "";
    this.captureBuffer = "";
    this.capturing = false;
  }

  consumeEvents(): ParserEvent[] {
    const pending = this.events.splice(0, this.events.length);
    return pending;
  }

  private tryEmitInvokes(force = false) {
    while (true) {
      const lower = this.captureBuffer.toLowerCase();
      const startIdx = lower.indexOf("<invoke");
      if (startIdx === -1) {
        if (!force) {
          return;
        }
        if (this.captureBuffer) {
          // Note: This log stays as system log since it's not request-specific
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
        // Note: This log stays as system log since it's not request-specific
        log("debug", "Incomplete invoke tag, waiting for more data", {
          captureBufferPreview: this.captureBuffer.slice(startIdx, startIdx + 200),
        });
        return;
      }

      const endPos = endIdx + "</invoke>".length;
      const invokeXml = this.captureBuffer.slice(startIdx, endPos);
      // Note: This log stays as system log since it's not request-specific
      log("debug", "Found complete invoke tag", {
        invokeXml: invokeXml.slice(0, 500),
      });
      const before = this.captureBuffer.slice(0, startIdx);
      if (before) {
        this.events.push({ type: "text", content: before });
      }

      this.captureBuffer = this.captureBuffer.slice(endPos);
      const parsed = parseInvokeXml(invokeXml);
      if (parsed) {
        // Note: This log stays as system log since it's not request-specific
        log("debug", "Successfully parsed invoke call", {
          toolName: parsed.name,
          argumentKeys: Object.keys(parsed.arguments),
        });
        this.events.push({ type: "tool_call", call: parsed });
      } else {
        // Note: This log stays as system log since it's not request-specific
        log("warn", "Failed to parse invoke XML", {
          invokeXml: invokeXml.slice(0, 500),
        });
      }
      if (!this.captureBuffer.trim()) {
        this.captureBuffer = "";
        this.capturing = false;
        return;
      }
    }
  }
}
