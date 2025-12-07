# AGENT.md

## 项目角色

- `claude-code-router` 和 `Toolify` 是参考实现，用于了解 Anthropic Claude Code 与工具调用协议的交互方式；当前仓库不会在这两个子项目上做任何开发或定制。
- 我们真正维护的程序是 `deno-proxy`。它负责把 Claude Code 的 SSE 流和 OpenAI（或其他无工具模式的 Chat API）上下游打通，同时插入必要的日志与格式转换，确保 Claude Code 可以直接复用这些模型。
- `docs/deno-server-examples.md` 记录了运行 deno-proxy 的完整端到端示例（Claude Messages 请求 → Deno 注入 → 上游响应 → Claude SSE），涵盖工具协议细节；若调试行为异常，先对照这里的字段说明，别跳读遗漏。
- `docs/deno-server-plan.md` 描述了 deno-proxy 的开发计划与迭代路线（阶段目标、依赖、验证步骤等），在开始实现前需确认当前阶段要求，避免错过已定义的 TODO。
- 无论是沟通还是具体操作（代码改动、命令执行、日志查阅等），都必须让用户知情：先说明要做什么、为什么做、可能的影响，再执行，禁止隐瞒或省略关键步骤。使用中文

## 开发目标

1. 只在 `deno-proxy` 中实现逻辑：包括请求改写、流式转换、日志记录、错误处理等。
2. 通过 `deno-proxy` 实现 Claude Code 和 OpenAI 等上游之间的无工具聊天对接，确保客户端无需感知上游差异。
3. 参考项目可以用来查阅原始协议或行为，但无需、也不应该修改它们。
