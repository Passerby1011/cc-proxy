# Deno 代理运行指南

本文档提供了 cc-proxy 的日常运行和基本操作指南。

## 环境变量配置

cc-proxy 采用了灵活的“渠道”配置系统。你可以通过以下环境变量配置一个或多个上游 AI 服务。

### 渠道配置 (推荐方式)

每个渠道由一组以 `CHANNEL_{n}_` 开头的变量定义，其中 `{n}` 是从 1 开始的数字。

| 变量名 | 必需 | 说明 | 示例值 |
|--------|------|------|--------|
| `CHANNEL_{n}_NAME` | 是 | 渠道标识符，用于模型名前缀 | `openai`, `anthropic`, `deepseek` |
| `CHANNEL_{n}_BASE_URL` | 是 | 上游 API 地址 | `https://api.openai.com/v1/chat/completions` |
| `CHANNEL_{n}_API_KEY` | 否 | 上游 API 密钥（可由客户端透传） | `sk-...` |
| `CHANNEL_{n}_PROTOCOL` | 否 | 协议类型：`openai` 或 `anthropic` | `openai` (默认) |

### 全局设置

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `CLIENT_API_KEY` | 代理服务器自身的访问密钥 | - |
| `PASSTHROUGH_API_KEY` | 是否允许客户端透传自己的 Key | `false` |
| `UPSTREAM_PROTOCOL` | 全局默认协议 | `openai` |
| `TOKEN_MULTIPLIER` | 计费 Token 倍数 | `1.0` |
| `MAX_REQUESTS_PER_MINUTE` | 每分钟最大请求数 | `60` |
| `TIMEOUT_MS` | 上游请求超时时间（毫秒） | `120000` |
| `PORT` / `HOST` | 监听地址 | `3456` / `0.0.0.0` |
| `LOG_LEVEL` | 日志级别 (debug, info, warn, error) | `info` |

## 启动服务

### 本地启动

确保已安装 Deno 1.40+，然后执行：

```bash
cd deno-proxy
deno run --allow-net --allow-env src/main.ts
```

### 使用 Docker 启动

```bash
docker-compose up -d
```

## 健康检查

使用 curl 检查服务是否正常运行：

```bash
curl http://localhost:3456/healthz
```

预期响应：`{"status":"ok"}`

## 客户端调用示例

配置好渠道（如 `CHANNEL_1_NAME=my_openai`）后，你可以使用以下方式调用：

### 1. 发送标准请求

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-client-key" \
  -d '{
    "model": "my_openai+gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### 2. 流式请求 (SSE)

```bash
curl -N -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my_openai+gpt-4o",
    "messages": [{"role": "user", "content": "Write a long poem."}],
    "max_tokens": 2048,
    "stream": true
  }'
```

### 3. Token 计数

```bash
curl -X POST http://localhost:3456/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello, world"}]
  }'
```

## 测试

运行内置测试套件：

```bash
cd deno-proxy
deno test --allow-env --allow-net
```

主要测试文件：
- `parser_test.ts`: 验证 XML 工具调用解析逻辑
- `token_counter.ts`: 验证 Token 计数逻辑

## 故障排查

1. **服务无法启动**: 检查端口是否被占用，环境变量格式是否正确。
2. **请求 401**: 检查 `CLIENT_API_KEY` 是否匹配，或者客户端是否发送了正确的 Header。
3. **上游报错**: 检查 `CHANNEL_n_BASE_URL` 是否包含正确的路径，以及 `CHANNEL_n_PROTOCOL` 是否匹配。
4. **日志查看**: 将 `LOG_LEVEL` 设置为 `debug` 获取更多详细信息。
