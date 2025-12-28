# 纯 Deno 聚合服务器设计 (cc-proxy)

目标：用一个 Deno 服务完成 Claude ↔ 纯提示词上游 ↔ Claude 的双向转换——直接把带工具的 Claude 消息转换成**不含 OpenAI tool 字段**的“纯提示词驱动” OpenAI `chat/completions` 请求，上游只产出文本，再解析文本中的工具调用语段，最终还原为 Claude 工具消息。

## 核心架构流程

1. **入口 (Claude 兼容)**: HTTP `POST /v1/messages`，接受 `messages`、`tools` 等。
2. **多渠道路由**: 解析 `渠道名+模型名`，从环境变量加载对应的 `BASE_URL` 和 `PROTOCOL`。
3. **提示词注入 (Enrichment)**: 
   - 将 `tools` schema 转换为系统提示词。
   - 生成随机触发信号 (Trigger Signal)。
   - 构造仅含文本消息的 OpenAI 请求（不含 `tools` 字段）。
4. **上游调用**: 通过 `fetch` 透传流式响应。
5. **流式拦截解析 (Parser)**:
   - 实时扫描文本流中的触发信号。
   - 提取并解析 XML 格式的 `<invoke>` 工具调用。
   - 识别 `<thinking>` 标签以支持思考模式。
6. **响应重建 (Claude Writer)**: 将解析事件实时封装为 Claude SSE 事件序列。

## 模块设计

- **`main.ts`**: 服务入口，处理路由 (`/v1/messages`, `/healthz`, `/count_tokens`)。
- **`config.ts`**: 动态加载 `CHANNEL_{n}` 环境变量。
- **`prompt_inject.ts`**: 核心逻辑。负责 XML 提示词生成和历史工具消息的文本化“退化”。
- **`parser.ts`**: 状态机解析器。逐字符处理流数据，拦截工具调用并产出结构化事件。
- **`upstream.ts`**: 协议适配层。处理 OpenAI 和 Anthropic 上游的请求细节。
- **`claude_writer.ts`**: 响应适配层。维护 Claude SSE 状态机，确保 `message_start` 等事件顺序正确。
- **`token_counter.ts` & `tiktoken.ts`**: 实现官方 API 与本地离线 Token 计数。

## 关键实现要点

- **状态机稳定性**: 解析器必须能够处理被截断的 chunk（单字符喂入策略）。
- **工具调用闭环**: `tool_use` 生成后，需等待客户端在下一轮请求中通过 `tool_result` 带回结果。
- **思考模式**: 兼容 Claude 3.5 的思考块输出，确保在 UI 上正确显示思维链。

## 开发状态 (Current State)

- [x] 多渠道动态路由支持。
- [x] 基于 XML 的工具调用注入与拦截解析。
- [x] 思考模式 (Thinking) 支持。
- [x] 本地 tiktoken 计数与官方 API 切换。
- [x] 结构化日志追踪。
- [ ] 更多上游协议适配（如 Google Gemini）。
- [ ] 自动化回归测试套件。

## 验证步骤

1. **基本聊天**: 验证普通文本流式输出。
2. **工具触发**: 强制模型调用工具，验证 `tool_use` 事件。
3. **多轮对话**: 验证 `tool_result` 回传后模型能继续分析。
4. **性能监控**: 验证 `TOKEN_MULTIPLIER` 和请求耗时记录。
