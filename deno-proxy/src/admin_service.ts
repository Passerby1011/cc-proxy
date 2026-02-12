import { ProxyConfig, ConfigStorage } from "./config.ts";
import { LocalStorage } from "./storage_local.ts";
import { PostgresStorage } from "./storage_postgres.ts";
import { LogPhase } from "./logging.ts";

export class AdminService {
  private storage: ConfigStorage;
  private currentConfig: ProxyConfig;
  private adminApiKey: string;

  constructor(initialConfig: ProxyConfig) {
    this.currentConfig = initialConfig;
    this.adminApiKey = initialConfig.adminApiKey || "";
    
    // 初始化存储引擎
    if (initialConfig.pgStoreDsn) {
      this.storage = new PostgresStorage(initialConfig.pgStoreDsn);
    } else {
      const filePath = initialConfig.configFilePath || "config.json";
      this.storage = new LocalStorage(filePath);
    }
  }

  async init() {
    // 启动时从存储加载配置并合并
    const storedConfig = await this.storage.load();
    const hasStoredConfig = Object.keys(storedConfig).length > 0;
    this.currentConfig = { ...this.currentConfig, ...storedConfig };
    // 重新从合并后的配置获取 adminApiKey
    if (this.currentConfig.adminApiKey) {
        this.adminApiKey = this.currentConfig.adminApiKey;
    }
    
    // 启动时如果有存储的配置,输出日志
    if (hasStoredConfig) {
      const { log } = await import("./logging.ts");
      const storageType = this.currentConfig.pgStoreDsn ? "云端" : "本地";
      log("info", `已从${storageType}存储加载配置`, {}, LogPhase.STORAGE);
    }
  }

  async handleRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    
    // 只处理 /admin 路径下的 API 请求
    if (!url.pathname.startsWith("/admin/api/")) {
      return null;
    }

    // 鉴权
    const authHeader = req.headers.get("Authorization");
    if (this.adminApiKey && authHeader !== `Bearer ${this.adminApiKey}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        status: 401, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    try {
      if (url.pathname === "/admin/api/config" && req.method === "GET") {
        return await this.getConfig();
      }
      
      if (url.pathname === "/admin/api/config" && req.method === "POST") {
        return await this.updateConfig(req);
      }
      
      if (url.pathname === "/admin/api/config/sync" && req.method === "POST") {
        return await this.syncConfig();
      }

      if (url.pathname === "/admin/api/health" && req.method === "GET") {
        return await this.getHealth();
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { 
        status: 404, 
        headers: { "Content-Type": "application/json" } 
      });
    } catch (error) {
      console.error("Admin API Error:", error);
      return new Response(JSON.stringify({ error: String(error) }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }

  private getConfig(): Response {
    return new Response(JSON.stringify(this.currentConfig), {
      headers: { "Content-Type": "application/json" }
    });
  }

  private async updateConfig(req: Request): Promise<Response> {
    const newPartialConfig = await req.json();
    
    // 基础校验：禁止修改敏感系统字段（如端口，除非重启，暂不支持在线热修改核心网络参数）
    // 这里我们可以根据需要合并配置
    const updatedConfig = { ...this.currentConfig, ...newPartialConfig };
    
    // 保存到存储层
    await this.storage.save(updatedConfig);
    
    // 更新内存配置
    this.currentConfig = updatedConfig;
    
    // 输出配置更新日志
    const { log, logConfigInfo } = await import("./logging.ts");
    const storageType = this.currentConfig.pgStoreDsn ? "云端" : "本地";
    log("info", `配置已保存 (${storageType})`, {}, LogPhase.STORAGE);
    logConfigInfo(this.currentConfig as unknown as Record<string, unknown>, "⚙️  程序运行中配置");
    
    return new Response(JSON.stringify({ status: "success", config: this.currentConfig }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  private async syncConfig(): Promise<Response> {
    try {
      // 从存储重新加载配置
      const storedConfig = await this.storage.load();
      const hasStoredConfig = Object.keys(storedConfig).length > 0;
      
      if (!hasStoredConfig) {
        return new Response(JSON.stringify({ 
          status: "no_config", 
          message: "存储中没有找到配置" 
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // 合并配置
      this.currentConfig = { ...this.currentConfig, ...storedConfig };
      
      // 输出同步日志
      const { log, logConfigInfo } = await import("./logging.ts");
      const storageType = this.currentConfig.pgStoreDsn ? "云端" : "本地";
      log("info", `配置同步成功 (${storageType})`, {}, LogPhase.SYNC);
      logConfigInfo(this.currentConfig as unknown as Record<string, unknown>, "⚙️  程序运行中配置");
      
      return new Response(JSON.stringify({ 
        status: "success", 
        config: this.currentConfig 
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      const { log } = await import("./logging.ts");
      log("error", "配置同步失败", { error: String(error) });
      return new Response(JSON.stringify({ 
        status: "error", 
        message: String(error) 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  private async getHealth(): Promise<Response> {
    const storageHealthy = await this.storage.healthCheck();
    return new Response(JSON.stringify({ 
      status: "ok", 
      storage: storageHealthy ? "connected" : "error" 
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 获取当前配置的引用（供 main.ts 中的代理逻辑使用）
  getCurrentConfig(): ProxyConfig {
    return this.currentConfig;
  }
}
