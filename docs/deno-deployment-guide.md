# Deno 部署指南

本指南详细介绍如何在不同环境中部署和运行 b4u2cc 的 Deno 代理服务器。

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

Deno Deploy 是 Deno 官方的无服务器平台，可以一键部署 b4u2cc 代理服务器，无需管理服务器基础设施。

### 前置要求

1. **Deno 账户**: 访问 [Deno Deploy](https://dash.deno.com) 注册账户
2. **GitHub 仓库**: 将项目推送到 GitHub 仓库

### 方法一：使用 Deno Deploy 控制台

1. 访问 [Deno Deploy 控制台](https://dash.deno.com/new)
2. 点击 "New Project"
3. 选择 "Deploy from GitHub"
4. 授权访问您的 GitHub 仓库
5. 选择 b4u2cc 仓库
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
deployctl deploy --project=b4u2cc-proxy deno-proxy/src/main.ts
```

### 方法三：GitHub Actions 自动部署

项目已配置 GitHub Actions 工作流，推送到 main 分支会自动部署：

1. 在 Deno Deploy 控制台创建项目
2. 获取项目访问令牌
3. 在 GitHub 仓库设置中添加 Secret:
   - 名称: `DENO_DEPLOY_TOKEN`
   - 值: 您的 Deno Deploy 访问令牌
4. 推送代码到 main 分支即可自动部署

### 配置环境变量

在 Deno Deploy 中配置以下环境变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `UPSTREAM_BASE_URL` | 上游 API 地址 | `https://api.openai.com/v1/chat/completions` |
| `UPSTREAM_API_KEY` | 上游 API 密钥 | `sk-...` |
| `UPSTREAM_MODEL` | 可选，强制覆盖模型 | `gpt-4` |
| `CLIENT_API_KEY` | 可选，客户端认证密钥 | `your-client-key` |
| `PORT` | 服务端口 | `3456` |
| `TOKEN_MULTIPLIER` | Token 计数倍数 | `1.0` |
| `LOG_LEVEL` | 日志级别 | `info` |

### 自定义域名

1. 在 Deno Deploy 控制台中，点击项目设置
2. 添加自定义域名
3. 配置 DNS 记录：
   ```
   # CNAME 记录
   your-domain.com. CNAME deno-deploy.net.
   
   # 或使用 ANAME/ALIAS
   your-domain.com. ANAME deno-deploy.net.
   ```

### 监控和日志

- **实时日志**: 在 Deno Deploy 控制台查看实时日志
- **指标**: 监控请求量、错误率和响应时间
- **告警**: 设置错误率或响应时间告警

## 环境准备

### 系统要求

- **操作系统**: Linux (推荐)、macOS、Windows
- **内存**: 最低 512MB，推荐 2GB+
- **CPU**: 1核心以上
- **网络**: 稳定的互联网连接
- **存储**: 100MB 可用空间

### 安装 Deno

#### Linux/macOS
```bash
# 使用官方安装脚本
curl -fsSL https://deno.land/install.sh | sh

# 或使用包管理器
# macOS (Homebrew)
brew install deno

# Ubuntu/Debian
sudo apt update && sudo apt install deno

# Arch Linux
sudo pacman -S deno
```

#### Windows
```powershell
# 使用 PowerShell
iwr https://deno.land/install.ps1 -useb | iex

# 或使用 Chocolatey
choco install deno

# 或使用 Scoop
scoop install deno
```

#### 验证安装
```bash
deno --version
```

## 本地开发部署

### 基础运行

1. 克隆项目
```bash
git clone <repository-url>
cd b4u2cc
```

2. 配置环境变量
```bash
# 创建 .env 文件
cat > .env << EOF
UPSTREAM_BASE_URL=http://your-upstream-api/v1/chat/completions
UPSTREAM_API_KEY=your-upstream-api-key
PORT=3456
HOST=0.0.0.0
EOF
```

3. 启动服务
```bash
cd deno-proxy
deno run --allow-net --allow-env src/main.ts
```

### 开发模式

使用 deno.json 中定义的开发任务：
```bash
cd deno-proxy
deno task dev
```

### 测试部署

```bash
# 健康检查
curl http://localhost:3456/healthz

# 发送测试请求
./scripts/test-proxy.sh

# 测试思考模式
./scripts/test-thinking-mode.sh
```

## 生产环境部署

### 系统服务部署 (systemd)

1. 创建专用用户
```bash
sudo useradd -r -s /bin/false deno
sudo mkdir -p /opt/b4u2cc
sudo chown deno:deno /opt/b4u2cc
```

2. 部署应用文件
```bash
sudo cp -r . /opt/b4u2cc/
sudo chown -R deno:deno /opt/b4u2cc
```

3. 创建环境配置
```bash
sudo tee /opt/b4u2cc/.env > /dev/null <<EOF
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
sudo tee /etc/systemd/system/b4u2cc.service > /dev/null <<EOF
[Unit]
Description=b4u2cc Proxy Server
After=network.target

[Service]
Type=simple
User=deno
Group=deno
WorkingDirectory=/opt/b4u2cc/deno-proxy
EnvironmentFile=/opt/b4u2cc/.env
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
ReadWritePaths=/opt/b4u2cc/logs

[Install]
WantedBy=multi-user.target
EOF
```

5. 启动和启用服务
```bash
sudo systemctl daemon-reload
sudo systemctl enable b4u2cc
sudo systemctl start b4u2cc
sudo systemctl status b4u2cc
```

6. 查看日志
```bash
# 实时日志
sudo journalctl -u b4u2cc -f

# 最近日志
sudo journalctl -u b4u2cc --since "1 hour ago"
```

### 反向代理配置

#### Nginx 配置
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # 流式响应支持
        proxy_buffering off;
        proxy_cache off;
    }
}
```

#### Apache 配置
```apache
<VirtualHost *:80>
    ServerName your-domain.com
    ProxyPreserveHost On
    ProxyRequests Off
    ProxyPass / http://127.0.0.1:3456/
    ProxyPassReverse / http://127.0.0.1:3456/
    
    # 启用支持
    ProxyPass /v1/messages ws://127.0.0.1:3456/v1/messages
