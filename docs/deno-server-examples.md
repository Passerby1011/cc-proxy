# Deno 服务端到端样例

本文提供了一个完整的端到端请求响应样例，展示了 cc-proxy 如何处理 Claude 的工具调用请求，将其转换为上游指令，并解析回流式响应。

## 场景描述

用户希望查询上海的天气。cc-proxy 将通过提示词注入，引导不支持原生 Function Calling 的上游模型输出特定的 XML 标签。

## 1. Claude 客户端入站请求

**URL**: `POST /v1/messages`

```json
{
  "model": "my_openai+gpt-4o",
  "max_tokens": 1024,
  "stream": true,
  "messages": [
    { "role": "user", "content": "帮我查下上海的天气。" }
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "获取指定城市的天气信息",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "城市名称" }
        },
        "required": ["city"]
      }
    }
  ]
}
```

## 2. cc-proxy 转发给上游的请求 (Enriched)

cc-proxy 将工具定义注入到系统提示词中，并生成随机触发信号。

```json
{
  "model": "gpt-4o",
  "stream": true,
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant with access to tools...\n\nAvailable Tools:\n<function_list>\n  <tool>\n    <name>get_weather</name>\n    <description>获取指定城市的天气信息</description>\n    <parameters>\n      <parameter name=\"city\">\n        <type>string</type>\n        <description>城市名称</description>\n      </parameter>\n    </parameters>\n  </tool>\n</function_list>\n\nWhen you need to use a tool, you MUST output this trigger signal: <<CALL_ab12>>\nFormat: <<CALL_ab12>>\n<invoke name=\"tool_name\"><parameter name=\"param\">value</parameter></invoke>"
    },
    { "role": "user", "content": "帮我查下上海的天气。" }
  ]
}
```

## 3. 上游模型响应流 (SSE Chunks)

模型输出包含触发信号和 XML 标签。

```text
data: {"choices":[{"delta":{"content":"好的，我为您查询上海的天气。\n<<CALL_ab12>>\n<invoke name=\"get_weather\"><parameter name=\"city\">Shanghai</parameter></invoke>"}}]}
```

## 4. cc-proxy 返回给客户端的响应流 (Claude SSE)

cc-proxy 实时解析上述内容，并按 Claude 协议输出。

### 事件 1: 消息开始
```json
data: {"type": "message_start", "message": {"id": "msg_xxx", "role": "assistant", "model": "gpt-4o"}}
```

### 事件 2: 文本内容
```json
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "好的，我为您查询上海的天气。\n"}}
data: {"type": "content_block_stop", "index": 0}
```

### 事件 3: 工具调用开始
```json
data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_unique_id", "name": "get_weather", "input": {}}}
```

### 事件 4: 工具输入 JSON Delta (逐步解析并输出)
```json
data: {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"city\": \"Shanghai\"}"}}
```

### 事件 5: 消息结束
```json
data: {"type": "content_block_stop", "index": 1}
data: {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}
data: {"type": "message_stop"}
```

## 总结

通过上述流程，cc-proxy 成功地将一个普通对话模型包装成了支持工具调用的智能代理。客户端感知不到中间的 XML 转换过程，而上游模型也只需遵循简单的文本指令即可完成复杂的任务调度。
