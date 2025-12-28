# cc-proxy 文档中心

欢迎来到 cc-proxy 文档中心！本页面提供了项目所有文档的快速导航和概览。

## 📚 文档导航

### 🚀 快速开始

如果你是第一次使用 cc-proxy，建议按以下顺序阅读：

1. **[项目 README](../README.md)** - 项目概述、快速开始和基础配置
2. **[部署指南](deno-deployment-guide.md)** - 详细的部署步骤和环境配置
3. **[使用示例](deno-server-examples.md)** - 完整的请求响应示例

### 📖 核心文档

#### [架构设计 (pipeline.md)](pipeline.md)

详细介绍了 cc-proxy 的工作原理和数据流转过程：

- **组件角色**: Claude Code 客户端、cc-proxy、上游 LLM 服务的交互关系
- **端到端时序**: 请求和响应的完整流程
- **关键转换点**: 路由选择、工具调用保持、提示词注入等核心机制
- **示例链路**: 概念性的完整调用链路
- **落地配置**: 实际部署时的配置建议

**适合人群**: 想要深入理解 cc-proxy 工作原理的开发者

#### [开发计划 (deno-server-plan.md)](deno-server-plan.md)

项目的设计文档和开发路线图：

- **核心流程**: 从 Claude 请求到上游调用再到响应的完整流程
- **模块划分**: 各个核心模块的职责和接口设计
- **关键实现要点**: 角色映射、工具定义、提示协议、流式解析等
- **实施计划**: 当前 Sprint 的开发任务和验证步骤

**适合人群**: 参与项目开发或想要了解技术细节的开发者

#### [使用示例 (deno-server-examples.md)](deno-server-examples.md)

完整的端到端请求响应示例：

- **Claude Messages API 规范**: 顶层字段、消息内容块、工具调用规则
- **SSE 事件详解**: 流式响应的事件序列和格式
- **端到端样例**: 包含历史工具调用的完整请求响应示例
- **字段对照**: 所有字段的详细说明和示例值

**适合人群**: 需要集成 cc-proxy 或调试问题的开发者

### 🔧 功能文档

#### [Token 计数 (TOKEN_COUNTING.md)](TOKEN_COUNTING.md)

Token 计数功能的详细说明：

- **功能概述**: Claude API 集成和本地 tiktoken 实现
- **环境变量配置**: `TOKEN_MULTIPLIER`、`CLAUDE_API_KEY` 等
- **API 使用**: `/v1/messages/count_tokens` 端点的使用方法
- **实现细节**: Token 计算策略和本地 tiktoken 实现
- **测试方法**: 如何测试 token 计数功能
- **计费示例**: 使用倍数进行计费调整的示例

**适合人群**: 需要精确控制 token 计数和计费的用户

#### [日志配置 (logging-configuration.md)](logging-configuration.md)

日志系统的配置和使用说明：

- **日志级别**: debug、info、warn、error 的使用场景
- **日志格式**: 结构化日志的字段说明
- **请求追踪**: 如何使用请求 ID 追踪完整请求链路
- **日志输出**: 控制台输出和文件输出的配置

**适合人群**: 需要调试问题或监控服务的运维人员

### 🚀 部署文档

#### [部署指南 (deno-deployment-guide.md)](deno-deployment-guide.md)

完整的部署指南，涵盖多种部署方式：

- **Deno Deploy 一键部署**: 使用官方无服务器平台快速部署
  - 控制台部署
  - deployctl CLI 部署
  - GitHub Actions 自动部署
- **本地开发部署**: 本地运行和开发环境配置
- **生产环境部署**: systemd 服务配置、安全设置
- **容器化部署**: Docker 和 Docker Compose 部署
- **云平台部署**: 支持的云平台和配置说明
- **监控与维护**: 日志管理、故障恢复、安全配置

**适合人群**: 需要部署 cc-proxy 的运维人员和开发者

#### [运维手册 (deno-server-runbook.md)](deno-server-runbook.md)

日常运维操作指南：

- **服务管理**: 启动、停止、重启服务
- **日志查看**: 如何查看和分析日志
- **性能监控**: 监控指标和告警配置
- **故障处理**: 常见问题的诊断和解决方法
- **备份恢复**: 配置备份和恢复流程

