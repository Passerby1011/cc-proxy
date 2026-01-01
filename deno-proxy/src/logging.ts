import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// 检查是否禁用日志
const LOGGING_DISABLED = Deno.env.get("LOGGING_DISABLED") === "true" || Deno.env.get("LOGGING_DISABLED") === "1";
const configuredLevel = (Deno.env.get("LOG_LEVEL")?.toLowerCase() as LogLevel) ?? "info";
const LOG_FORMAT = Deno.env.get("LOG_FORMAT") ?? "pretty"; // plain | json | pretty
const LOG_COLORS = Deno.env.get("LOG_COLORS") !== "false"; // 默认启用颜色

// ANSI 颜色代码
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  
  // 前景色
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  
  // 背景色
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
};

// 颜色辅助函数
function colorize(text: string, color: string): string {
  if (!LOG_COLORS) return text;
  return `${color}${text}${colors.reset}`;
}

// 日志级别图标和颜色
const levelConfig: Record<LogLevel, { icon: string; color: string; label: string }> = {
  debug: { icon: "🔍", color: colors.blue, label: "DEBUG" },
  info: { icon: "ℹ️", color: colors.green, label: "INFO " },
  warn: { icon: "⚠️", color: colors.yellow, label: "WARN " },
  error: { icon: "❌", color: colors.red, label: "ERROR" },
};

// 特殊阶段标记
export const LogPhase = {
  REQUEST: { icon: "📨", color: colors.cyan, label: "REQUEST" },
  ENRICHED: { icon: "📝", color: colors.magenta, label: "ENRICHED" },
  UPSTREAM: { icon: "🚀", color: colors.blue, label: "UPSTREAM" },
  STREAM: { icon: "⚡", color: colors.cyan, label: "STREAM" },
  TOOL: { icon: "🔧", color: colors.magenta, label: "TOOL" },
  THINKING: { icon: "💭", color: colors.blue, label: "THINKING" },
  COMPLETE: { icon: "✅", color: colors.green, label: "COMPLETE" },
  ERROR: { icon: "🔴", color: colors.red, label: "ERROR" },
  STATS: { icon: "📊", color: colors.cyan, label: "STATS" },
};

// Request-specific log files
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

// 格式化元数据
function formatMeta(meta?: Record<string, unknown>, compact = false): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (key === "requestId" || value === undefined || value === null) continue;
    
    let valueStr: string;
    if (typeof value === "string") {
      // 字符串长度限制（控制台输出简洁化）
      if (compact && value.length > 100) {
        valueStr = value.slice(0, 97) + "...";
      } else {
        valueStr = value;
      }
    } else if (typeof value === "object") {
      // JSON 对象简化显示
      if (compact) {
        valueStr = JSON.stringify(value);
        if (valueStr.length > 100) {
          valueStr = valueStr.slice(0, 97) + "...";
        }
      } else {
        valueStr = JSON.stringify(value, null, 2);
      }
    } else {
      valueStr = String(value);
    }
    
    parts.push(`${colorize(key, colors.gray)}=${colorize(valueStr, colors.white)}`);
  }
  
  return parts.length > 0 ? " | " + parts.join(", ") : "";
}

// Pretty 格式输出（带颜色和图标）
function prettyLog(level: LogLevel, message: string, meta?: Record<string, unknown>, phase?: typeof LogPhase[keyof typeof LogPhase]) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 12); // 只显示时:分:秒.毫秒
  const config = phase || levelConfig[level];
  
  const timeStr = colorize(timestamp, colors.gray);
  const iconStr = config.icon;
  const labelStr = colorize(`[${config.label}]`, config.color);
  const messageStr = colorize(message, colors.white);
  const metaStr = formatMeta(meta, true);
  
  const line = `${timeStr} ${iconStr} ${labelStr} ${messageStr}${metaStr}`;
  
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

