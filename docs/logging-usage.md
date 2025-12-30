# 日志系统使用说明

## 新的日志格式

cc-proxy 现在支持三种日志输出格式，通过环境变量 `LOG_FORMAT` 控制。

### 格式选项

#### 1. Pretty 格式（默认，推荐）
带颜色、图标和结构化输出，适合开发和调试。

```bash
export LOG_FORMAT=pretty  # 或不设置，默认即为 pretty
```

**输出示例：**
```
┌────────────────────────────────────────────────────────
│ 📨 [REQUEST] a1b2c3d4 | POST /v1/messages
│ 🎯 Model: gpt-4o | 🔧 3 tools | 📊 stream
└────────────────────────────────────────────────────────
  ├─ 📝 [ENRICHED] Injected 3 tools | signal=<<CALL_abc>>...
  ├─ 🚀 [UPSTREAM] Forwarding to OPENAI | model=gpt-4o
  ├─ ⚡ [STREAM] Receiving response (TTFB: 450ms)
  ├─ 🔧 [TOOL] get_weather() | args={"city":"Shanghai"}
  └─ ✅ [COMPLETE] 2.34s | 📊 1234→567 tokens

```

#### 2. Plain 格式
无颜色纯文本，适合日志文件或不支持颜色的环境。

```bash
export LOG_FORMAT=plain
```

**输出示例：**
```
2025-12-30T14:10:33.123Z [INFO   ] Request started | requestId=a1b2c3d4, method=POST, path=/v1/messages
2025-12-30T14:10:33.456Z [INFO   ] Forwarding to OpenAI | model=gpt-4o
2025-12-30T14:10:35.789Z [INFO   ] Request completed | duration=2340, inputTokens=1234, outputTokens=567
```

#### 3. JSON 格式
结构化 JSON 输出，适合日志分析工具。

```bash
export LOG_FORMAT=json
```

**输出示例：**
```json
{"timestamp":"2025-12-30T14:10:33.123Z","level":"info","message":"Request started","requestId":"a1b2c3d4","method":"POST","path":"/v1/messages"}
{"timestamp":"2025-12-30T14:10:35.789Z","level":"info","message":"Request completed","requestId":"a1b2c3d4","duration":2340,"inputTokens":1234,"outputTokens":567}
```

### 其他配置选项

#### 禁用颜色
如果终端不支持颜色，可以禁用：

```bash
export LOG_COLORS=false
```

#### 日志级别
控制详细程度：

```bash
export LOG_LEVEL=debug  # debug | info | warn | error
```

- `debug`: 显示所有日志，包括解析细节
- `info`: 显示关键业务流程（默认）
- `warn`: 仅警告和错误
- `error`: 仅错误

#### 完全禁用日志

```bash
export LOGGING_DISABLED=true
```

## 日志阶段标记

Pretty 格式使用图标标记不同的处理阶段：

- 📨 `[REQUEST]` - 请求开始
- 📝 `[ENRICHED]` - 工具定义注入完成
- 🚀 `[UPSTREAM]` - 转发到上游 API
- ⚡ `[STREAM]` - 开始接收流式响应
- 🔧 `[TOOL]` - 检测到工具调用
- 💭 `[THINKING]` - 思考块（如果启用）
- ✅ `[COMPLETE]` - 请求成功完成
- 🔴 `[ERROR]` - 发生错误
- 📊 `[STATS]` - 统计信息

## 关键指标

新的日志系统自动追踪以下指标：

1. **请求耗时** - 从接收到完成的总时间
2. **TTFB (Time To First Byte)** - 上游响应首字节时间
3. **Token 统计** - 输入和输出 token 数量
4. **工具调用详情** - 调用的工具名称和参数预览

## 推荐配置

### 开发环境
```bash
export LOG_FORMAT=pretty
export LOG_LEVEL=debug
export LOG_COLORS=true
```

### 生产环境
```bash
export LOG_FORMAT=plain  # 或 json，便于日志采集
export LOG_LEVEL=info
```

### 性能测试
```bash
export LOG_FORMAT=json
export LOG_LEVEL=warn
```

## 日志文件

除了控制台输出，系统仍会将详细日志写入文件：

```
logs/
└── req/
    └── {requestId}.txt  # 每个请求一个文件
```

文件日志保持原有格式，不受 `LOG_FORMAT` 影响。

## 示例：完整请求日志

```
┌────────────────────────────────────────────────────────
│ 📨 [REQUEST] 3f8a9c2b | POST /v1/messages
│ 🎯 Model: gpt-4o | 🔧 2 tools | 📊 stream
└────────────────────────────────────────────────────────
  ├─ 📝 [ENRICHED] Injected 2 tools | signal=<<CALL_x7k9>>...
  ├─ 🚀 [UPSTREAM] Forwarding to OPENAI | model=gpt-4o, url=completions
  ├─ ⚡ [STREAM] Receiving response (TTFB: 320ms)
  ├─ 🔧 [TOOL] search_web() | args={"query":"latest news"}
  └─ ✅ [COMPLETE] 1.85s | 📊 856→423 tokens

```

这个输出清晰地展示了：
- 请求 ID 的前8位（便于识别）
- 使用的模型和工具数量
- 各个处理阶段的顺序
- 关键性能指标（TTFB、总耗时、token使用）
- 工具调用的具体信息