</VirtualHost>
```

## 容器化部署

### Docker 部署

1. 创建 Dockerfile
```dockerfile
# 多阶段构建
FROM denoland/deno:1.40.0 AS builder
WORKDIR /app
COPY deno-proxy/ .
RUN deno cache src/main.ts

FROM denoland/deno:1.40.0-alpine
WORKDIR /app
COPY --from=builder /app .
COPY --from=builder /root/.cache/deno /root/.cache/deno

EXPOSE 3456

# 非root用户运行
USER deno

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "src/main.ts"]
```

2. 构建 Docker 镜像
```bash
docker build -t b4u2cc-proxy:latest .
```

3. 运行容器
```bash
docker run -d \
  --name b4u2cc-proxy \
  -p 3456:3456 \
  -e UPSTREAM_BASE_URL=http://your-upstream-api/v1/chat/completions \
  -e UPSTREAM_API_KEY=your-api-key \
  -e PORT=3456 \
  -e LOG_LEVEL=info \
  --restart unless-stopped \
  b4u2cc-proxy:latest
```

### Docker Compose 部署

创建 `docker-compose.yml`:
```yaml
version: '3.8'

services:
  b4u2cc-proxy:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3456:3456"
    environment:
      - UPSTREAM_BASE_URL=${UPSTREAM_BASE_URL}
      - UPSTREAM_API_KEY=${UPSTREAM_API_KEY}
      - PORT=3456
      - LOG_LEVEL=info
      - MAX_REQUESTS_PER_MINUTE=60
      - TOKEN_MULTIPLIER=1.0
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3456/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
    volumes:
      - ./logs:/app/logs
    networks:
      - b4u2cc-network

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - b4u2cc-proxy
    restart: unless-stopped
    networks:
      - b4u2cc-network

networks:
  b4u2cc-network:
    driver: bridge
```

创建 `.env` 文件:
```bash
UPSTREAM_BASE_URL=http://your-upstream-api/v1/chat/completions
UPSTREAM_API_KEY=your-api-key
```

启动服务:
```bash
docker-compose up -d
```

## 云平台部署

### Vercel 部署

1. 创建 `vercel.json`:
```json
{
  "version": 2,
  "builds": [
    {
      "src": "deno-proxy/src/main.ts",
      "use": "@vercel/deno"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "deno-proxy/src/main.ts"
    }
  ],
  "env": {
    "UPSTREAM_BASE_URL": "@upstream-base-url",
    "UPSTREAM_API_KEY": "@upstream-api-key"
  }
}
```

2. 部署
```bash
vercel --prod
```

### Railway 部署

1. 创建 `railway.toml`:
```toml
[build]
builder = "nixpacks"

[deploy]
healthcheckPath = "/healthz"
healthcheckTimeout = 100
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 10

[[services]]
name = "b4u2cc-proxy"

[services.variables]
PORT = "3456"
```

2. 部署
```bash
railway login
railway init
railway up
```

### DigitalOcean App Platform

1. 创建 `.do/app.yaml`:
```yaml
name: b4u2cc-proxy
services:
- name: proxy
  source_dir: deno-proxy
  run_command: deno run --allow-net --allow-env src/main.ts
  environment_slug: deno
  instance_count: 1
  instance_size_slug: basic-xxs
  env:
  - key: PORT
    value: "3456"
  - key: UPSTREAM_BASE_URL
    value: ${UPSTREAM_BASE_URL}
  - key: UPSTREAM_API_KEY
    value: ${UPSTREAM_API_KEY}
  http_port: 3456
  routes:
  - path: /
```

## 性能优化

### 内存优化

1. 调整 Deno 运行时参数
```bash
deno run --allow-net --allow-env \
  --v8-flags=--max-old-space-size=2048 \
  src/main.ts
