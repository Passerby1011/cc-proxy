import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (Deno.env.get("LOG_LEVEL")?.toLowerCase() as LogLevel) ?? "info";

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

export async function logRequest(requestId: string, level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (levelOrder[level] < levelOrder[configuredLevel]) return;
  
  const levelTag = `[${level.toUpperCase()}]`.padEnd(7);
  
  // Format metadata, exclude requestId and timestamp
  let metaStr = "";
  if (meta && Object.keys(meta).length > 0) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (key === "requestId" || value === undefined || value === null) continue;
      
      let valueStr: string;
      if (typeof value === "string") {
        // No truncation for strings
        valueStr = value;
      } else if (typeof value === "object") {
        // Pretty print JSON with 2-space indentation
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
  
  const line = `${levelTag} ${message}${metaStr}\n`;
  
  try {
    const file = await getRequestLogFile(requestId);
    await file.write(new TextEncoder().encode(line));
  } catch (error) {
    console.error(`Failed to write to request log: ${error}`);
  }
}

// Keep original log function for non-request logs (system logs)
export function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (levelOrder[level] < levelOrder[configuredLevel]) return;
  
  const timestamp = new Date().toISOString();
  const levelTag = `[${level.toUpperCase()}]`.padEnd(7);
  
  // Format metadata
  let metaStr = "";
  if (meta && Object.keys(meta).length > 0) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined || value === null) continue;
      
      let valueStr: string;
      if (typeof value === "string") {
        // No truncation for strings
        valueStr = value;
      } else if (typeof value === "object") {
        // Pretty print JSON with 2-space indentation
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