// Plain 格式输出（无颜色，兼容旧版）
function plainLog(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const levelTag = `[${level.toUpperCase()}]`.padEnd(7);
  const metaStr = formatMeta(meta, false);
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

// JSON 格式输出（结构化）
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
  phase?: typeof LogPhase[keyof typeof LogPhase]
) {
  // 如果日志被禁用，直接返回
  if (LOGGING_DISABLED) return;
  
  if (levelOrder[level] < levelOrder[configuredLevel]) return;
  
  // 控制台输出（根据格式）
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
      prettyLog(level, message, meta, phase); // Pretty 格式不在 meta 中重复显示 requestId
      break;
  }
  
  // 文件输出（保持原有格式）
  const timestamp = new Date().toISOString();
  const levelTag = `[${level.toUpperCase()}]`.padEnd(7);
  let metaStr = "";
  if (meta && Object.keys(meta).length > 0) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (key === "requestId" || value === undefined || value === null) continue;
      
      let valueStr: string;
      if (typeof value === "string") {
        valueStr = value;
      } else if (typeof value === "object") {
        valueStr = JSON.stringify(value, null, 2);
      } else {
        valueStr = String(value);
      }
      parts.push(`${key}=${valueStr}`);
    }
    if (parts.length > 0) {
      metaStr = " | " + parts.join(", ");
    }
  }
  
  const line = `${timestamp} ${levelTag} ${message}${metaStr}\n`;
  
  try {
    const file = await getRequestLogFile(requestId);
    await file.write(new TextEncoder().encode(line));
  } catch (error) {
    console.error(`Failed to write to request log: ${error}`);
  }
}

// 系统日志（非请求相关）
export function log(
  level: LogLevel, 
  message: string, 
  meta?: Record<string, unknown>,
  phase?: typeof LogPhase[keyof typeof LogPhase]
) {
  // 如果日志被禁用，直接返回
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

// 特殊格式：请求开始横幅
export function logRequestStart(requestId: string, meta: { model?: string; tools?: number; stream?: boolean; channel?: string }) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;
  
  if (LOG_FORMAT === "pretty") {
    const shortId = requestId.slice(0, 8);
    const toolsInfo = meta.tools ? ` | ${colorize(`🔧 ${meta.tools} tools`, colors.magenta)}` : "";
    const streamInfo = meta.stream ? ` | ${colorize("📊 stream", colors.cyan)}` : "";
    const channelInfo = meta.channel ? ` | ${colorize(`🌐 ${meta.channel}`, colors.blue)}` : "";
    
    console.log("");
    console.log(colorize("┌" + "─".repeat(60), colors.gray));
    console.log(colorize("│", colors.gray) + ` ${LogPhase.REQUEST.icon} ${colorize(`[${LogPhase.REQUEST.label}]`, LogPhase.REQUEST.color)} ${colorize(shortId, colors.white)}`);
    if (meta.model) {
      console.log(colorize("│", colors.gray) + ` ${colorize("🎯", colors.yellow)} Model: ${colorize(meta.model, colors.white)}${channelInfo}${toolsInfo}${streamInfo}`);
    }
    console.log(colorize("└" + "─".repeat(60), colors.gray));
  } else {
    log("info", "Request started", { requestId, ...meta });
  }
}

// 特殊格式：请求完成摘要
export function logRequestComplete(requestId: string, meta: { duration: number; inputTokens?: number; outputTokens?: number; error?: string }) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;
  
  if (LOG_FORMAT === "pretty") {
    const durationStr = `${(meta.duration / 1000).toFixed(2)}s`;
    const tokensStr = meta.inputTokens && meta.outputTokens 
      ? `${meta.inputTokens}→${meta.outputTokens} tokens` 
      : "";
    
    if (meta.error) {
      console.log(`  ${colorize("└─", colors.gray)} ${LogPhase.ERROR.icon} ${colorize(`[${LogPhase.ERROR.label}]`, LogPhase.ERROR.color)} ${colorize(meta.error, colors.red)}`);
    } else {
      console.log(`  ${colorize("└─", colors.gray)} ${LogPhase.COMPLETE.icon} ${colorize(`[${LogPhase.COMPLETE.label}]`, LogPhase.COMPLETE.color)} ${colorize(durationStr, colors.green)}${tokensStr ? ` | ${LogPhase.STATS.icon} ${colorize(tokensStr, colors.cyan)}` : ""}`);
    }
    console.log("");
  } else {
    log(meta.error ? "error" : "info", meta.error ? "Request failed" : "Request completed", { requestId, ...meta });
  }
}

// 特殊格式：阶段日志（带缩进）
export function logPhase(requestId: string, phase: typeof LogPhase[keyof typeof LogPhase], message: string, meta?: Record<string, unknown>) {
  if (LOGGING_DISABLED || levelOrder.info < levelOrder[configuredLevel]) return;
  
  if (LOG_FORMAT === "pretty") {
    const metaStr = formatMeta(meta, true);
    console.log(`  ${colorize("├─", colors.gray)} ${phase.icon} ${colorize(`[${phase.label}]`, phase.color)} ${colorize(message, colors.white)}${metaStr}`);
  } else {
    log("info", message, { requestId, phase: phase.label, ...meta });
  }
}