**适合人群**: 负责服务运维的人员

## 📋 文档分类索引

### 按主题分类

#### 入门指南
- [项目 README](../README.md) - 项目概述和快速开始
- [部署指南](deno-deployment-guide.md) - 部署步骤和环境配置
- [使用示例](deno-server-examples.md) - 请求响应示例

#### 架构与设计
- [架构设计](pipeline.md) - 工作原理和数据流转
- [开发计划](deno-server-plan.md) - 设计文档和开发路线

#### 功能说明
- [Token 计数](TOKEN_COUNTING.md) - Token 计数功能详解
- [日志配置](logging-configuration.md) - 日志系统配置

#### 运维部署
- [部署指南](deno-deployment-guide.md) - 完整的部署指南
- [运维手册](deno-server-runbook.md) - 日常运维操作

### 按角色分类

#### 开发者
1. [项目 README](../README.md) - 了解项目
2. [架构设计](pipeline.md) - 理解原理
3. [开发计划](deno-server-plan.md) - 技术细节
4. [使用示例](deno-server-examples.md) - 集成参考

#### 运维人员
1. [部署指南](deno-deployment-guide.md) - 部署服务
2. [运维手册](deno-server-runbook.md) - 日常运维
3. [日志配置](logging-configuration.md) - 日志管理
4. [Token 计数](TOKEN_COUNTING.md) - 计费管理

#### 用户
1. [项目 README](../README.md) - 快速开始
2. [使用示例](deno-server-examples.md) - 使用方法
3. [部署指南](deno-deployment-guide.md) - 自行部署

## 🔍 常见问题快速查找

### 如何部署？
- **云端部署**: 参考 [部署指南 - Deno Deploy 一键部署](deno-deployment-guide.md#deno-deploy-一键部署)
- **本地部署**: 参考 [项目 README - 本地运行](../README.md#本地运行)
- **Docker 部署**: 参考 [部署指南 - 容器化部署](deno-deployment-guide.md#容器化部署)

### 如何配置？
- **渠道配置**: 参考 [项目 README - 渠道配置](../README.md#渠道配置-推荐方式)
- **环境变量**: 参考 [项目 README - 全局配置](../README.md#全局配置)
- **日志配置**: 参考 [日志配置文档](logging-configuration.md)

### 如何使用？
- **API 调用**: 参考 [使用示例](deno-server-examples.md)
- **工具调用**: 参考 [项目 README - API 端点](../README.md#api-端点)
- **Token 计数**: 参考 [Token 计数文档](TOKEN_COUNTING.md)

### 遇到问题？
- **工具不触发**: 参考 [项目 README - 故障排除](../README.md#故障排除)
- **协议报错**: 参考 [项目 README - 故障排除](../README.md#协议报错)
- **日志分析**: 参考 [日志配置文档](logging-configuration.md)

### 想要贡献？
- **开发流程**: 参考 [项目 README - 贡献指南](../README.md#贡献指南)
- **代码规范**: 参考 [开发计划](deno-server-plan.md)
- **测试方法**: 参考 [项目 README - 测试](../README.md#测试)

## 📝 文档更新记录

### 最近更新

- **2025-12-28**: 创建文档中心，完善 README 和文档索引
- **2025-12**: 添加 Token 计数功能文档
- **2025-12**: 完善部署指南，添加 Deno Deploy 部署方式
- **2025-12**: 添加完整的端到端使用示例

### 待完善内容

- [ ] 添加更多实际使用案例
- [ ] 补充性能优化指南
- [ ] 添加安全最佳实践
- [ ] 完善故障排除手册

## 🤝 贡献文档

如果你发现文档有错误或需要改进，欢迎：

1. 在 [GitHub Issues](https://github.com/Passerby1011/cc-proxy/issues) 提出问题
2. 提交 Pull Request 改进文档
3. 分享你的使用经验和最佳实践

## 📞 获取帮助

- **GitHub Issues**: [提交问题](https://github.com/Passerby1011/cc-proxy/issues)
- **项目主页**: [cc-proxy](https://github.com/Passerby1011/cc-proxy)

---

**文档持续更新中，感谢你的关注和支持！** 💙
