# 日志配置

本文档描述了如何配置 cc-proxy 的日志系统，包括控制台输出和结构化文件记录。

## 环境变量配置

### LOG_LEVEL

控制日志的详细程度。可选值：

- `debug`: 显示所有细节日志，包括原始请求体和上游流片段（最详细）。
- `info`: 显示关键业务流程、请求摘要和完成状态（默认）。
- `warn`: 仅显示警告和非致命错误。
- `error`: 仅显示严重错误和请求处理失败的信息。

示例：
```bash
export LOG_LEVEL=debug
```

### LOGGING_DISABLED

完全禁用日志输出。

- `true` / `1`: 禁用所有日志。
- 其他值: 启用日志。

## 日志输出方式

cc-proxy 支持两种并行输出方式：

1. **控制台 (stdout)**: 简洁的文本日志，适合开发调试和容器日志采集。
2. **结构化文件**: 每个请求会生成一个独立的日志文件，包含完整的请求生命周期数据。

### 请求日志文件

日志文件通常存储在项目根目录下的 `logs/` 文件夹中（如果具有写权限）。文件名格式为 `req_{requestId}.log`。

文件内容采用 JSON 序列格式，方便后续分析：

```json
{"timestamp":"2025-12-28T13:20:00.000Z","level":"info","message":"Handling Claude message","requestId":"uuid-xxx"}
{"timestamp":"2025-12-28T13:20:00.010Z","level":"debug","message":"Received Claude request body","requestId":"uuid-xxx","meta":{"rawPreview":{...}}}
```

## 运维建议

1. **生产环境**: 建议使用 `LOG_LEVEL=info`。如果磁盘空间充足，可以保留文件日志以便追溯。
2. **调试工具调用**: 如果工具调用未按预期工作，请开启 `LOG_LEVEL=debug`，并在日志中查看上游返回的原始 XML 片段。
3. **日志清理**: cc-proxy 目前不会自动清理旧日志文件。建议在生产环境配合 `logrotate` 使用。

### Logrotate 示例配置

```conf
/path/to/cc-proxy/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

## 测试日志

你可以运行以下脚本来验证日志开关是否生效：

```bash
./scripts/test-logging-disabled.sh
```
