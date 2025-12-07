#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY_SCRIPT="${ROOT_DIR}/scripts/start-deno-proxy.sh"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/deno-proxy.log"

if [[ ! -x "${PROXY_SCRIPT}" ]]; then
  echo "Proxy launcher not found or not executable: ${PROXY_SCRIPT}" >&2
  exit 1
fi

echo "[proxy-wrapper] starting deno proxy..."
"${PROXY_SCRIPT}" >> "${LOG_FILE}" 2>&1 &
PROXY_PID=$!
trap 'echo "[proxy-wrapper] stopping proxy (pid ${PROXY_PID})"; kill ${PROXY_PID} >/dev/null 2>&1 || true' EXIT

HEALTH_URL="http://localhost:3456/healthz"
for _ in {1..30}; do
  if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
  echo "[proxy-wrapper] proxy failed to become healthy" >&2
  exit 1
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-sk-}"
export ANTHROPIC_BASE_URL="http://localhost:3456"
export ANTHROPIC_MODEL="claude-4.5-sonnet-cc"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-4.5-sonnet-cc"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-4.5-sonnet-cc"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-4.5-sonnet-cc"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-4.5-sonnet-cc"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

echo "[proxy-wrapper] proxy ready, launching Claude Code..."
claude "$@"
