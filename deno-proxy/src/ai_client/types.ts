/**
 * AI 璇锋眰瀹㈡埛绔被鍨嬪畾涔?
 *
 * 鏈枃浠跺畾涔変簡 AI 璇锋眰鐩稿叧鐨勬墍鏈夋牳蹇冪被鍨嬶紝鍖呮嫭锛?
 * - 涓婃父閰嶇疆
 * - 璇锋眰閫夐」
 * - 鍝嶅簲鏍煎紡
 * - 鍗忚绫诲瀷
 * - 宸ュ叿璋冪敤妯″紡
 * - 璇锋眰鏍煎紡
 */

import { ClaudeMessage, ClaudeRequest } from "../types.ts";
import { ProxyConfig } from "../config.ts";
import { ToolCallDelimiter } from "../signals.ts";

/**
 * 鍗忚绫诲瀷鏋氫妇
 *
 * 馃搶 褰撳墠瀹炵幇锛歰penai, anthropic
 * 馃敭 鏈潵鎵╁睍锛歡emini锛堥鐣欙級
 */
export type Protocol = "openai" | "openai-responses" | "anthropic" | "gemini";

/**
 * 宸ュ叿璋冪敤妯″紡鏋氫妇
 *
 * 馃搶 褰撳墠瀹炵幇锛歱rompt_injection锛堟彁绀鸿瘝娉ㄥ叆锛?
 * 馃敭 鏈潵鎵╁睍锛歯ative锛堝師鐢熷伐鍏疯皟鐢級銆乤uto锛堣嚜鍔ㄩ€夋嫨锛?
 */
export type ToolCallMode = "prompt_injection" | "native" | "auto";

/**
 * 璇锋眰鏍煎紡鏋氫妇
 *
 * 馃搶 褰撳墠瀹炵幇锛歛nthropic锛圕laude 鏍煎紡锛?
 * 馃敭 鏈潵鎵╁睍锛歰penai锛圤penAI 鏍煎紡锛屾敮鎸佽嚜鍔ㄨ浆鎹級
 */
export type RequestFormat = "anthropic" | "openai";

/**
 * 涓婃父閰嶇疆
 * 灏佽瑙ｆ瀽鍚庣殑娓犻亾淇℃伅
 */
export interface UpstreamConfig {
  /** 涓婃父 API 鍩虹 URL */
  baseUrl: string;

  /** 涓婃父 API 瀵嗛挜 */
  apiKey?: string;

  /** 涓婃父妯″瀷鍚嶇О */
  model: string;

  /** 涓婃父鍗忚绫诲瀷 */
  protocol: Protocol;

  /** 鏄惁鏀寔鍘熺敓宸ュ叿璋冪敤锛堥粯璁?false锛屼娇鐢?XML 娉ㄥ叆锛?*/
  supportsNativeToolCalling?: boolean;

  /** 鏄惁鏀寔绯荤粺鎻愮ず璇嶏紙榛樿 true锛屼笉鏀寔鏃惰浆鎹负 user 娑堟伅锛?*/
  supportsSystemPrompt?: boolean;
}

/**
 * AI 璇锋眰閫夐」
 * 缁熶竴绠＄悊璇锋眰鍙傛暟
 */
export interface AIRequestOptions {
  /** 鏄惁鍚敤娴佸紡杈撳嚭 */
  stream?: boolean;

  /** 鏈€澶х敓鎴?token 鏁?*/
  max_tokens?: number;

  /** 娓╁害鍙傛暟锛?-1锛?*/
  temperature?: number;

  /** Top-P 閲囨牱鍙傛暟锛?-1锛?*/
  top_p?: number;

  /** 鍏冩暟鎹?*/
  metadata?: Record<string, unknown>;

  /** 宸ュ叿瀹氫箟 */
  tools?: unknown[];

  /** 宸ュ叿閫夋嫨绛栫暐 */
  tool_choice?: unknown;

  /** 鎬濊€冮厤缃?*/
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
}

/**
 * AI 鍝嶅簲鏍煎紡
 * 缁熶竴鐨勫搷搴旂粨鏋?
 */
export interface AIResponse {
  /** 鍝嶅簲鍐呭 */
  content: string | ClaudeMessage["content"];

  /** Token 浣跨敤鎯呭喌 */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };

  /** 瀹屾垚鍘熷洜 */
  finish_reason?: string;

  /** 鍘熷鍝嶅簲锛堢敤浜庤皟璇曪級 */
  raw?: unknown;
}

/**
 * 娴佸紡鍝嶅簲鍧?
 */
export interface StreamChunk {
  /** 鏂囨湰鍐呭 */
  text?: string;

  /** 浜嬩欢绫诲瀷 */
  type?: string;

  /** 鍘熷鏁版嵁 */
  data?: unknown;
}

/**
 * 娴佸紡鍥炶皟鍑芥暟
 * 鐢ㄤ簬澶勭悊娴佸紡鍝嶅簲
 */
export type StreamCallback = (chunk: StreamChunk) => Promise<void>;

/**
 * 璇锋眰涓婁笅鏂囨暟鎹?
 * 鐢ㄤ簬浼犻€掔粰 RequestContext 绫?
 */
export interface RequestContextData {
  /** 涓婃父閰嶇疆 */
  upstreamConfig: UpstreamConfig;

  /** 鍘熷璇锋眰 */
  originalRequest: ClaudeRequest;

  /** 澧炲己鍚庣殑璇锋眰 */
  enrichedRequest: ClaudeRequest;

  /** 宸ュ叿璋冪敤鍒嗛殧绗?*/
  delimiter?: ToolCallDelimiter;

  /** 鍏ㄥ眬閰嶇疆 */
  config: ProxyConfig;

  /** 璇锋眰 ID */
  requestId: string;

  /** 璇锋眰鏍煎紡 */
  requestFormat: RequestFormat;

  /** 宸ュ叿璋冪敤妯″紡 */
  toolCallMode: ToolCallMode;

  /** 瀹㈡埛绔?API 瀵嗛挜锛堢敤浜庨€忎紶锛?*/
  clientApiKey?: string;
}

/**
 * 鏃ュ織绾у埆
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 鏃ュ織鍏冩暟鎹?
 */
export interface LogMetadata {
  /** 璇锋眰 ID */
  requestId?: string;

  /** 璇锋眰闃舵 */
  phase?: string;

  /** 鍏朵粬鍏冩暟鎹?*/
  [key: string]: unknown;
}

/**
 * 鎬ц兘鎸囨爣
 */
export interface PerformanceMetrics {
  /** 棣栧瓧鑺傛椂闂达紙TTFB锛?*/
  ttfb?: number;

  /** 鎬昏€楁椂 */
  totalTime?: number;

  /** 杈撳叆 token 鏁?*/
  inputTokens?: number;

  /** 杈撳嚭 token 鏁?*/
  outputTokens?: number;

  /** 閲嶈瘯娆℃暟 */
  retryCount?: number;
}
