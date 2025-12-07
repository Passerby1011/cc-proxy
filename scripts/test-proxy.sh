#!/bin/bash

# 测试 deno-proxy 的脚本
# 发送 Anthropic 格式的请求到 http://localhost:3456/v1/messages

echo "🔧 测试 deno-proxy..."
echo ""

# 发送请求并打印响应
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -d '{
    "model": "claude-4.5-sonnet-cc",
    "messages": [
      {
        "role": "user",
        "content": "你好，请用一句话介绍你自己"
      }
    ],
    "system": [
      {
        "type": "text",
        "text": "You are a helpful assistant."
      }
    ],
    "max_tokens": 1024,
    "temperature": 1,
    "stream": true
  }' \
  --no-buffer

echo ""
echo "✅ 测试完成"