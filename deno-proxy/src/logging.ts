import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogPhaseConfig = {
  icon: string;
  color: string;
  label: string;
};

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// 允许通过环境变量关闭日志。
const LOGGING_DISABLED = Deno.env.get("LOGGING_DISABLED") === "true" || Deno.env.get("LOGGING_DISABLED") === "1";

const envLevel = Deno.env.get("LOG_LEVEL")?.toLowerCase();
const configuredLevel: LogLevel = envLevel && envLevel in levelOrder
  ? envLevel as LogLevel
  : "info";

const LOG_FORMAT = Deno.env.get("LOG_FORMAT") ?? "pretty"; // plain | json | pretty
const LOG_COLORS = Deno.env.get("LOG_COLORS") !== "false";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
};

function colorize(text: string, color: string, enabled = LOG_COLORS): string {
  if (!enabled) return text;
  return `${color}${text}${colors.reset}`;
}

const levelConfig: Record<LogLevel, LogPhaseConfig> = {
  debug: { icon: "🔍", color: colors.blue, label: "DEBUG" },
  info: { icon: "ℹ️", color: colors.green, label: "INFO" },
  warn: { icon: "⚠️", color: colors.yellow, label: "WARN" },
  error: { icon: "❌", color: colors.red, label: "ERROR" },
};

export const LogPhase = {
  REQUEST: { icon: "📨", color: colors.cyan, label: "REQUEST" },
  ENRICHED: { icon: "🧩", color: colors.magenta, label: "ENRICHED" },
  UPSTREAM: { icon: "🚀", color: colors.blue, label: "UPSTREAM" },
  STREAM: { icon: "🌊", color: colors.cyan, label: "STREAM" },
  COMPLETE: { icon: "✅", color: colors.green, label: "COMPLETE" },
  ERROR: { icon: "❌", color: colors.red, label: "ERROR" },
  STATS: { icon: "📊", color: colors.cyan, label: "STATS" },

  TOOL: { icon: "🛠️", color: colors.magenta, label: "TOOL" },
  TOOL_INTERCEPT: { icon: "🕸️", color: colors.magenta, label: "INTERCEPT" },
  TOOL_EXECUTE: { icon: "⚙️", color: colors.blue, label: "EXECUTE" },
  TOOL_RESULT: { icon: "📦", color: colors.green, label: "RESULT" },

  WEB_SEARCH: { icon: "🔎", color: colors.cyan, label: "SEARCH" },
  WEB_FETCH: { icon: "🌐", color: colors.blue, label: "FETCH" },
  WEB_SCRAPE: { icon: "📰", color: colors.blue, label: "SCRAPE" },
  DEEP_BROWSE: { icon: "🧭", color: colors.magenta, label: "BROWSE" },

  AI_ANALYSIS: { icon: "🤖", color: colors.blue, label: "ANALYSIS" },
  AI_QUERY: { icon: "💬", color: colors.cyan, label: "QUERY" },
  THINKING: { icon: "🧠", color: colors.blue, label: "THINKING" },

  RETRY: { icon: "🔁", color: colors.yellow, label: "RETRY" },
  RETRY_SUCCESS: { icon: "✅", color: colors.green, label: "RETRY_OK" },
  RETRY_FAILED: { icon: "❌", color: colors.red, label: "RETRY_FAIL" },

  CONFIG: { icon: "⚙️", color: colors.cyan, label: "CONFIG" },
  STORAGE: { icon: "💾", color: colors.blue, label: "STORAGE" },
  SYNC: { icon: "🔄", color: colors.cyan, label: "SYNC" },

  PROTOCOL: { icon: "🔀", color: colors.magenta, label: "PROTOCOL" },
  FORMAT: { icon: "🧾", color: colors.blue, label: "FORMAT" },

  PERFORMANCE: { icon: "⏱️", color: colors.yellow, label: "PERF" },
  TOKEN_COUNT: { icon: "🔢", color: colors.cyan, label: "TOKENS" },

  CLIENT: { icon: "👤", color: colors.green, label: "CLIENT" },
  DISCONNECT: { icon: "🔌", color: colors.yellow, label: "DISCONNECT" },
} as const;

const requestLogFiles = new Map<string, Deno.FsFile>();

async function getRequestLogFile(requestId: string): Promise<Deno.FsFile> {
  let file = requestLogFiles.get(requestId);
  if (!file) {
    await ensureDir("logs/req");
    file = await Deno.open(`logs/req/${requestId}.txt`, {
      write: true,
      create: true,
      append: true,
    });
    requestLogFiles.set(requestId, file);
  }
  return file;
}

export async function closeRequestLog(requestId: string) {
  const file = requestLogFiles.get(requestId);
  if (file) {
    file.close();
    requestLogFiles.delete(requestId);
  }
}

function stringifyMetaValue(value: unknown, compact: boolean): string {
  if (typeof value === "string") {
    if (compact && value.length > 100) {
      return `${value.slice(0, 97)}...`;
    }
    return value;
  }

  if (typeof value === "object") {
    const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    if (compact && json.length > 100) {
      return `${json.slice(0, 97)}...`;
    }
    return json;
  }

  return String(value);
}

