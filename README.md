# cc-proxy - Claude Code 代理服务器

cc-proxy 是一个基于 Deno 的代理服务器，通过“提示词注入 + XML 标签模拟”机制，让不支持原生工具调用的模型（OpenAI 或 Anthropic 格式）也能完美支持 Claude Code 的工具调用能力。

## 项目概述

本项目核心组件为 `deno-proxy`，它在 Claude Code 客户端与上游 AI 服务之间建立了一套高度解耦的流水线。无论上游使用何种协议，只要它能理解并遵循 Prompt 指令，就能通过本代理获得工具调用支持。

### 🚀 核心架构：增强与平移
新版采用了“先增强，后平移”的先进架构：
1.  **Enrichment (注入增强)**：统一在 Claude 请求层面将工具定义和历史消息文本化。
2.  **Routing & Translation (路由与平移)**：根据配置将“增强后”的请求透明映射到 OpenAI 或 Anthropic 原生协议。
3.  **Unified Streaming (统一流解析)**：无论上游返回何种 SSE 格式，均由统一的 Parser 识别工具边界，并由统一的 Writer 生成标准 Claude 响应。

## 核心功能

- **多协议支持**: 原生支持上游为 OpenAI 格式或 Anthropic 格式。
- **工具调用模拟**: 即使模型不支持原生 Function Calling，也能通过注入的 XML 指令精准触发工具。
- **思考模式 (Thinking)**: 完美支持并转换思考块，支持最新的思维链模型。
- **动态渠道切换**: 支持 `渠道名+模型名` 格式，一套配置支持无限模型。
- **API Key 透传**: 支持客户端使用自己的 API 密钥进行上游认证。
- **Token 计数**: 精确的 tiktoken 本地计数，支持自定义倍数调整。

## 快速开始

### 环境要求
- Deno 1.40+ 

### 渠道配置 (推荐方式)

新版本推荐使用“渠道”配置，支持配置多个上游服务。每个渠道通过索引（1, 2, ...）定义：

| 变量名 | 必需 | 默认值 | 说明 |
|--------|------|--------|------|
| `CHANNEL_{n}_NAME` | 是 | - | 渠道标识符，用于模型名前缀 |
| `CHANNEL_{n}_BASE_URL` | 是 | - | 上游 API 地址 |
| `CHANNEL_{n}_API_KEY` | 否 | - | 上游 API 密钥 |
| `CHANNEL_{n}_PROTOCOL` | 否 | `openai` | 上游协议类型：`openai` 或 `anthropic` |

**示例配置**:
```bash
# 渠道 1: OpenAI 兼容 API
export CHANNEL_1_NAME=my_openai
export CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions
export CHANNEL_1_API_KEY=sk-xxx
export CHANNEL_1_PROTOCOL=openai

# 渠道 2: Anthropic 原生 API (无工具调用模式)
export CHANNEL_2_NAME=my_ant
export CHANNEL_2_BASE_URL=https://api.anthropic.com/v1/messages
export CHANNEL_2_API_KEY=sk-ant-xxx
export CHANNEL_2_PROTOCOL=anthropic
```

### 客户端使用方式

配置好渠道后，客户端请求的模型名可以使用 `渠道名+模型名` 格式：

- `my_openai+gpt-4o`: 将请求通过渠道 1 发送，上游模型名为 `gpt-4o`。
- `my_ant+claude-3-5-sonnet-20241022`: 将请求通过渠道 2 发送，上游模型名为 `claude-3-5-sonnet-20241022`。

> 如果不带 `+` 号，默认使用配置中的第一个渠道。

## 详细环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `UPSTREAM_PROTOCOL` | `openai` | 全局默认协议，当渠道未指定时使用 |
| `PASSTHROUGH_API_KEY` | `false` | 是否将客户端 Authorization 头的 Key 透传给上游 |
| `CLIENT_API_KEY` | - | 代理服务器自身的访问密钥 |
| `TOKEN_MULTIPLIER` | `1.0` | 计费 Token 倍数，支持 "1.2x", "120%" 等格式 |
| `PORT` | `3456` | 服务监听端口 |
| `LOG_LEVEL` | `info` | 日志级别 (debug, info, warn, error) |

## 启动服务

```bash
cd deno-proxy
deno run --allow-net --allow-env src/main.ts
```

## 架构说明

### 核心组件
1.  **`prompt_inject.ts`**: 工具模拟的核心。它负责拦截 Claude 请求，将工具定义转化为 XML 提示词，并将历史工具消息“退化”为纯文本。
2.  **`parser.ts`**: 智能解析器。实时监控上游输出流，识别触发信号并拦截提取 XML 工具调用指令。
3.  **`claude_writer.ts`**: 标准输出器。将 Parser 生成的事件（文本、思考、工具调用）封装成标准的 Claude SSE 格式。
4.  **`map_claude_to_openai.ts`**: 协议适配器。负责将增强后的请求映射为 OpenAI 格式的消息数组。

### 为什么选择本代理？
- **绕过限制**: 让那些不支持工具调用的便宜渠道也能运行 Claude Code。
- **统一体验**: 无论后端是 GPT-4、Claude 还是本地 Llama，客户端体验完全一致。
- **极简维护**: 采用流水线架构，新增协议仅需实现少量代码。

## 故障排除
- **工具不触发**: 检查上游模型的上下文长度和指令遵循能力。建议使用 1k 以上的 `max_tokens`。
- **协议报错**: 确认 `CHANNEL_n_PROTOCOL` 是否与 `BASE_URL` 匹配。Anthropic 协议通常需要 `v1/messages` 端点。

## 许可证
MIT
