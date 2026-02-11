import { ProxyConfig, ConfigStorage } from "./config.ts";

/**
 * 本地文件存储实现
 */
export class LocalStorage implements ConfigStorage {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<Partial<ProxyConfig>> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      return JSON.parse(content);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {};
      }
      throw error;
    }
  }

  async save(config: Partial<ProxyConfig>): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    await Deno.writeTextFile(this.filePath, content);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const stat = await Deno.stat(this.filePath);
      return stat.isFile;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // 如果文件不存在但目录可写，也认为是健康的
        return true; 
      }
      return false;
    }
  }
}