function formatMeta(
  meta?: Record<string, unknown>,
  compact = false,
  withColor = false,
): string {
  if (!meta || Object.keys(meta).length === 0) return "";

  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (key === "requestId" || value === undefined || value === null) continue;

    const valueStr = stringifyMetaValue(value, compact);
    if (withColor) {
      parts.push(`${colorize(key, colors.gray)}=${colorize(valueStr, colors.white)}`);
    } else {
      parts.push(`${key}=${valueStr}`);
    }
  }

  return parts.length > 0 ? ` | ${parts.join(", ")}` : "";
}

function prettyLog(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  phase?: LogPhaseConfig,
) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
  const config = phase || levelConfig[level];

  const timeStr = colorize(timestamp, colors.gray);
  const labelStr = colorize(`[${config.label}]`, config.color);
  const messageStr = colorize(message, colors.white);
  const metaStr = formatMeta(meta, true, true);
  const line = `${timeStr} ${config.icon} ${labelStr} ${messageStr}${metaStr}`;

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

function plainLog(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const levelTag = `[${level.toUpperCase()}]`.padEnd(7);
  const metaStr = formatMeta(meta, false, false);
  const line = `${timestamp} ${levelTag} ${message}${metaStr}`;

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

function jsonLog(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  console.log(JSON.stringify(logEntry));
}

export async function logRequest(
  requestId: string,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  phase?: LogPhaseConfig,
) {
  if (LOGGING_DISABLED) return;
  if (levelOrder[level] < levelOrder[configuredLevel]) return;

  const fullMeta = { ...meta, requestId };

  switch (LOG_FORMAT) {
    case "json":
      jsonLog(level, message, fullMeta);
      break;
    case "plain":
      plainLog(level, message, fullMeta);
      break;
    case "pretty":
    default:
      prettyLog(level, message, meta, phase);
      break;
  }

  const timestamp = new Date().toISOString();
  const levelTag = `[${level.toUpperCase()}]`.padEnd(7);
  const metaStr = formatMeta(meta, false, false);
  const line = `${timestamp} ${levelTag} ${message}${metaStr}\n`;

  try {
    const file = await getRequestLogFile(requestId);
    await file.write(new TextEncoder().encode(line));
  } catch (error) {
    console.error(`Failed to write to request log: ${error}`);
  }
}

export function log(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  phase?: LogPhaseConfig,
) {
  if (LOGGING_DISABLED) return;
  if (levelOrder[level] < levelOrder[configuredLevel]) return;

  switch (LOG_FORMAT) {
    case "json":
      jsonLog(level, message, meta);
      break;
    case "plain":
      plainLog(level, message, meta);
      break;
    case "pretty":
    default:
      prettyLog(level, message, meta, phase);
      break;
  }
}

export function logConfigInfo(config: Record<string, unknown>, title: string) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;

  const excludeFields = [
    "apiKey",
    "clientApiKey",
    "adminApiKey",
    "pgStoreDsn",
    "upstreamApiKey",
    "baseUrl",
    "upstreamBaseUrl",
    "upstreamModelOverride",
    "configFilePath",
  ];

  const fieldNameMap: Record<string, string> = {
    port: "服务端口",
    host: "绑定地址",
    requestTimeoutMs: "请求超时",
    aggregationIntervalMs: "聚合间隔",
    maxRequestsPerMinute: "频率限制",
    tokenMultiplier: "Token 倍数",
    autoPort: "自动端口",
    passthroughApiKey: "透传模式",
    defaultProtocol: "默认协议",
    channelConfigs: "渠道配置",
    toolCallRetry: "工具重试",
    webTools: "Web 工具",
    firecrawl: "Firecrawl",
  };

  const safeConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (excludeFields.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
      continue;
    }

    const displayName = fieldNameMap[key];
    if (!displayName) continue;

    if (key === "channelConfigs" && Array.isArray(value)) {
      safeConfig[displayName] = value.map((ch: any) => {
        const trigger = ch.autoTrigger === true ? "自动" : ch.autoTrigger === false ? "按需" : "全局";
        return `${ch.name}-${ch.protocol}-${trigger}`;
      });
      continue;
    }

    if (key === "toolCallRetry" && value && typeof value === "object") {
      const retry = value as any;
      safeConfig[displayName] = retry.enabled
        ? `启用(${retry.maxRetries}次, ${retry.timeout}ms)`
        : "关闭";
      continue;
    }

    if (key === "webTools" && value && typeof value === "object") {
      const web = value as any;
      const parts: string[] = [];
      if (web.enableSearchIntercept) parts.push("Search");
      if (web.enableFetchIntercept) parts.push("Fetch");
      safeConfig[displayName] = parts.length > 0
        ? `${parts.join("+")}/${web.autoTrigger ? "自动触发" : "按需触发"}`
        : "关闭";
      continue;
    }

    if (key === "firecrawl" && value && typeof value === "object") {
      const firecrawl = value as any;
      safeConfig[displayName] = firecrawl.apiKey ? "已配置" : "未配置";
      continue;
    }

    if (key === "passthroughApiKey") {
      safeConfig[displayName] = value ? "启用" : "关闭";
      continue;
    }

    if (key === "requestTimeoutMs" || key === "aggregationIntervalMs") {
      safeConfig[displayName] = `${value}ms`;
      continue;
    }

    if (key === "maxRequestsPerMinute") {
      safeConfig[displayName] = `${value} 次/分钟`;
      continue;
    }

    safeConfig[displayName] = value;
  }

  if (LOG_FORMAT === "pretty") {
    console.log("");
    console.log(colorize("=".repeat(72), colors.gray));
    console.log(`${LogPhase.CONFIG.icon} ${colorize(`[${LogPhase.CONFIG.label}]`, LogPhase.CONFIG.color)} ${colorize(title, `${colors.bright}${colors.white}`)}`);
    console.log(colorize("=".repeat(72), colors.gray));

    for (const [key, value] of Object.entries(safeConfig)) {
      const renderedValue = Array.isArray(value)
        ? value.map((item, index) => `${colorize(`#${index + 1}`, colors.gray)} ${colorize(String(item), colors.white)}`).join("\n     ")
        : colorize(String(value), colors.white);
      console.log(`  ${colorize("-", colors.gray)} ${colorize(key, colors.yellow)}: ${renderedValue}`);
    }

    console.log("");
    return;
  }

  log("info", title, safeConfig, LogPhase.CONFIG);
}

