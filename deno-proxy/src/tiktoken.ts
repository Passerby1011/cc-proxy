/**
 * 使用官方 js-tiktoken 库进行 token 计算
 * 专为 Deno 环境优化
 */

import { getEncoding, encodingForModel } from "js-tiktoken";

// 缓存编码器以提高性能
const encoderCache = new Map<string, any>();

/**
 * 获取指定模型的编码器
 * @param model 模型名称
 * @returns 编码器实例
 */
function getEncoderForModel(model: string): any {
  if (encoderCache.has(model)) {
    return encoderCache.get(model);
  }

  let encoder;
  try {
    // 尝试根据模型获取对应的编码器
    // 使用类型断言来告诉 TypeScript 这是一个有效的 TiktokenModel
    encoder = encodingForModel(model as any);
  } catch (error) {
    // 如果模型不支持，回退到 cl100k_base (GPT-4 的编码器)
    console.warn(`Model ${model} not found in tiktoken, falling back to cl100k_base`);
    encoder = getEncoding("cl100k_base");
  }

  encoderCache.set(model, encoder);
  return encoder;
}

/**
 * 使用 tiktoken 计算 token 数量
 * @param text 要计算的文本
 * @param model 模型名称，默认使用 cl100k_base
 * @returns token 数量
 */
export function countTokensWithTiktoken(text: string, model: string = "cl100k_base"): number {
  try {
    const encoder = getEncoderForModel(model);
    const tokens = encoder.encode(text);
    return tokens.length;
  } catch (error) {
    console.error("Error counting tokens with tiktoken:", error);
    // 回退到简单的字符估算
    return Math.ceil(text.length / 4);
  }
}

/**
 * 将文本编码为 token 数组
 * @param text 要编码的文本
 * @param model 模型名称
 * @returns token 数组
 */
export function encodeText(text: string, model: string = "cl100k_base"): number[] {
  try {
    const encoder = getEncoderForModel(model);
    return encoder.encode(text);
  } catch (error) {
    console.error("Error encoding text with tiktoken:", error);
    // 回退到简单的字符分割
    return text.split('').map((_, i) => i);
  }
}

/**
 * 将 token 数组解码为文本
 * @param tokens token 数组
 * @param model 模型名称
 * @returns 解码后的文本
 */
export function decodeTokens(tokens: number[], model: string = "cl100k_base"): string {
  try {
    const encoder = getEncoderForModel(model);
    return encoder.decode(tokens);
  } catch (error) {
    console.error("Error decoding tokens with tiktoken:", error);
    // 回退到简单的字符串拼接
    return tokens.join('');
  }
}

/**
 * 获取详细的 token 分割结果（用于调试）
 * @param text 要分析的文本
 * @param model 模型名称
 * @returns token 详细信息数组
 */
export function getTokenDetails(text: string, model: string = "cl100k_base"): Array<{token: number, text: string}> {
  try {
    const encoder = getEncoderForModel(model);
    const tokens = encoder.encode(text);
    
    // 尝试逐个解码 token 以获取对应的文本
    const details: Array<{token: number, text: string}> = [];
    for (let i = 0; i < tokens.length; i++) {
      try {
        const singleToken = [tokens[i]];
        const decodedText = encoder.decode(singleToken);
        details.push({ token: tokens[i], text: decodedText });
      } catch {
        // 如果单个 token 无法解码，使用原始 token 值
        details.push({ token: tokens[i], text: `[${tokens[i]}]` });
      }
    }
    
    return details;
  } catch (error) {
    console.error("Error getting token details:", error);
    // 回退到简单的字符分割
    return text.split('').map((char, i) => ({ token: char.charCodeAt(0), text: char }));
  }
}

/**
 * 清理编码器缓存
 * 在应用关闭时调用以释放内存
 */
export function clearEncoderCache(): void {
  for (const encoder of encoderCache.values()) {
    try {
      if (encoder && typeof encoder.free === 'function') {
        encoder.free();
      }
    } catch (error) {
      console.error("Error freeing encoder:", error);
    }
  }
  encoderCache.clear();
}

/**
 * 获取支持的模型列表
 * @returns 支持的模型名称数组
 */
export function getSupportedModels(): string[] {
  return [
    "gpt-4",
    "gpt-4-0314",
    "gpt-4-32k",
    "gpt-4-32k-0314",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0301",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0125",
    "text-davinci-003",
    "text-davinci-002",
    "text-davinci-001",
    "text-curie-001",
    "text-babbage-001",
    "text-ada-001",
    "davinci",
    "curie",
    "babbage",
    "ada",
  ];
}

/**
 * 检查模型是否支持
 * @param model 模型名称
 * @returns 是否支持
 */
export function isModelSupported(model: string): boolean {
  return getSupportedModels().includes(model);
}

// 在进程退出时清理缓存
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('unload', clearEncoderCache);
}