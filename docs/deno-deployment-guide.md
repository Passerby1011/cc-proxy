# Deno 部署指南

本指南详细介绍如何在不同环境中部署和运行 cc-proxy 的 Deno 代理服务器。

## 目录

- [环境准备](#环境准备)
- [Deno Deploy 一键部署 (推荐)](#deno-deploy-一键部署-推荐)
- [Docker 容器化部署](#docker-容器化部署)
- [本地开发部署](#本地开发部署)
- [生产环境部署 (systemd)](#生产环境部署-systemd)
- [监控与维护](#监控与维护)

## Deno Deploy 一键部署 (推荐)

Deno Deploy 是部署 cc-proxy 最快且最稳定的方式。

### 方法一：使用 deployctl CLI

1. 安装命令行工具:
```bash
deno install -gArf jsr:@deno/deployctl
```

2. 部署项目:
```bash
# 从项目根目录执行
deployctl deploy --project=cc-proxy deno-proxy/src/main.ts
```

### 方法二：GitHub Actions 自动部署

1. 在 Deno Deploy 控制台创建项目并关联 GitHub 仓库。
2. 在 GitHub 仓库设置中添加 `DENO_DEPLOY_TOKEN`。
3. 推送代码到 `main` 分支即可自动发布。

### 环境变量配置

在 Deno Deploy 控制台中，请确保配置以下核心变量:
- `CHANNEL_1_NAME`: 默认渠道名
- `CHANNEL_1_BASE_URL`: 默认上游地址
- `CHANNEL_1_API_KEY`: 默认 API 密钥

## Docker 容器化部署

### 快速启动 (Docker Compose)

项目根目录已包含 `docker-compose.yml`，你只需配置环境变量即可启动。

```bash
# 编辑并启动
docker-compose up -d
```

### 手动运行 Docker

```bash
docker build -t cc-proxy .
docker run -d \
  -p 3456:3456 \
  -e CHANNEL_1_NAME=openai \
  -e CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions \
  -e CHANNEL_1_API_KEY=sk-xxx \
  cc-proxy
```

## 本地开发部署

### 1. 环境准备
确保已安装 Deno 1.40+。

### 2. 运行服务
```bash
cd deno-proxy
# 使用 --watch 模式进行开发
deno run --allow-net --allow-env --watch src/main.ts
```

## 生产环境部署 (systemd)

对于 Linux 服务器，建议使用 systemd 管理进程。

### 1. 创建服务文件
```ini
[Unit]
Description=cc-proxy Server
After=network.target

[Service]
WorkingDirectory=/opt/cc-proxy/deno-proxy
ExecStart=/usr/local/bin/deno run --allow-net --allow-env src/main.ts
Restart=always
EnvironmentFile=/opt/cc-proxy/.env

[Install]
WantedBy=multi-user.target
```

### 2. 启用服务
```bash
sudo systemctl enable cc-proxy
sudo systemctl start cc-proxy
```

## 性能优化与监控

- **内存优化**: Deno 默认内存管理优秀，但建议为容器分配至少 512MB 内存。
- **并发限制**: 通过 `MAX_REQUESTS_PER_MINUTE` 防止上游账号被封禁。
- **日志采集**: 建议将日志挂载到宿主机，配合 `ELK` 或 `Grafana Loki` 采集 `logs/*.log` 文件。

## 安全建议

1. **设置 CLIENT_API_KEY**: 严禁将无验证的代理暴露在公网。
2. **使用 HTTPS**: 建议在 cc-proxy 前挂载 Nginx 或 Caddy 处理 SSL 证书。
3. **启用 PASSTHROUGH_API_KEY**: 如果是多用户场景，建议让客户端自带 API Key 以分散消耗。
