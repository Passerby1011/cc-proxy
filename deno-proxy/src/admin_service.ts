import { ProxyConfig, ConfigStorage } from "./config.ts";
import { LocalStorage } from "./storage_local.ts";
import { PostgresStorage } from "./storage_postgres.ts";

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
    this.currentConfig = { ...this.currentConfig, ...storedConfig };
    // 重新从合并后的配置获取 adminApiKey
    if (this.currentConfig.adminApiKey) {
        this.adminApiKey = this.currentConfig.adminApiKey;
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
        return this.getConfig();
      }
      
      if (url.pathname === "/admin/api/config" && req.method === "POST") {
        return await this.updateConfig(req);
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
      return new Response(JSON.stringify({ error: error.message }), { 
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
    
    return new Response(JSON.stringify({ status: "success", config: this.currentConfig }), {
      headers: { "Content-Type": "application/json" }
    });
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
