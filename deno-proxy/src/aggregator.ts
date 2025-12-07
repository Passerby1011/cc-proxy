export class TextAggregator {
  private buffer = "";
  private timer?: number;

  constructor(
    private readonly intervalMs: number,
    private readonly onFlush: (text: string) => void | Promise<void>,
  ) {}

  add(text: string) {
    this.buffer += text;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.intervalMs);
    }
  }

  flush() {
    if (!this.buffer) {
      this.clearTimer();
      return;
    }
    const chunk = this.buffer;
    this.buffer = "";
    this.clearTimer();
    this.onFlush(chunk);
  }

  async flushAsync() {
    if (!this.buffer) {
      this.clearTimer();
      return;
    }
    const chunk = this.buffer;
    this.buffer = "";
    this.clearTimer();
    await this.onFlush(chunk);
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
