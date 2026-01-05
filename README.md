# cc-proxy

[![Deno](https://img.shields.io/badge/deno-v2.0+-00ADD8?logo=deno)](https://deno.land/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个基于 Deno 的智能 AI 代理服务器，通过提示词注入技术让不支持原生工具调用的 AI 模型也能完美兼容 Claude Code 的工具调用能力。

## 📖 项目简介

**cc-proxy** 是一个位于 Claude Code 客户端与上游 AI 服务之间的代理层，它通过"提示词注入 + XML 标签模拟"机制，将 Claude API 的工具调用请求转换为纯文本提示词，使得任何支持文本对话的 AI 模型（如 GPT-4、Claude 等）都能理解并执行工具调用。

### 核心价值

- **突破限制**：让不支持原生工具调用的 AI 模型也能运行 Claude Code
- **统一接口**：无论后端使用何种模型，客户端体验完全一致
- **多渠道支持**：一套配置管理多个上游服务，灵活切换
- **可视化管理**：提供 Web UI 管理后台，配置简单直观

### 工作原理

```
┌─────────────┐
│ Claude Code │ ──① Claude API 请求──▶
└─────────────┘    (包含 tools 定义)

┌──────────────────────────────────────┐
│           cc-proxy 代理层             │
│                                      │
│  ② 提示词注入                         │
│     工具定义 → XML 格式提示词          │
│                                      │
│  ③ 协议转换                          │
│     Claude API → OpenAI/Anthropic    │
└──────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │   上游 AI 服务    │ ──④ 返回 XML 格式的工具调用──▶
         │ (GPT-4/Claude等)  │
         └──────────────────┘

┌──────────────────────────────────────┐
│           cc-proxy 代理层             │
│                                      │
│  ⑤ 解析 XML 工具调用                  │
│                                      │
│  ⑥ 转换为标准 Claude API 响应         │
└──────────────────────────────────────┘
                    │
                    ▼
         ┌─────────────┐
         │ Claude Code │ ◀── 标准 Claude API 响应
         └─────────────┘     (tool_use 消息)
```

## ✨ 核心特性

### 🛠️ 协议与模型支持

- ✅ **多协议支持**：原生支持 OpenAI 和 Anthropic 两种上游协议
- ✅ **工具调用模拟**：通过 XML 提示词注入实现工具调用能力
- ✅ **思考模式**：完美支持思维链模型的 thinking 块
- ✅ **流式响应**：完整的 SSE 流式处理，实时返回结果

### 🔄 渠道管理

- ✅ **多渠道配置**：支持配置多个上游服务
- ✅ **动态路由**：使用 `渠道名+模型名` 格式灵活切换
- ✅ **协议自动识别**：根据 URL 自动识别上游协议类型
- ✅ **Web UI 管理**：可视化配置界面，实时生效

### 🔐 安全与控制

- ✅ **API Key 验证**：支持客户端 API Key 验证
- ✅ **密钥透传**：可选择将客户端密钥透传给上游
- ✅ **速率限制**：内置请求频率控制
- ✅ **访问控制**：管理后台密码保护

### 📊 监控与存储

- ✅ **Token 计数**：精确的 tiktoken 本地计数
- ✅ **结构化日志**：详细的请求日志，支持按 ID 追踪
- ✅ **多种存储**：支持本地文件或 PostgreSQL 数据库
- ✅ **健康检查**：提供 `/healthz` 端点

## 🚀 快速开始

### 环境要求

- **Deno**: 2.0+ ([安装指南](https://deno.land/manual/getting_started/installation))
- **操作系统**: Linux、macOS 或 Windows
- **网络**: 稳定的互联网连接

### 方式一：本地运行

1. **克隆项目**

```bash
git clone https://github.com/Passerby1011/cc-proxy.git
cd cc-proxy/deno-proxy
```

2. **启动服务**

```bash
# 设置管理员密钥（必需）
export ADMIN_API_KEY=your-secure-admin-key

# 可选：配置端口和日志级别
export PORT=3456
export LOG_LEVEL=info

# 启动服务
deno run --allow-net --allow-env --allow-read --allow-write src/main.ts
```

3. **访问管理后台**

打开浏览器访问 `http://localhost:3456/admin`，使用 `ADMIN_API_KEY` 登录。

### 方式二：Docker 部署

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

详细部署指南请参考 [Deno Deploy 部署指南](docs/deno-deployment-guide.md)。

## ⚙️ 配置说明

### 通过 Web UI 配置（推荐）

访问 `http://localhost:3456/admin` 进入管理后台，可以直观地配置：

#### 1. 渠道管理

添加上游 AI 服务渠道：

- **渠道标识**：用于客户端请求时的前缀（如 `openai`、`claude`）
- **Base URL**：上游 API 地址
- **API Key**：上游服务密钥（可选，支持客户端透传）
- **协议类型**：`openai` 或 `anthropic`（可自动识别）

#### 2. 系统配置

- **网络设置**：端口、绑定地址、超时时间
- **安全控制**：客户端 API Key、速率限制
- **Token 管理**：价格倍数、密钥透传
- **数据存储**：本地文件或 PostgreSQL

#### 3. 配置持久化

- **本地文件模式**：配置保存到 `config.json`（默认）
- **PostgreSQL 模式**：设置 `PGSTORE_DSN` 环境变量后使用数据库
- **实时同步**：点击"同步数据"按钮重新加载配置

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
# 渠道 1
export CHANNEL_1_NAME=openai
export CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions
export CHANNEL_1_API_KEY=sk-...
export CHANNEL_1_PROTOCOL=openai

# 渠道 2
export CHANNEL_2_NAME=claude
export CHANNEL_2_BASE_URL=https://api.anthropic.com/v1/messages
export CHANNEL_2_API_KEY=sk-ant-...
export CHANNEL_2_PROTOCOL=anthropic
```

## 📡 使用方式

### 客户端请求格式

使用 `渠道名+模型名` 格式指定渠道：

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-client-api-key" \
  -d '{
    "model": "openai+gpt-4o",
    "messages": [
      {"role": "user", "content": "What is the weather in Beijing?"}
    ],
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "input_schema": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "City name"}
          },
          "required": ["city"]
        }
      }
    ],
    "max_tokens": 1024
  }'
```

**模型名格式说明**：
- `渠道名+模型名`：使用指定渠道，如 `openai+gpt-4o`、`claude+claude-3-5-sonnet-20241022`
- 仅模型名：使用第一个配置的渠道

### 配置 Claude Code 客户端

在 Claude Code 的配置中设置代理地址：

```bash
# 设置代理 URL
export ANTHROPIC_BASE_URL=http://localhost:3456

# 设置 API Key（如果配置了 CLIENT_API_KEY）
export ANTHROPIC_API_KEY=your-client-api-key
```

## 🏗️ 架构设计

### 核心组件

1. **`prompt_inject.ts`**：提示词注入器，将工具定义转换为 XML 格式提示词
2. **`parser.ts`**：智能解析器，识别并提取上游返回的 XML 工具调用
3. **`claude_writer.ts`**：标准输出器，生成符合 Claude API 规范的 SSE 响应
4. **`map_claude_to_openai.ts`**：协议适配器，将请求映射为 OpenAI 格式
5. **`upstream.ts`**：上游转发器，统一处理不同协议的流式请求
6. **`config.ts`**：配置管理器，支持环境变量和存储后端
7. **`admin_service.ts`**：管理服务，提供 Web UI 和 API

### 请求处理流程

```
客户端请求 → 认证验证 → 提示词注入 → 协议转换 → 上游转发
                                                    ↓
客户端响应 ← 标准化输出 ← XML 解析 ← 流式接收 ← 上游响应
```

详细架构设计请参考 [架构文档](docs/pipeline.md)。

## 📚 API 端点

### POST /v1/messages

Claude API 兼容的消息端点，支持工具调用和流式响应。

### POST /v1/messages/count_tokens

Token 计数端点，用于估算请求的 token 消耗。

### GET /healthz

健康检查端点，返回服务状态。

### GET /admin

管理后台 Web UI 入口。

### POST /admin/api/config

管理 API，用于获取和更新配置（需要 `ADMIN_API_KEY` 认证）。

## 📖 文档索引

### 核心文档

- 📘 [架构设计](docs/pipeline.md) - 详细的架构设计和工作流程
- 📗 [使用示例](docs/deno-server-examples.md) - 完整的请求响应示例
- 📕 [运维手册](docs/deno-server-runbook.md) - 运维操作指南

### 功能文档

- 🔢 [Token 计数](docs/TOKEN_COUNTING.md) - Token 计数功能详解
- 📝 [日志配置](docs/logging-configuration.md) - 日志系统配置说明

### 部署文档

- 🚀 [部署指南](docs/deno-deployment-guide.md) - 完整的部署指南
- 📦 [文档中心](docs/README.md) - 文档导航

## 🔧 故障排除

### 工具调用不触发

**可能原因**：
- 上游模型指令遵循能力较弱
- `max_tokens` 设置过小
- 上下文长度不足

**解决方案**：
- 使用指令遵循能力强的模型（GPT-4、Claude 3.5 等）
- 增加 `max_tokens` 至 1024 以上
- 开启 `LOG_LEVEL=debug` 查看详细日志

### 协议错误

**可能原因**：
- 渠道协议类型配置错误
- Base URL 端点路径不正确

**解决方案**：
- OpenAI 协议使用 `/v1/chat/completions` 端点
- Anthropic 协议使用 `/v1/messages` 端点
- 检查管理后台的协议类型设置

### Token 计数不准确

**解决方案**：
- 调整 `TOKEN_MULTIPLIER` 参数
- 参考 [Token 计数文档](docs/TOKEN_COUNTING.md)

### 更多问题

1. 开启详细日志：`LOG_LEVEL=debug`
2. 查看 [Issues](https://github.com/Passerby1011/cc-proxy/issues)
3. 提交新 Issue 并附上日志

## 🤝 贡献指南

欢迎贡献代码、文档或提出建议！

### 开发流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'Add amazing feature'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request

### 代码规范

- 使用 TypeScript 编写代码
- 遵循 Deno 官方代码风格
- 添加必要的注释和文档
- 确保所有测试通过

### 运行测试

```bash
# 单元测试
deno test --allow-env --allow-net

# 集成测试
./scripts/test-proxy.sh
```

## 📄 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- 感谢 [Anthropic](https://www.anthropic.com/) 提供 Claude API
- 感谢 [Deno](https://deno.land/) 提供优秀的运行时
- 感谢所有贡献者的支持

---

**Made with ❤️ by the cc-proxy team**