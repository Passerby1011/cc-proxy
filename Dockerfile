# syntax=docker/dockerfile:1

# 通过 ARG 控制 Deno 版本，方便统一升级
ARG DENO_VERSION=2.0.0

FROM denoland/deno:${DENO_VERSION} AS builder
ENV DENO_DIR=/deno-dir
WORKDIR /app/deno-proxy

# 仅复制运行必需文件，暂不引入 lockfile 以避免版本兼容问题
COPY deno-proxy/deno.json ./deno.json
COPY deno-proxy/src ./src

# 预热 Deno 依赖缓存（跳过以避免锁文件兼容性导致构建失败）
# RUN deno cache src/main.ts

FROM denoland/deno:alpine-${DENO_VERSION} AS runtime
ENV DENO_DIR=/deno-dir
WORKDIR /app/deno-proxy

# 拷贝源码与缓存，加速冷启动
COPY --from=builder /app/deno-proxy ./ 
COPY --from=builder /deno-dir /deno-dir

# 创建非 root 用户与日志目录，保证写权限
RUN set -eux; \
    addgroup -S app && adduser -S app -G app; \
    mkdir -p /app/deno-proxy/logs/req; \
    chown -R app:app /app/deno-proxy /deno-dir

EXPOSE 3456

# 提供合理的默认环境变量，可在运行时覆盖
ENV HOST=0.0.0.0 \
    PORT=3456 \
    LOG_LEVEL=info

USER app

# 运行主进程时仅授予必要权限
CMD ["run", "--allow-net", "--allow-env", "--allow-read=.", "--allow-write=/app", "src/main.ts"]
