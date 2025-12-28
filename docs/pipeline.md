# cc-proxy 工作流程详解 (Pipeline)

cc-proxy (deno-proxy) 作为一个协议转换层，将标准的 Claude Code 客户端请求转换为“纯提示词驱动”的上游模型请求，并能够拦截解析模型输出的 XML 标签以还原工具调用能力。

## 核心组件与角色

- **Claude Code 客户端**: 遵循 Anthropic 协议发出请求，携带 `messages` 和 `tools` 定义。
- **cc-proxy (deno-proxy)**: 本项目核心。负责请求改写、提示词注入、流式解析和协议适配。
- **上游 AI 服务**: 任何支持 OpenAI 或 Anthropic 文本生成协议的服务（如 GPT-4, DeepSeek, Claude 官方 API 等）。

## 端到端请求流

### 1. 入站与增强 (Enrichment)
当 cc-proxy 收到 Claude 请求后，首先进入 `prompt_inject.ts`:
- **工具转提示词**: 将 JSON 格式的 `tools` 定义转换为详细的 XML 系统提示。
- **历史退化**: 将对话历史中的 `tool_use` 和 `tool_result` 转换为文本格式，以便不支持原生工具的上游模型能够理解上下文。

### 2. 渠道路由与映射 (Routing & Mapping)
根据配置的渠道信息 (`config.ts`) 和请求的模型名:
- **渠道选择**: 解析 `渠道名+模型名` 格式，决定转发目标。
- **协议转换**: 使用 `map_claude_to_openai.ts` 或相应的适配器，将增强后的请求体转换为上游所需的格式（通常是 OpenAI `chat/completions`）。
- **注意**: 此时发送给上游的请求**不包含**任何原生 `tools` 字段，只有包含注入指令的 `messages`。

### 3. 上游调用与流式拦截 (Upstream & Parsing)
cc-proxy 调用上游 API 并启动流式处理:
- **统一流处理器**: `handle_openai_stream.ts` 或 `handle_anthropic_stream.ts` 接收原始字节流。
- **Toolify 解析器**: `parser.ts` 实时扫描文本流。
- **信号检测**: 发现预设的触发信号 (如 `<<CALL_...>>`) 后，开始拦截后续的 XML 内容，不再直接作为文本输出。

### 4. 响应重建 (Claude Writing)
解析出的事件被送入 `claude_writer.ts`:
- **文本块**: 将普通文本封装为 `content_block_delta` (type: text_delta)。
- **思考块**: 如果模型输出 `<thinking>` 标签，则转换为 Claude 特有的思维链块。
- **工具块**: 将解析出的 XML (name 和 parameters) 转换为标准 Claude `tool_use` 格式，并通过 `input_json_delta` 逐步推送到客户端。
- **状态同步**: 自动计算 `stop_reason` (如 `tool_use`) 并管理 SSE 事件序列 (`message_start` -> `content_block` -> `message_delta` -> `message_stop`)。

## 关键转换逻辑示例

### 输入转换
- **Claude**: `{"role": "user", "content": "查天气"}` + `tools: [...]`
- **cc-proxy 改写后**: `{"role": "system", "content": "...(工具定义提示词)..."}, {"role": "user", "content": "查天气"}`

### 输出转换
- **上游输出**: `好的。 <<CALL_ab12>> <invoke name="get_weather"><parameter name="city">Shanghai</parameter></invoke>`
- **cc-proxy 转换后**: 
  1. `text_delta`: "好的。"
  2. `tool_use`: `{"name": "get_weather", "input": {"city": "Shanghai"}}`

## 为什么这种架构更有效？
1. **去工具化**: 通过将工具需求转化为模型本能的“文本指令遵循”，解决了许多便宜 API 渠道禁用法令调用或实现不稳的问题。
2. **状态透明**: cc-proxy 承担了最复杂的流式状态机维护，客户端和上游模型都只需处理各自的标准协议。
3. **高保真**: 能够精确模拟 Claude 客户端期待的每一个 SSE 事件，确保 UI 渲染不跳变、不报错。
