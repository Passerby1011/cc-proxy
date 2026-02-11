import { Client } from "postgres";
import { ProxyConfig, ConfigStorage } from "./config.ts";

/**
 * PostgreSQL 存储实现
 */
export class PostgresStorage implements ConfigStorage {
  private dsn: string;
  private client: Client;
  private initialized = false;

  constructor(dsn: string) {
    this.dsn = dsn;
    this.client = new Client(this.dsn);
  }

  private async ensureTable() {
    if (this.initialized) return;
    
    await this.client.connect();
    await this.client.queryArray(`
      CREATE TABLE IF NOT EXISTS kv_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    this.initialized = true;
  }

  async load(): Promise<Partial<ProxyConfig>> {
    try {
      await this.ensureTable();
      const result = await this.client.queryObject<{ value: string }>(
        "SELECT value FROM kv_config WHERE key = 'proxy_config'"
      );
      if (result.rows.length > 0) {
        // postgres 驱动通常会自动解析 jsonb
        return result.rows[0].value as unknown as Partial<ProxyConfig>;
      }
      return {};
    } catch (error) {
      console.error("PostgresStorage load error:", error);
      return {};
    }
  }

  async save(config: Partial<ProxyConfig>): Promise<void> {
    try {
      await this.ensureTable();
      await this.client.queryArray(
        "INSERT INTO kv_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        ["proxy_config", JSON.stringify(config)]
      );
    } catch (error) {
      console.error("PostgresStorage save error:", error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.initialized) {
        await this.client.connect();
      }
      await this.client.queryArray("SELECT 1");
      return true;
    } catch (_error) {
      return false;
    }
  }
}
