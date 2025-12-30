# 日志系统优化计划

## 问题分析

基于当前日志系统的分析和用户反馈，存在以下问题：

1. **格式不清晰**：控制台输出缺少视觉层次，所有信息混在一起难以快速定位
2. **缺少关键标记**：无法快速识别请求阶段（开始/处理中/结束/错误）
3. **缺少关键信息**：
   - 请求耗时统计
   - Token 使用统计（输入/输出）
   - 工具调用详情（调用了哪些工具、参数、结果）
   - 上游API响应时间
   - 流式传输速度

## 优化方案

### 一、增强控制台输出格式

#### 1.1 添加颜色支持
使用 ANSI 颜色码区分不同级别和阶段：
- 🟢 绿色：成功完成、INFO
- 🟡 黄色：警告、WARN  
- 🔴 红色：错误、ERROR
- 🔵 蓝色：调试信息、DEBUG
- 🟣 紫色：重要业务节点（工具调用、流开始等）

#### 1.2 结构化输出
```
┌─────────────────────────────────────────────────────────
│ 📨 [REQUEST] uuid-abc123 | POST /v1/messages
│ ⏰ 2025-12-30 14:10:33.123
│ 🎯 Model: gpt-4o | Tools: 3 | Stream: true
└─────────────────────────────────────────────────────────

  ├─ 📝 [PROMPT] Injected 3 tools (signal: <<CALL_xyz>>)
  ├─ 🚀 [UPSTREAM] Forwarding to OpenAI (protocol: openai)
  ├─ ⚡ [STREAM] Started receiving upstream response
  ├─ 🔧 [TOOL] Detected tool call: get_weather
  │   └─ Parameters: {"city": "Shanghai"}
  ├─ 💭 [THINKING] Received thinking block (245 chars)
  └─ ✅ [COMPLETE] Request finished in 2.34s

📊 [STATS] Input: 1,234 tokens | Output: 567 tokens | Cost: $0.0123
```

#### 1.3 请求生命周期追踪
为每个请求添加阶段标记：
- `[REQUEST]` - 请求开始
- `[ENRICHED]` - 提示词增强完成
- `[UPSTREAM]` - 上游调用
- `[PARSING]` - 流式解析中
- `[TOOL]` - 工具调用检测
- `[COMPLETE]` - 请求完成
- `[ERROR]` - 错误发生

### 二、增加关键性能指标

#### 2.1 时间统计
- 请求总耗时
- 上游响应首字节时间（TTFB）
- 流式传输速度（字符/秒）
- 工具调用解析耗时

#### 2.2 Token 统计
- 实时显示累计 token 使用
- 工具定义注入额外消耗的 token
- 按阶段拆分（用户输入/系统提示/模型输出）

#### 2.3 工具调用统计
- 本次请求调用的工具列表
- 每个工具的参数大小
- 工具调用是否成功解析

### 三、日志分类优化

#### 3.1 按类型分离日志文件
```
logs/
├── requests/        # 请求级日志（现有）
│   └── uuid-abc.log
├── errors/          # 错误日志汇总
│   └── 2025-12-30.log
├── performance/     # 性能统计
│   └── 2025-12-30.jsonl
└── tools/           # 工具调用专项日志
    └── 2025-12-30.jsonl
```

#### 3.2 性能日志格式
```jsonl
{"timestamp":"2025-12-30T14:10:35Z","requestId":"uuid-abc","duration":2340,"ttfb":450,"inputTokens":1234,"outputTokens":567,"model":"gpt-4o","toolsCalled":["get_weather"]}
```

### 四、实时监控面板（可选）

为控制台输出添加实时统计横幅：
```
╔════════════════════════════════════════════════════════╗
║  CC-PROXY 运行状态                                      ║
║  ⏱️  运行时长: 02:34:56  |  📊 总请求: 145 (✅ 142 ❌ 3) ║
║  💰 Token消耗: 1.2M in / 450K out  |  📈 平均耗时: 1.8s ║
╚════════════════════════════════════════════════════════╝
```

## 实施步骤

### 阶段一：核心优化（高优先级）
1. 重构 `logging.ts`，添加颜色和格式化支持
2. 添加请求计时器，统计关键阶段耗时
3. 在 `main.ts` 中添加请求开始/结束的结构化日志
4. 在 `parser.ts` 中添加工具调用检测日志
5. 在 `upstream.ts` 中添加上游调用性能日志

### 阶段二：统计增强（中优先级）
6. 创建性能统计收集器
7. 添加 token 实时统计
8. 创建独立的性能和工具调用日志文件
9. 在请求结束时输出完整统计摘要

### 阶段三：可视化（低优先级）
10. 添加实时监控面板（可选）
11. 创建日志查询工具（可选）

## 配置项

新增环境变量：
- `LOG_FORMAT`: `plain`(默认) | `json` | `pretty`(彩色)
- `LOG_COLORS`: `true`(默认) | `false` (禁用颜色)
- `LOG_STATS`: `true`(默认) | `false` (禁用统计)
- `LOG_SPLIT`: `true` | `false`(默认) (是否分离日志文件)

## 预期效果

**优化前**：
```
2025-12-30T14:10:33.123Z [INFO   ] Handling Claude message | requestId=uuid-abc
2025-12-30T14:10:33.456Z [DEBUG  ] Received Claude request body | requestId=uuid-abc, rawPreview={...大量JSON...}
2025-12-30T14:10:33.789Z [INFO   ] Forwarding request to openai upstream | requestId=uuid-abc, model=gpt-4o, protocol=openai
```

**优化后**：
```
┌─────────────────────────────────────────────────────────
│ 📨 [REQUEST] uuid-abc | POST /v1/messages
│ ⏰ 14:10:33.123 | 🎯 gpt-4o | 🔧 3 tools | 📊 stream
└─────────────────────────────────────────────────────────
  ├─ 📝 [ENRICHED] +850 tokens from tool injection
  ├─ 🚀 [UPSTREAM] → OpenAI API (ttfb: 450ms)
  ├─ 🔧 [TOOL] get_weather(city="Shanghai")
  └─ ✅ [DONE] 2.34s | 📊 1234→567 tokens | 💰 $0.012
```

## 兼容性

- 保持现有日志文件格式兼容
- 通过环境变量控制新功能，默认行为不变
- 支持在运行时切换日志模式