```

2. 配置环境变量
```bash
# 减少日志输出
LOG_LEVEL=warn
LOGGING_DISABLED=true

# 优化聚合间隔
AGGREGATION_INTERVAL_MS=50

# 调整超时时间
TIMEOUT_MS=60000
```

### 并发优化

1. 增加请求限制
```bash
MAX_REQUESTS_PER_MINUTE=120
```

2. 使用连接池
```bash
# 在上游 API 支持的情况下
UPSTREAM_CONNECTION_POOL_SIZE=10
```

### 缓存策略

1. 响应缓存
```bash
# 启用简单缓存（如果适用）
ENABLE_CACHE=true
CACHE_TTL_SECONDS=300
```

## 监控与维护

### 健康检查

创建健康检查脚本:
```bash
#!/bin/bash
# health-check.sh

HEALTH_URL="http://localhost:3456/healthz"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_URL)

if [ $RESPONSE -eq 200 ]; then
    echo "Service is healthy"
    exit 0
else
    echo "Service is unhealthy (HTTP $RESPONSE)"
    exit 1
fi
```

### 日志管理

1. 日志轮转配置
```bash
# 创建 logrotate 配置
sudo tee /etc/logrotate.d/b4u2cc > /dev/null <<EOF
/opt/b4u2cc/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 deno deno
    postrotate
        systemctl reload b4u2cc
    endscript
}
EOF
```

2. 集中日志收集
```bash
# 使用 rsyslog 转发到日志服务器
echo "*.* @@logserver:514" | sudo tee -a /etc/rsyslog.conf
```

### 监控指标

1. Prometheus 指标（需要集成）
```typescript
// 在 main.ts 中添加指标收集
import { serve } from "https://deno.land/std/http/server.ts";

let requestCount = 0;
let errorCount = 0;

// 在请求处理中更新指标
requestCount++;

// 暴露指标端点
if (req.url === "/metrics") {
  return new Response(`
# HELP requests_total Total number of requests
# TYPE requests_total counter
requests_total ${requestCount}

# HELP errors_total Total number of errors
# TYPE errors_total counter
errors_total ${errorCount}
  `);
}
```

### 备份策略

1. 配置文件备份
```bash
#!/bin/bash
# backup-config.sh

BACKUP_DIR="/opt/backups/b4u2cc"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# 备份配置文件
cp /opt/b4u2cc/.env $BACKUP_DIR/env_$DATE
cp -r /opt/b4u2cc/deno-proxy $BACKUP_DIR/deno-proxy_$DATE

# 清理旧备份（保留30天）
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete
```

### 故障恢复

1. 自动重启脚本
```bash
#!/bin/bash
# auto-restart.sh

SERVICE_NAME="b4u2cc"
MAX_RETRIES=3
RETRY_DELAY=10

for i in $(seq 1 $MAX_RETRIES); do
    if systemctl is-active --quiet $SERVICE_NAME; then
        echo "Service is running"
        exit 0
    fi
    
    echo "Restarting service (attempt $i/$MAX_RETRIES)"
    systemctl restart $SERVICE_NAME
    sleep $RETRY_DELAY
done

echo "Failed to restart service after $MAX_RETRIES attempts"
exit 1
```

## 安全配置

### 防火墙设置

```bash
# UFW 配置
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3456/tcp  # 只允许本地访问
sudo ufw enable
```

### SSL/TLS 配置

使用 Let's Encrypt:
```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d your-domain.com

# 自动续期
sudo crontab -e
# 添加: 0 12 * * * /usr/bin/certbot renew --quiet
```

### 访问控制

```bash
# 配置客户端 API 密钥
export CLIENT_API_KEY="your-secure-client-key"

# 在 Nginx 中添加 IP 限制
location / {
    allow 192.168.1.0/24;
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:3456;
}
```

## 故障排除

### 常见问题

1. **服务无法启动**
   ```bash
   # 检查日志
   journalctl -u b4u2cc -n 50
   
   # 检查配置
   deno run --allow-net --allow-env --check src/main.ts
   
   # 检查端口占用
   netstat -tlnp | grep 3456
   ```

2. **上游连接失败**
   ```bash
   # 测试上游连接
   curl -H "Authorization: Bearer $UPSTREAM_API_KEY" \
        $UPSTREAM_BASE_URL
   
   # 检查网络路由
   traceroute upstream-host
   ```

3. **内存泄漏**
   ```bash
   # 监控内存使用
   ps aux | grep deno
   
   # 使用 Deno 分析器
   deno run --allow-net --allow-env --v8-flags=--prof src/main.ts
   ```

### 性能分析

1. 使用 Deno 内置分析器
```bash
deno run --allow-net --allow-env --v8-flags=--prof src/main.ts
```

2. 火焰图生成
```bash
# 安装 pprof
go install github.com/google/pprof@latest

# 分析性能数据
pprof -http=:8080 isolate-*.log
```

这个部署指南涵盖了从本地开发到生产环境的各种部署场景，包括性能优化、监控维护和安全配置等关键方面。