# cc-proxy

[![Deno](https://img.shields.io/badge/deno-v2.0+-00ADD8?logo=deno)](https://deno.land/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个基于 Deno 的 AI 代理服务器，支持 `OpenAI Chat Completions`、`OpenAI Responses`、`Anthropic Messages` 三类协议转换，并让不支持原生工具调用的模型也能兼容 Claude Code、Chat 应用和工具调用场景。

## ✨ 核心功能

### 🛠️ 工具调用能力
- **XML / 提示词注入**：将工具定义转换为提示词，让不支持原生工具调用的上游也能工作
- **原生工具调用**：支持上游直接透传 tools / tool_use / Responses tool events/
- **智能解析**：从模型响应中识别并提取工具调用，转换为统一的对外协议格式
- **多轮交互**：完整支持工具调用 → 工具结果 → 继续回答的链路
- **思考模式**：支持 `<thinking>` 块和相关流式输出
- **工具调用重试**：自动修复解析失败的工具调用，提高成功率

### 🔍 Web Search & Fetch
- **Web Search 拦截**：集成 Firecrawl，可拦截并模拟 Anthropic / OpenAI 原生 Web Search 工具
- **Web Fetch 拦截**：可拦截并模拟 Anthropic / OpenAI 原生 Web Fetch 工具
- **简单模式**：直接返回搜索结果和网页内容
- **智能模式**：结合上游 LLM 生成分析、总结和归纳
- **深入浏览**：AI 自动选择重要页面继续抓取并综合分析
- **流式输出**：支持流式返回搜索分析与工具结果

### 🔄 协议与渠道
- **三类上游协议**：支持 `openai`、`openai-responses`、`anthropic`
- **三类对外 API**：提供 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`
- **多渠道管理**：可同时配置多个上游服务（OpenAI、Claude、DeepSeek 等）
- **动态路由**：使用 `渠道名+模型名` 格式切换渠道，例如 `openai+gpt-4o`
- **自动识别**：根据 URL 自动识别上游协议类型
- **流式 / 非流式**：三类协议均支持流式与非流式转发

### 🎯 管理与监控
- **Web UI 管理**：可视化配置界面，支持协议切换、渠道管理、能力概览、预设 URL
- **结构化日志**：支持请求开始、协议转换、上游构建、工具调用、流式阶段日志
- **Token 计数**：本地 token 计数
- **速率限制**：内置请求频率控制
- **健康检查**：提供 `/healthz` 端点

### 🔐 安全控制
- **API Key 验证**：支持客户端 API Key 验证
- **密钥透传**：可选择将客户端密钥透传给上游
- **访问控制**：管理后台密码保护

## 📋 支持矩阵

### 对外 API

| 路径 | 协议风格 | 流式 | 非流式 | 工具调用 |
|------|----------|------|--------|----------|
| `/v1/chat/completions` | OpenAI Chat Completions | ✅ | ✅ | ✅ |
| `/v1/responses` | OpenAI Responses | ✅ | ✅ | ✅ |
| `/v1/messages` | Anthropic Messages | ✅ | ✅ | ✅ |

### 上游协议

| 上游类型 | 典型地址 | 自动识别 | 原生工具调用 | Web 工具模拟 |
|----------|----------|----------|--------------|--------------|
| `openai` | `/v1/chat/completions` | ✅ | ✅（渠道开启时） | ✅ |
| `openai-responses` | `/v1/responses` | ✅ | ✅（推荐开启） | ✅ |
| `anthropic` | `/v1/messages` | ✅ | ✅（渠道开启时） | ✅ |

### 工具调用模式

| 模式 | 适用场景 | 流式 | 非流式 | 说明 |
|------|----------|------|--------|------|
| XML / 提示词注入 | 上游不支持原生工具调用 | ✅ | ✅ | 将工具定义注入提示词，并从模型输出中解析工具调用 |
| 原生工具调用 | 上游支持 tools / tool_use / Responses tool events | ✅ | ✅ | 直接透传工具定义，保留原生工具能力 |
| Web 工具拦截 / 模拟 | OpenAI / Anthropic 原生 web search / web fetch | ✅ | ✅ | 使用 Firecrawl 执行搜索或抓取，并回填标准结果 |

## 🚀 部署方式

### 方式一：本地运行

**前置要求**：
- Deno 2.0+

```bash
# 1. 克隆项目
git clone https://github.com/Passerby1011/cc-proxy.git
cd cc-proxy/deno-proxy

# 2. 配置环境变量（至少需要管理密钥）
export ADMIN_API_KEY=your-secure-admin-key

# 3. 启动服务
deno run --allow-net --allow-env --allow-read --allow-write src/main.ts

# 4. 打开管理后台
# http://localhost:3456/admin
```

### 方式二：Docker Compose（推荐）

```bash
docker-compose up -d
```

### 方式三：Docker

```bash
docker build -t cc-proxy:latest .
docker run -d \
  --name cc-proxy \
  -p 3456:3456 \
  -e ADMIN_API_KEY=your-secure-admin-key \
  -v $(pwd)/config.json:/app/config.json \
  cc-proxy:latest
```

部署后访问 `/admin` 进行配置。

## ⚙️ 配置参数

### 基础配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `ADMIN_API_KEY` | - | **必需**，管理后台登录密钥 |
| `PORT` | `3456` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务绑定地址 |
| `AUTO_PORT` | `false` | 启用自动端口分配 |
| `LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |
| `TOKEN_MULTIPLIER` | `1.0` | Token 计数倍数，支持 `1.2`、`x1.2`、`120%` |

### 安全与速率控制

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CLIENT_API_KEY` | - | 客户端 API Key 验证（可选） |
| `PASSTHROUGH_API_KEY` | `false` | 是否透传客户端密钥给上游 |
| `MAX_REQUESTS_PER_MINUTE` | `10` | 每分钟最大请求数 |
| `TIMEOUT_MS` | `120000` | 请求超时时间（毫秒） |
| `AGGREGATION_INTERVAL_MS` | `35` | 流式响应聚合间隔（毫秒） |

### 上游协议配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `UPSTREAM_PROTOCOL` | `openai` | 默认上游协议（`openai` / `openai-responses` / `anthropic`） |
| `UPSTREAM_BASE_URL` | - | 默认上游 API 地址（向后兼容） |
| `UPSTREAM_API_KEY` | - | 默认上游 API 密钥（向后兼容） |
| `UPSTREAM_MODEL` | - | 强制模型覆盖（可选） |

### 渠道配置（多渠道模式）

支持的渠道字段：

| 字段 | 说明 |
|------|------|
| `CHANNEL_{N}_NAME` | 渠道名，供 `渠道+模型` 路由使用 |
| `CHANNEL_{N}_BASE_URL` | 上游完整请求地址 |
| `CHANNEL_{N}_API_KEY` | 上游 API Key |
| `CHANNEL_{N}_PROTOCOL` | 可选，支持 `openai` / `openai-responses` / `anthropic` |
| `CHANNEL_{N}_AUTO_TRIGGER` | 可选，控制 Web 工具自动触发或按需触发 |
| `CHANNEL_{N}_SUPPORTS_NATIVE_TOOL_CALLING` | 可选，声明该渠道是否启用原生工具调用 |
| `CHANNEL_{N}_SUPPORTS_SYSTEM_PROMPT` | 可选，声明该渠道是否支持 system prompt |

示例：

```bash
# 渠道 1: OpenAI Chat
export CHANNEL_1_NAME=openai
export CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions
export CHANNEL_1_API_KEY=sk-...
export CHANNEL_1_PROTOCOL=openai
export CHANNEL_1_AUTO_TRIGGER=true

# 渠道 2: OpenAI Responses
export CHANNEL_2_NAME=responses
export CHANNEL_2_BASE_URL=https://api.openai.com/v1/responses
export CHANNEL_2_API_KEY=sk-...
export CHANNEL_2_PROTOCOL=openai-responses
export CHANNEL_2_SUPPORTS_NATIVE_TOOL_CALLING=true
export CHANNEL_2_SUPPORTS_SYSTEM_PROMPT=true

# 渠道 3: Claude
export CHANNEL_3_NAME=claude
export CHANNEL_3_BASE_URL=https://api.anthropic.com/v1/messages
export CHANNEL_3_API_KEY=sk-ant-...
export CHANNEL_3_PROTOCOL=anthropic
export CHANNEL_3_AUTO_TRIGGER=false
export CHANNEL_3_SUPPORTS_NATIVE_TOOL_CALLING=true
```

请求时使用 `渠道名+模型名`：
- `openai+gpt-4o`
- `responses+gpt-4.1`
- `claude+claude-3-5-sonnet-20241022`

高级前缀：
- `cc+渠道+模型`：强制自动触发模式，适合 Claude Code
- `chat+渠道+模型`：强制按需拦截模式，适合普通 Chat 场景

示例：
- `cc+openai+gpt-4o`
- `cc+responses+gpt-4.1`
- `chat+claude+claude-3-5-sonnet`

### 工具调用重试配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `TOOL_RETRY_ENABLED` | `false` | 启用工具调用重试 |
| `TOOL_RETRY_MAX_RETRIES` | `1` | 最大重试次数 |
| `TOOL_RETRY_TIMEOUT` | `30000` | 单次重试超时（毫秒） |
| `TOOL_RETRY_KEEP_ALIVE` | `true` | 重试期间保持连接 |
| `TOOL_RETRY_PROMPT_TEMPLATE` | - | 自定义修正提示模板 |

### Firecrawl / Web 工具配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FIRECRAWL_API_KEY` | - | Firecrawl API 密钥 |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev/v2` | Firecrawl API 基础 URL |
| `FIRECRAWL_TIMEOUT` | `30000` | 请求超时时间 |
| `FIRECRAWL_MAX_RETRIES` | `3` | 最大重试次数 |
| `FIRECRAWL_RETRY_DELAY` | `1000` | 重试延迟 |
| `ENABLE_WEB_SEARCH_INTERCEPT` | `false` | 启用 Web Search 拦截 |
| `ENABLE_WEB_FETCH_INTERCEPT` | `false` | 启用 Web Fetch 拦截 |
| `WEB_TOOLS_AUTO_TRIGGER` | `true` | 全局拦截触发模式 |
| `WEB_SEARCH_MODE` | `smart` | 工作模式（simple/smart） |
| `DEEP_BROWSE_ENABLED` | `false` | 启用深入浏览 |
| `DEEP_BROWSE_COUNT` | `3` | 深入浏览页面数量 |
| `DEEP_BROWSE_PAGE_CONTENT_LIMIT` | `5000` | 每页内容字符数限制 |
| `MAX_SEARCH_RESULTS` | `10` | 最大搜索结果数量 |
| `MAX_FETCH_CONTENT_TOKENS` | `100000` | Web Fetch 内容最大 token 数 |

## 🖥️ 管理后台

启动后访问 `http://localhost:3456/admin`，使用 `ADMIN_API_KEY` 登录。

管理后台当前支持：
- 查看协议与渠道能力概览
- 配置默认上游协议与向后兼容单上游地址
- 创建多渠道节点，并选择 `openai` / `openai-responses` / `anthropic`
- 为渠道设置是否启用原生工具调用、是否支持 System Prompt
- 配置 Web Search / Web Fetch / Deep Browse / Tool Retry / 存储后端
- 保存配置并同步运行中配置

> 建议优先使用 Web UI 管理协议、渠道和工具相关选项，减少环境变量维护成本。

## 🙏 致谢

本项目的开发离不开以下优秀的开源项目和服务：

### 核心依赖
- [Deno](https://deno.land/) - 现代化、安全的 JavaScript/TypeScript 运行时
- [Anthropic Claude](https://www.anthropic.com/) - Claude API 和工具调用标准
- [OpenAI](https://platform.openai.com/) - Chat Completions / Responses API 与工具调用协议
- [Firecrawl](https://firecrawl.dev) - Web 搜索与抓取能力
