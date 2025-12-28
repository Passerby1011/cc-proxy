# Token 计数功能

cc-proxy 内置了高性能的 Token 计数功能，支持 Claude 官方 API 计数和本地 tiktoken 估算两种模式。

## 功能概述

- **双模式支持**: 优先调用 Anthropic 官方 `/v1/messages/count_tokens` 接口以获取 100% 准确的结果；当未配置官方 Key 时，自动切换到本地 tiktoken 引擎。
- **本地 tiktoken**: 使用兼容 `cl100k_base` (GPT-4/Claude 3 系列使用) 的本地分词算法，响应极快且无需联网。
- **自定义倍数 (`TOKEN_MULTIPLIER`)**: 支持通过环境变量调整最终显示的 token 数，方便进行成本管理或计费补偿。
- **API 端点**: 暴露标准的 Claude 兼容端点，供外部工具或脚本调用。

## 环境变量配置

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TOKEN_MULTIPLIER` | Token 计数倍数，支持数字或百分比字符串 | `1.5`, `120%`, `0.8x` |
| `CLAUDE_API_KEY` | (可选) Anthropic 官方 Key，用于精确计数 | `sk-ant-xxx` |

## API 使用说明

### count_tokens 端点

**URL**: `POST /v1/messages/count_tokens`

**请求体示例**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {"role": "user", "content": "你好，请介绍一下你自己。"}
  ]
}
```

**响应示例**:
```json
{
  "input_tokens": 15,
  "token_count": 15,
  "tokens": [...],
  "output_tokens": null
}
```

## 实现原理

1. **请求拦截**: 当 `/v1/messages` 请求进入代理时，系统会自动提取 `system` 和 `messages` 内容。
2. **选择引擎**:
   - 如果设置了 `CLAUDE_API_KEY`，代理会并发发起一个官方计数请求。
   - 如果未设置或官方请求失败，则调用本地 `tiktoken.ts` 模块。
3. **应用倍数**: 计数结果通过 `config.ts` 中的 `parseTokenMultiplier` 函数进行转换。例如设置 `1.2x`，原始 100 tokens 将显示为 120。
4. **注入响应**: 最终的 `input_tokens` 会被注入到流式响应的 `message_start` 或 `message_delta` 事件的 `usage` 字段中，确保客户端 UI 能够实时显示。

## 本地计数准确性说明

本地计数器基于 `js-tiktoken` 的 Deno 移植版实现。虽然它非常接近官方结果，但在处理极少数特殊 Unicode 字符或特定格式的 XML 标签时可能存在 ±1-2 token 的偏差。对于大多数场景（如 Claude Code 的日常使用），这种偏差可以忽略不计。

## 测试

运行以下命令验证计数逻辑：

```bash
cd deno-proxy
deno test src/token_counter.ts
```
