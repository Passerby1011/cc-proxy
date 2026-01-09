# cc-proxy

[![Deno](https://img.shields.io/badge/deno-v2.0+-00ADD8?logo=deno)](https://deno.land/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个基于 Deno 的智能 AI 代理服务器，通过提示词注入技术让不支持原生工具调用的 AI 模型也能完美兼容 Claude Code 等工具调用场景。

## 📖 项目简介

**cc-proxy** 是一个位于 Claude Code 客户端与上游 AI 服务之间的透明代理层，它通过"提示词注入 + XML 标签模拟"机制，将标准的工具调用请求转换为纯文本提示词，使得任何支持文本对话的 AI 模型（如 GPT-4、Claude、DeepSeek 等）都能理解并执行工具调用。

### 核心价值

- 🚀 **突破限制**：让不支持原生工具调用的 AI 模型也能运行 Claude Code
- 🔄 **统一接口**：无论后端使用何种模型，客户端体验完全一致  
- 🌐 **多渠道支持**：一套配置管理多个上游服务，灵活切换
- 🎯 **可视化管理**：提供 Web UI 管理后台，配置简单直观
- 💡 **思考模式支持**：完美适配思维链模型的 thinking 块
- 📊 **详细日志**：结构化日志记录，便于调试和监控

### 工作原理

```
┌─────────────┐
│ Claude Code │ ──① Claude API 请求──▶
└─────────────┘    (包含 tools 定义)

┌──────────────────────────────────────┐
│           cc-proxy 代理层             │
│                                      │
│  ② 提示词注入 (prompt_inject.ts)     │
│     • 工具定义 → XML 格式提示词       │
│     • 注入到 system prompt           │
│     • 生成唯一分隔符                 │
│                                      │
│  ③ 协议转换 (map_claude_to_openai.ts)│
│     • Claude Messages API            │
│       → OpenAI Chat Completions      │
│     • 保持流式兼容                   │
│                                      │
│  ④ 上游转发 (upstream.ts)            │
│     • 支持 OpenAI 协议               │
│     • 支持 Anthropic 协议            │
│     • SSE 流式处理                   │
└──────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │   上游 AI 服务    │ ──⑤ 返回 XML 格式的工具调用──▶
         │ (GPT-4/Claude等)  │
         └──────────────────┘

┌──────────────────────────────────────┐
│           cc-proxy 代理层             │
│                                      │
│  ⑥ 智能解析 (parser.ts)              │
│     • 识别 XML 工具调用块            │
│     • 识别 <thinking> 块             │
│     • 提取工具名称和参数             │
│                                      │
│  ⑦ 标准化输出 (claude_writer.ts)     │
│     • 生成标准 Claude SSE 事件       │
│     • tool_use 消息块                │
│     • thinking 消息块                │
└──────────────────────────────────────┘
                    │
                    ▼
         ┌─────────────┐
         │ Claude Code │ ◀── 标准 Claude API 响应
         └─────────────┘
```

## ✨ 核心特性

### 🛠️ 工具调用能力

- ✅ **提示词注入**：将工具定义自动转换为 XML 格式的提示词模板
- ✅ **智能解析**：从模型响应中识别并提取 XML 格式的工具调用
- ✅ **标准化输出**：将解析结果转换为符合 Claude API 规范的 SSE 事件流
- ✅ **多轮对话**：完整支持工具调用-结果-继续的多轮交互
- ✅ **思考模式**：特殊支持 `<thinking>` 块，完美适配思维链模型

### 🔄 协议支持

- ✅ **双协议支持**：原生支持 OpenAI 和 Anthropic 两种上游协议
- ✅ **自动识别**：根据 URL 或配置自动识别上游协议类型
- ✅ **流式响应**：完整的 SSE 流式处理，实时返回结果
- ✅ **非流式模式**：同时支持非流式请求（stream: false）

### 🌐 渠道管理

- ✅ **多渠道配置**：支持配置多个上游服务（OpenAI、Claude、DeepSeek 等）
- ✅ **动态路由**：使用 `渠道名+模型名` 格式灵活切换（如 `openai+gpt-4o`）
- ✅ **Web UI 管理**：可视化配置界面，修改配置实时生效
- ✅ **热加载**：支持配置文件热重载，无需重启服务

### 🔐 安全与控制

- ✅ **API Key 验证**：支持客户端 API Key 验证
- ✅ **密钥透传**：可选择将客户端密钥透传给上游
- ✅ **速率限制**：内置请求频率控制
- ✅ **访问控制**：管理后台密码保护

### 📊 监控与日志

- ✅ **结构化日志**：详细的请求日志，支持按 requestId 追踪
- ✅ **Token 计数**：精确的 tiktoken 本地计数
- ✅ **阶段日志**：记录请求处理的每个阶段（注入、转换、解析等）
- ✅ **多种存储**：支持本地文件或 PostgreSQL 数据库
- ✅ **健康检查**：提供 `/healthz` 端点

## 🚀 快速开始

### 前置要求

- **Deno**: 2.0+ ([安装指南](https://deno.land/manual/getting_started/installation))
- **操作系统**: Linux、macOS 或 Windows
- **网络**: 稳定的互联网连接

### 方式一：本地运行

1. **克隆项目**

```bash
git clone https://github.com/Passerby1011/cc-proxy.git
cd cc-proxy/deno-proxy
```

2. **配置环境变量**

```bash
# 设置管理员密钥（必需）
export ADMIN_API_KEY=your-secure-admin-key

# 可选：配置端口和日志级别
export PORT=3456
export LOG_LEVEL=info
```

3. **启动服务**

```bash
deno run --allow-net --allow-env --allow-read --allow-write src/main.ts
```

4. **访问管理后台**

打开浏览器访问 `http://localhost:3456/admin`，使用 `ADMIN_API_KEY` 登录。

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

## ⚙️ 配置说明

### 通过 Web UI 配置（推荐）

访问 `http://localhost:3456/admin` 进入管理后台，可以直观地配置：

#### 1. 渠道管理

添加上游 AI 服务渠道：

- **渠道标识**：用于客户端请求时的前缀（如 `openai`、`claude`、`deepseek`）
- **Base URL**：上游 API 地址
- **API Key**：上游服务密钥（可选，支持客户端透传）
- **协议类型**：`openai` 或 `anthropic`（通常会自动识别）

#### 2. 系统配置

- **网络设置**：端口、绑定地址、超时时间
- **安全控制**：客户端 API Key、速率限制
- **Token 管理**：价格倍数、密钥透传
- **数据存储**：本地文件或 PostgreSQL

#### 3. 配置持久化

- **本地文件模式**：配置保存到 `config.json`（默认）
- **PostgreSQL 模式**：设置 `PGSTORE_DSN` 环境变量后使用数据库
- **实时同步**：修改配置后自动生效，或点击"同步数据"按钮

### 通过环境变量配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `ADMIN_API_KEY` | - | **必需** - 管理后台登录密钥 |
| `PORT` | `3456` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务绑定地址 |
| `LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |
| `CLIENT_API_KEY` | - | 客户端 API Key 验证（可选） |
| `PASSTHROUGH_API_KEY` | `false` | 是否透传客户端密钥给上游 |
| `MAX_REQUESTS_PER_MINUTE` | `10` | 每分钟最大请求数 |
| `TIMEOUT_MS` | `120000` | 请求超时时间（毫秒） |
| `TOKEN_MULTIPLIER` | `1.0` | Token 计数倍数 |
| `PGSTORE_DSN` | - | PostgreSQL 连接字符串 |
| `CONFIG_FILE_PATH` | `config.json` | 本地配置文件路径 |

#### 渠道配置（环境变量方式）

```bash
# 渠道 1: OpenAI
export CHANNEL_1_NAME=openai
export CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions
export CHANNEL_1_API_KEY=sk-...
export CHANNEL_1_PROTOCOL=openai

# 渠道 2: Claude
export CHANNEL_2_NAME=claude
export CHANNEL_2_BASE_URL=https://api.anthropic.com/v1/messages
export CHANNEL_2_API_KEY=sk-ant-...
export CHANNEL_2_PROTOCOL=anthropic

# 渠道 3: DeepSeek
export CHANNEL_3_NAME=deepseek
export CHANNEL_3_BASE_URL=https://api.deepseek.com/v1/chat/completions
export CHANNEL_3_API_KEY=sk-...
export CHANNEL_3_PROTOCOL=openai
```

## 📡 使用方式

### 1. 配置 Claude Code 客户端

在 Claude Code 的配置中设置代理地址：

```bash
# 设置代理 URL
export ANTHROPIC_BASE_URL=http://localhost:3456

# 设置 API Key（如果配置了 CLIENT_API_KEY）
export ANTHROPIC_API_KEY=your-client-api-key
```

### 2. 使用 API

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-client-api-key" \
  -d '{
    "model": "openai+gpt-4o",
    "messages": [
      {"role": "user", "content": "请帮我查询北京的天气"}
    ],
    "tools": [
      {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "input_schema": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "城市名称"}
          },
          "required": ["city"]
        }
      }
    ],
    "max_tokens": 2048
  }'
```

**模型名格式说明**：
- `渠道名+模型名`：使用指定渠道（如 `openai+gpt-4o`、`deepseek+deepseek-chat`）
- 仅模型名：使用第一个配置的渠道

## 🔧 故障排除

### 问题 1：工具调用不触发

**症状**：模型返回普通文本，没有调用工具

**解决方案**：
1. 使用指令遵循能力强的模型（GPT-4、Claude 3.5、DeepSeek-V3 等）
2. 增加 `max_tokens` 至 2048 以上
3. 开启 `LOG_LEVEL=debug` 查看提示词注入情况

### 问题 2：协议错误

**症状**：请求返回 500 错误或超时

**解决方案**：
1. 检查管理后台的协议类型和 URL 配置
2. OpenAI 协议使用 `/v1/chat/completions` 端点
3. Anthropic 协议使用 `/v1/messages` 端点

### 问题 3：解析错误

**症状**：工具调用格式错误

**解决方案**：
1. 查看日志中的 `[PHASE: parse]` 部分
2. 检查模型实际输出的内容
3. 尝试更换模型

### 获取帮助

- **查看日志**：`LOG_LEVEL=debug`
- **GitHub Issues**：[提交问题](https://github.com/Passerby1011/cc-proxy/issues)

## 🗺️ 项目路线图

### 当前版本（v1.0）
- ✅ 核心工具调用功能
- ✅ 多渠道管理
- ✅ Web UI 管理后台
- ✅ 思考模式支持

### 计划功能
- 🔄 Web Search 支持，集成（Firecrawl）
- 🔄 Web Fetch 支持，集成（Firecrawl）

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [Anthropic](https://www.anthropic.com/) - Claude API
- [Deno](https://deno.land/) - 现代化运行时
- 所有贡献者

---

**Made with ❤️ by the cc-proxy team**