export function logRequestStart(
  requestId: string,
  meta: {
    model?: string;
    tools?: number;
    stream?: boolean;
    channel?: string;
    autoTrigger?: boolean;
    downstreamFormat?: string;
    upstreamProtocol?: string;
    upstreamModel?: string;
    toolCallMode?: string;
  },
) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;

  if (LOG_FORMAT === "pretty") {
    const shortId = requestId.slice(0, 8);
    const details = [
      meta.model ? `model=${meta.model}` : "",
      meta.channel ? `channel=${meta.channel}` : "",
      meta.downstreamFormat ? `downstream=${meta.downstreamFormat}` : "",
      meta.upstreamProtocol ? `upstream=${meta.upstreamProtocol}` : "",
      meta.upstreamModel ? `upstreamModel=${meta.upstreamModel}` : "",
      meta.toolCallMode ? `toolMode=${meta.toolCallMode}` : "",
      meta.tools ? `tools=${meta.tools}` : "",
      meta.stream ? "stream=true" : "stream=false",
      meta.autoTrigger !== undefined ? `autoTrigger=${meta.autoTrigger}` : "",
    ].filter(Boolean).join(" | ");

    console.log("");
    console.log(colorize("=".repeat(72), colors.gray));
    console.log(`${LogPhase.REQUEST.icon} ${colorize(`[${LogPhase.REQUEST.label}]`, LogPhase.REQUEST.color)} ${colorize(shortId, colors.white)}`);
    if (details) {
      console.log(`  ${colorize(details, colors.white)}`);
    }
    console.log(colorize("=".repeat(72), colors.gray));
    return;
  }

  log("info", "Request started", { requestId, ...meta }, LogPhase.REQUEST);
}

export function logRequestComplete(
  requestId: string,
  meta: { duration: number; inputTokens?: number; outputTokens?: number; error?: string },
) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;

  if (LOG_FORMAT === "pretty") {
    const durationStr = `${(meta.duration / 1000).toFixed(2)}s`;
    const tokensStr = meta.inputTokens !== undefined && meta.outputTokens !== undefined
      ? `${meta.inputTokens}->${meta.outputTokens} tokens`
      : "";

    if (meta.error) {
      console.log(`  - ${LogPhase.ERROR.icon} ${colorize(`[${LogPhase.ERROR.label}]`, LogPhase.ERROR.color)} ${colorize(meta.error, colors.red)}`);
    } else {
      console.log(`  - ${LogPhase.COMPLETE.icon} ${colorize(`[${LogPhase.COMPLETE.label}]`, LogPhase.COMPLETE.color)} ${colorize(durationStr, colors.green)}${tokensStr ? ` | ${LogPhase.STATS.icon} ${colorize(tokensStr, colors.cyan)}` : ""}`);
    }
    console.log("");
    return;
  }

  log(meta.error ? "error" : "info", meta.error ? "Request failed" : "Request completed", { requestId, ...meta }, meta.error ? LogPhase.ERROR : LogPhase.COMPLETE);
}

export function logPhase(
  requestId: string,
  phase: LogPhaseConfig,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;

  if (LOG_FORMAT === "pretty") {
    const metaStr = formatMeta(meta, true, true);
    console.log(`  - ${phase.icon} ${colorize(`[${phase.label}]`, phase.color)} ${colorize(message, colors.white)}${metaStr}`);
    return;
  }

  log("info", message, { requestId, phase: phase.label, ...meta }, phase);
}
