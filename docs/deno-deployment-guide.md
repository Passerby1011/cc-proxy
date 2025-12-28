# Deno 部署指南

本指南详细介绍如何在不同环境中部署和运行 cc-proxy 的 Deno 代理服务器。

## 目录

- [环境准备](#环境准备)
- [Deno Deploy 一键部署](#deno-deploy-一键部署)
- [本地开发部署](#本地开发部署)
- [生产环境部署](#生产环境部署)
- [容器化部署](#容器化部署)
- [云平台部署](#云平台部署)
- [性能优化](#性能优化)
- [监控与维护](#监控与维护)

## Deno Deploy 一键部署

Deno Deploy 是 Deno 官方的无服务器平台，可以一键部署 cc-proxy 代理服务器，无需管理服务器基础设施。

### 前置要求

1. **Deno 账户**: 访问 [Deno Deploy](https://dash.deno.com) 注册账户
2. **GitHub 仓库**: 将项目推送到 GitHub 仓库

### 方法一：使用 Deno Deploy 控制台

1. 访问 [Deno Deploy 控制台](https://dash.deno.com/new)
2. 点击 "New Project"
3. 选择 "Deploy from GitHub"
4. 授权访问您的 GitHub 仓库
5. 选择 cc-proxy 仓库
6. 配置部署设置：
   - **入口点**: `deno-proxy/src/main.ts`
   - **环境变量**: 添加必要的环境变量
     ```
     UPSTREAM_BASE_URL=your-upstream-api-url
     UPSTREAM_API_KEY=your-api-key
     PORT=3456
     ```
7. 点击 "Deploy"

### 方法二：使用 deployctl CLI

1. 安装 deployctl:
```bash
deno install -gArf jsr:@deno/deployctl
```

2. 登录 Deno Deploy:
```bash
deployctl login
```

3. 部署项目:
```bash
# 从项目根目录执行
deployctl deploy --project=cc-proxy deno-proxy/src/main.ts
```

### 方法三：GitHub Actions 自动部署

项目已配置 GitHub Actions 工作流，推送到 main 分支会自动部署：

1. 在 Deno Deploy 控制台创建项目
2. 获取项目访问令牌
3. 在 GitHub 仓库设置中添加 Secret:
   - 名称: `DENO_DEPLOY_TOKEN`
   - 值: 您的 Deno Deploy 访问令牌
4. 推送代码到 main 分支即可自动部署

### Deno Deploy 配置文件

项目使用标准的 `deno.json` 配置文件，Deno Deploy 会自动识别以下配置：

```json
{
  "tasks": {
    "start": "deno run --allow-net --allow-env deno-proxy/src/main.ts",
    "dev": "deno run --allow-net --allow-env --watch deno-proxy/src/main.ts"
  },
  "imports": {
    "js-tiktoken": "npm:js-tiktoken@^1.0.7"
  }
}
```

### 配置环境变量

在 Deno Deploy 中配置以下环境变量：

#### 渠道配置 (推荐方式)
支持配置多组渠道，索引从 1 开始递增：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `CHANNEL_{n}_NAME` | 渠道名称 | `my_openai` |
| `CHANNEL_{n}_BASE_URL` | 上游 API 地址 | `https://api.openai.com/v1/chat/completions` |
| `CHANNEL_{n}_API_KEY` | 上游 API 密钥 | `sk-...` |
| `CHANNEL_{n}_PROTOCOL` | 协议类型 | `openai` 或 `anthropic` |

## 环境准备

### 系统要求

- **操作系统**: Linux (推荐)、macOS、Windows
- **内存**: 最低 512MB，推荐 2GB+
- **CPU**: 1核心以上
- **网络**: 稳定的互联网连接
- **存储**: 100MB 可用空间

## 本地开发部署

### 基础运行

1. 克隆项目
```bash
git clone <repository-url>
cd cc-proxy
```

2. 配置环境变量
```bash
# 创建 .env 文件
cat > .env << EOF
CHANNEL_1_NAME=my_openai
CHANNEL_1_BASE_URL=https://api.openai.com/v1/chat/completions
CHANNEL_1_API_KEY=your-key
PORT=3456
HOST=0.0.0.0
EOF
```

3. 启动服务
```bash
cd deno-proxy
deno run --allow-net --allow-env src/main.ts
```

## 生产环境部署

### 系统服务部署 (systemd)

1. 创建专用用户
```bash
sudo useradd -r -s /bin/false deno
sudo mkdir -p /opt/cc-proxy
sudo chown deno:deno /opt/cc-proxy
```

2. 部署应用文件
```bash
sudo cp -r . /opt/cc-proxy/
sudo chown -R deno:deno /opt/cc-proxy
```

3. 创建环境配置
```bash
sudo tee /opt/cc-proxy/.env > /dev/null <<EOF
UPSTREAM_BASE_URL=http://your-upstream-api/v1/chat/completions
UPSTREAM_API_KEY=your-upstream-api-key
PORT=3456
HOST=0.0.0.0
LOG_LEVEL=info
MAX_REQUESTS_PER_MINUTE=60
TIMEOUT_MS=120000
EOF
```

4. 创建 systemd 服务
```bash
sudo tee /etc/systemd/system/cc-proxy.service > /dev/null <<EOF
[Unit]
Description=cc-proxy Server
After=network.target

[Service]
Type=simple
User=deno
Group=deno
WorkingDirectory=/opt/cc-proxy/deno-proxy
EnvironmentFile=/opt/cc-proxy/.env
ExecStart=/usr/local/bin/deno run --allow-net --allow-env --allow-read --allow-write src/main.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# 安全设置
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/cc-proxy/logs

[Install]
WantedBy=multi-user.target
EOF
```

5. 启动和启用服务
```bash
sudo systemctl daemon-reload
sudo systemctl enable cc-proxy
sudo systemctl start cc-proxy
```

## 容器化部署

### Docker 部署

1. 构建 Docker 镜像
```bash
docker build -t cc-proxy:latest .
```

2. 运行容器
```bash
docker run -d \
  --name cc-proxy \
  -p 3456:3456 \
  -e UPSTREAM_BASE_URL=http://your-upstream-api/v1/chat/completions \
  -e UPSTREAM_API_KEY=your-api-key \
  --restart unless-stopped \
  cc-proxy:latest
```

### Docker Compose 部署

使用项目根目录下的 `docker-compose.yml` 即可快速启动。

## 云平台部署

支持 Vercel, Railway, DigitalOcean 等 Deno 兼容平台。

## 监控与维护

### 日志管理

1. 日志轮转配置
```bash
# 创建 logrotate 配置
sudo tee /etc/logrotate.d/cc-proxy > /dev/null <<EOF
/opt/cc-proxy/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 deno deno
    postrotate
        systemctl reload cc-proxy
    endscript
}
EOF
```

### 故障恢复

1. 自动重启脚本
```bash
#!/bin/bash
# auto-restart.sh

SERVICE_NAME="cc-proxy"
# ... 检查并重启逻辑
```

## 安全配置

### 访问控制

配置 `CLIENT_API_KEY` 以启用请求认证。
配置 `PASSTHROUGH_API_KEY=true` 以允许客户端透传自己的 Key。
