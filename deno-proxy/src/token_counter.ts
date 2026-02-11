import { ClaudeMessage, ClaudeRequest } from "./types.ts";
import { ProxyConfig } from "./config.ts";
import { logRequest } from "./logging.ts";
import { countTokensWithTiktoken } from "./tiktoken.ts";

export interface TokenCountResult {
  input_tokens: number; // 最新官方 API 字段名
  token_count?: number; // 保持向后兼容
  tokens?: number; // 保持向后兼容
  output_tokens?: number;
}

/**
 * 使用 tiktoken 进行精确的 token 估算
 */
export function estimateTokensFromText(text: string, model: string = "cl100k_base"): number {
  try {
    const tokens = countTokensWithTiktoken(text, model);
    // 防御性处理：如果第三方库返回了 NaN/Infinity，则退回到简单估算
    if (!Number.isFinite(tokens) || tokens < 0) {
      return Math.ceil(text.length / 4);
    }
    return tokens;
  } catch (error) {
    // 如果 tiktoken 失败，回退到简单的字符估算
    return Math.ceil(text.length / 4);
  }
}

/**
 * 模拟 API 协议格式提取文本，以获得更准确的 token 计数
 * 包含角色标签和消息分隔符的开销
 */
export function extractTextForCounting(request: ClaudeRequest): string {
  let fullPrompt = "";

  // 1. 添加系统提示词（包含包装开销）
  if (request.system) {
    // system 现在统一为数组格式
    const systemText = request.system
      .map((block) => block.type === "text" ? block.text : "")
      .join("");
    fullPrompt += `System: ${systemText}\n\n`;
  }

  // 2. 遍历消息
  for (const msg of request.messages) {
    const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    fullPrompt += `${role}: `;

    if (typeof msg.content === "string") {
      fullPrompt += msg.content;
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          fullPrompt += block.text;
        } else if (block.type === "tool_use") {
          // 模拟工具调用的 XML 或 JSON 结构开销
          fullPrompt += `<tool_use>${block.name}${JSON.stringify(block.input)}</tool_use>`;
        } else if (block.type === "tool_result") {
          fullPrompt += `<tool_result>${block.content}</tool_result>`;
        }
      }
    }
    fullPrompt += "\n\n";
  }

  // 3. 模拟 Assistant 响应开始标签
  fullPrompt += "Assistant: ";

  return fullPrompt;
}

/**
 * 从 Claude 消息中提取所有文本内容（简易版，保留兼容性）
 */
export function extractTextFromMessages(messages: ClaudeMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }
        if (block.type === "tool_use") {
          return `<invoke name="${block.name}">${JSON.stringify(block.input)}</invoke>`;
        }
        if (block.type === "tool_result") {
          return `<tool_result>${block.content}</tool_result>`;
        }
        return "";
      })
      .join("");
  }).join("\n");
}

/**
 * 使用本地 tiktoken 算法计算 token 数量
 */
export async function estimateTokensLocally(
  request: ClaudeRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<TokenCountResult> {
  // 使用增强后的模拟 Prompt 计算输入
  const promptForCounting = extractTextForCounting(request);
  let estimatedTokens = estimateTokensFromText(promptForCounting, request.model);

  // 额外补偿：基础协议开销（通常为 3-10 tokens）
  estimatedTokens += 3;

  // 添加工具定义的 token
  if (request.tools && request.tools.length > 0) {
    const toolsText = JSON.stringify(request.tools);
    const toolsTokens = estimateTokensFromText(toolsText, request.model);
    estimatedTokens += toolsTokens;
    
    await logRequest(requestId, "debug", "Added tool tokens", {
      toolsCount: request.tools.length,
      toolsTextLength: toolsText.length,
      toolsTokens,
    });
  }

  // 应用 token 倍数（防御 NaN/非法配置）
  const multiplier = Number.isFinite(config.tokenMultiplier) && config.tokenMultiplier > 0
    ? config.tokenMultiplier
    : 1.0;
  const rawAdjusted = estimatedTokens * multiplier;
  const adjustedTokens = Math.max(
    1,
    Math.ceil(
      Number.isFinite(rawAdjusted)
        ? rawAdjusted
        : (estimatedTokens || 1),
    ),
  );

  await logRequest(requestId, "debug", "Local token estimation with tiktoken", {
    promptLength: promptForCounting.length,
    estimatedTokens,
    multiplier,
    adjustedTokens,
    model: request.model,
    hasTools: !!(request.tools && request.tools.length > 0),
  });

  return {
    input_tokens: adjustedTokens, // 使用最新官方 API 字段名
    token_count: adjustedTokens, // 保持向后兼容
    tokens: adjustedTokens, // 保持向后兼容
  };
}

/**
 * 主要的 token 计数函数，仅使用本地 tiktoken
 */
export async function countTokens(
  request: ClaudeRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<TokenCountResult> {
  await logRequest(requestId, "debug", "Using local tiktoken for token counting", {
    model: request.model,
    messageCount: request.messages.length,
  });

  // 仅使用本地 tiktoken 计算
  return await estimateTokensLocally(request, config, requestId);
}

/**
 * 仅使用本地方法计算 token（不调用 Claude API）
 */
export async function countTokensLocally(
  request: ClaudeRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<TokenCountResult> {
  return await estimateTokensLocally(request, config, requestId);
}
