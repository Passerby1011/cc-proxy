import { logRequest } from "./logging.ts";

const encoder = new TextEncoder();

export interface SSEEvent<T = unknown> {
  event: string;
  data: T;
}

export class SSEWriter {
  constructor(
    private controller: ReadableStreamDefaultController<Uint8Array>,
    private requestId: string,
  ) {}
  private closed = false;

  async send(event: SSEEvent, critical = false) {
    if (this.closed) {
      await logRequest(this.requestId, "warn", "Attempted to send on closed SSE stream", {
        event: event.event,
      });
      return false;
    }
    await logRequest(this.requestId, "debug", "Sending downstream SSE event", {
      event: event.event,
      dataPreview: JSON.stringify(event.data).slice(0, 2048),
    });
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    
    // 检查背压：等待写入队列准备就绪
    const maxRetries = critical ? 3 : 1;
    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        // 检查 desiredSize，如果为负表示队列已满
        if (this.controller.desiredSize !== null && this.controller.desiredSize <= 0) {
          // 短暂等待队列排空
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }
        
        this.controller.enqueue(encoder.encode(payload));
        return true;
      } catch (error) {
        if (retry === maxRetries - 1) {
          this.closed = true;
          await logRequest(this.requestId, "error", "Failed to enqueue SSE payload after retries", {
            error: error instanceof Error ? error.message : String(error),
            event: event.event,
            retries: retry + 1,
          });
          return false;
        }
        await logRequest(this.requestId, "warn", "SSE enqueue failed, retrying", {
          error: error instanceof Error ? error.message : String(error),
          retry: retry + 1,
        });
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    return false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}
