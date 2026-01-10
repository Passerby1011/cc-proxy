# cc-proxy

[![Deno](https://img.shields.io/badge/deno-v2.0+-00ADD8?logo=deno)](https://deno.land/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个基于 Deno 的智能 AI 代理服务器，让不支持原生工具调用的 AI 模型也能完美兼容 Claude Code。

## ✨ 核心功能

### 🛠️ 工具调用能力
- **提示词注入**：将工具定义转换为 XML 格式提示词，让任何模型都能理解工具调用
- **智能解析**：从模型响应中识别并提取 XML 格式的工具调用
- **标准化输出**：转换为符合 Claude API 规范的 SSE 事件流
- **多轮对话**：完整支持工具调用-结果-继续的多轮交互
- **思考模式**：特殊支持 `<thinking>` 块，完美适配思维链模型
- **工具调用重试**：自动重试解析失败的工具调用，提高成功率

### 🔍 Web Search & Fetch
- **Web Search 拦截**：集成 Firecrawl，拦截 Anthropic Web Search 工具
- **Web Fetch 拦截**：抓取任意网页内容，转换为 AI 可理解的格式
- **简单模式**：直接返回搜索结果和网页内容
- **智能模式**：结合上游 LLM 生成智能分析和总结
- **深入浏览**：AI 自动选择重要页面深入抓取并综合分析
- **域名过滤**：支持允许/阻止特定域名
- **流式输出**：支持流式返回 Web Search 分析结果

### 🔄 协议与渠道
- **双协议支持**：原生支持 OpenAI 和 Anthropic 两种上游协议
- **多渠道管理**：一套配置管理多个上游服务（OpenAI、Claude、DeepSeek 等）
- **动态路由**：使用 `渠道名+模型名` 格式灵活切换（如 `openai+gpt-4o`）
- **流式响应**：完整的 SSE 流式处理，实时返回结果
- **自动识别**：根据 URL 自动识别上游协议类型

### 🎯 管理与监控
- **Web UI 管理**：可视化配置界面，修改配置实时生效
- **结构化日志**：详细的请求日志，支持按 requestId 追踪
- **Token 计数**：精确的 tiktoken 本地计数
- **速率限制**：内置请求频率控制
- **健康检查**：提供 `/healthz` 端点

### 🔐 安全控制
- **API Key 验证**：支持客户端 API Key 验证
- **密钥透传**：可选择将客户端密钥透传给上游
- **访问控制**：管理后台密码保护

## 🚀 部署方式

### 方式一：本地运行

**前置要求**：
- Deno 2.0+ ([安装指南](https://deno.land/manual/getting_started/installation))

**步骤**：
```bash
# 1. 克隆项目
git clone https://github.com/Passerby1011/cc-proxy.git
cd cc-proxy/deno-proxy

# 2. 配置环境变量（必需）
export ADMIN_API_KEY=your-secure-admin-key

# 3. 启动服务
deno run --allow-net --allow-env --allow-read --allow-write src/main.ts

# 4. 访问管理后台
# 浏览器打开 http://localhost:3456/admin
```

### 方式二：Docker Compose（推荐）

```bash
# 使用 Docker Compose
docker-compose up -d

# 或使用 Docker 命令
docker build -t cc-proxy:latest .
docker run -d \
  --name cc-proxy \
  -p 3456:3456 \
  -e ADMIN_API_KEY=your-secure-admin-key \
  -v $(pwd)/config.json:/app/config.json \
  cc-proxy:latest
```

### 方式三：Deno Deploy

```bash
# 安装 deployctl
deno install -gArf jsr:@deno/deployctl

# 登录并部署
deployctl login
deployctl deploy --project=cc-proxy deno-proxy/src/main.ts
```

部署后访问管理后台 `/admin` 进行配置。

## ⚙️ 配置参数

### 基础配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `ADMIN_API_KEY` | - | **必需** - 管理后台登录密钥 |
| `PORT` | `3456` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务绑定地址 |
| `AUTO_PORT` | `false` | 启用自动端口分配（设为 `true` 时 PORT 无效） |
| `LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |

### 安全与速率控制

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CLIENT_API_KEY` | - | 客户端 API Key 验证（可选） |
| `PASSTHROUGH_API_KEY` | `false` | 是否透传客户端密钥给上游 |
| `MAX_REQUESTS_PER_MINUTE` | `10` | 每分钟最大请求数 |
| `TIMEOUT_MS` | `120000` | 请求超时时间（毫秒） |
| `AGGREGATION_INTERVAL_MS` | `35` | 流式响应聚合间隔（毫秒） |

### 上游协议配置(推荐网页配置)

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `UPSTREAM_PROTOCOL` | `openai` | 默认上游协议（openai/anthropic） |
| `UPSTREAM_BASE_URL` | - | 默认上游 API 地址（向后兼容） |
| `UPSTREAM_API_KEY` | - | 默认上游 API 密钥（向后兼容） |
| `UPSTREAM_MODEL` | - | 强制模型覆盖（可选） |
| `TOKEN_MULTIPLIER` | `1.0` | Token 计数倍数（支持 `1.2`、`x1.2`、`120%` 格式） |

### 渠道配置（多渠道模式）

```bash
# 渠道格式：CHANNEL_{N}_{FIELD}
# N 从 1 开始递增，直到缺少必要字段为止

# 渠道 1: OpenAI
export CHANNEL_1_NAME=openai
export CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions
export CHANNEL_1_API_KEY=sk-...
export CHANNEL_1_PROTOCOL=openai  # 可选，会自动识别
export CHANNEL_1_AUTO_TRIGGER=true  # 可选，渠道级拦截触发模式

# 渠道 2: Claude
export CHANNEL_2_NAME=claude
export CHANNEL_2_BASE_URL=https://api.anthropic.com/v1/messages
export CHANNEL_2_API_KEY=sk-ant-...
export CHANNEL_2_PROTOCOL=anthropic
export CHANNEL_2_AUTO_TRIGGER=false  # 可选，按需拦截

# 渠道 3: DeepSeek
export CHANNEL_3_NAME=deepseek
export CHANNEL_3_BASE_URL=https://api.deepseek.com/v1/chat/completions
export CHANNEL_3_API_KEY=sk-...
export CHANNEL_3_PROTOCOL=openai
```

**使用方式**：请求时使用 `渠道名+模型名` 格式，如：
- `openai+gpt-4o`
- `claude+claude-3-5-sonnet-20241022`
- `deepseek+deepseek-chat`

**高级用法 - 模型名前缀控制拦截模式**：
- `cc+渠道+模型` → 强制使用**自动触发模式**（适用于 Claude Code）
- `chat+渠道+模型` → 强制使用**按需拦截模式**（适用于 Chat 应用）

示例：
- `cc+openai+gpt-4o` - 使用 OpenAI 渠道，自动触发搜索
- `chat+claude+claude-3-5-sonnet` - 使用 Claude 渠道，等待 AI 调用
- `openai+gpt-4o` - 使用 OpenAI 渠道，遵循渠道或全局配置

### 数据存储配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PGSTORE_DSN` | - | PostgreSQL 连接字符串（可选，留空使用本地文件） |
| `CONFIG_FILE_PATH` | `config.json` | 本地配置文件路径 |

**PostgreSQL DSN 格式**：
```
postgresql://username:password@host:port/database
```

### 工具调用重试配置(推荐网页配置)

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `TOOL_RETRY_ENABLED` | `false` | 启用工具调用重试 |
| `TOOL_RETRY_MAX_RETRIES` | `1` | 最大重试次数（建议 1-2） |
| `TOOL_RETRY_TIMEOUT` | `30000` | 单次重试超时（毫秒） |
| `TOOL_RETRY_KEEP_ALIVE` | `true` | 重试期间保持连接 |
| `TOOL_RETRY_PROMPT_TEMPLATE` | - | 自定义修正提示模板（可选） |

**注意**：启用重试会产生额外的 API 费用，建议仅在工具调用失败率较高时启用。

### Firecrawl API 配置(推荐网页配置)

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FIRECRAWL_API_KEY` | - | Firecrawl API 密钥（从 [firecrawl.dev](https://firecrawl.dev) 获取） |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev/v2` | Firecrawl API 基础 URL |
| `FIRECRAWL_TIMEOUT` | `30000` | 请求超时时间（毫秒） |
| `FIRECRAWL_MAX_RETRIES` | `3` | 最大重试次数 |
| `FIRECRAWL_RETRY_DELAY` | `1000` | 重试延迟（毫秒） |

### Web Search & Fetch 配置 (推荐网页配置)

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `ENABLE_WEB_SEARCH_INTERCEPT` | `false` | 启用 Web Search 拦截 |
| `ENABLE_WEB_FETCH_INTERCEPT` | `false` | 启用 Web Fetch 拦截 |
| `WEB_TOOLS_AUTO_TRIGGER` | `true` | 全局拦截触发模式（true=自动触发，false=按需拦截） |
| `WEB_SEARCH_MODE` | `smart` | 工作模式（simple/smart） |
| `MAX_SEARCH_RESULTS` | `10` | 最大搜索结果数量 |
| `DEEP_BROWSE_ENABLED` | `false` | 启用深入浏览（智能模式） |
| `DEEP_BROWSE_COUNT` | `3` | 深入浏览的页面数量（1-5） |
| `DEEP_BROWSE_PAGE_CONTENT_LIMIT` | `5000` | 每页内容字符数限制 |
| `MAX_FETCH_CONTENT_TOKENS` | `100000` | Web Fetch 内容最大 token 数 |

#### 🎯 拦截触发模式详解

**三级配置优先级**（从高到低）：

1. **模型名前缀**（最高优先级，直接在请求中指定）
   - `cc+渠道+模型` → 强制**自动触发模式**
   - `chat+渠道+模型` → 强制**按需拦截模式**

2. **渠道级配置**（中优先级，通过环境变量或 WebUI 配置）
   - `CHANNEL_X_AUTO_TRIGGER=true` → 该渠道使用自动触发
   - `CHANNEL_X_AUTO_TRIGGER=false` → 该渠道使用按需拦截
   - 未设置时使用全局配置

3. **全局配置**（默认配置）
   - `WEB_TOOLS_AUTO_TRIGGER=true`（默认） → 全局自动触发
   - `WEB_TOOLS_AUTO_TRIGGER=false` → 全局按需拦截

**模式说明**：

| 模式 | 触发时机 | 搜索词来源 | 适用场景 |
|------|---------|-----------|---------|
| **自动触发模式** | 检测到工具定义立即执行 | AI 自动生成搜索词 | Claude Code、MCP 等工具密集型应用 |
| **按需拦截模式** | 等待 AI 主动调用工具 | 使用 AI 传入的 query | Chat 应用、普通对话场景 |

**使用示例**：

```bash
# 场景 1: Claude Code 专用渠道
export CHANNEL_1_NAME=code
export CHANNEL_1_AUTO_TRIGGER=true  # 该渠道自动触发
# 请求：code+claude-3-5-sonnet

# 场景 2: Chat 应用专用渠道
export CHANNEL_2_NAME=chat
export CHANNEL_2_AUTO_TRIGGER=false  # 该渠道按需拦截
# 请求：chat+gpt-4o

# 场景 3: 使用模型名前缀临时覆盖
# cc+chat+gpt-4o → 即使 chat 渠道配置为按需，也强制自动触发
# chat+code+claude-3-5-sonnet → 即使 code 渠道配置为自动，也强制按需
```

**配置建议**：
- **Claude Code 用户**：设置 `WEB_TOOLS_AUTO_TRIGGER=true`（默认）
- **Chat 应用**：设置 `WEB_TOOLS_AUTO_TRIGGER=false` 或使用 `chat+` 前缀
- **混合场景**：为不同渠道设置不同的 `AUTO_TRIGGER`，或使用模型名前缀

#### 🔍 搜索模式说明

**简单模式（simple）**：
- 直接返回搜索结果和网页内容
- 无 AI 分析，响应速度快
- 适合需要原始数据的场景

**智能模式（smart，推荐）**：
- 调用上游 LLM 分析搜索结果
- 自动生成总结和关键信息提取
- 支持深入浏览功能

**深入浏览（Deep Browse）**：
- 仅在智能模式下可用
- AI 自动选择最有价值的页面深入抓取
- 综合多个页面内容生成最终分析


## 🙏 致谢

本项目的开发离不开以下优秀的开源项目和服务：

### 核心依赖
- [Deno](https://deno.land/) - 现代化、安全的 JavaScript/TypeScript 运行时
- [Anthropic Claude](https://www.anthropic.com/) - Claude API 和工具调用标准
- [Firecrawl](https://firecrawl.dev) - 强大的 Web 数据抓取和搜索 API

### 数据存储
- [Neon](https://neon.tech/) - Serverless PostgreSQL 数据库
- [PostgreSQL](https://www.postgresql.org/) - 开源关系型数据库

### 灵感来源
- [b4u2cc](https://github.com/CassiopeiaCode/b4u2cc) - 工具调用代理的原始概念
- [AnyToolCall](https://github.com/AliyahZombie/AnyToolCall) - 提示词注入技术参考

### 特别感谢
- 所有贡献者和社区成员
- 提供反馈和建议的用户
- 开源社区的支持

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

---

**Made with ❤️ by the cc-proxy team**
