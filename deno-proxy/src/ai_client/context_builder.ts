/**
 * 上下文构建器
 *
 * 统一构建对话历史上下文的逻辑，消除各处手动构建消息列表的重复代码。
 */

import { ClaudeMessage, ClaudeRole } from "../types.ts";

/**
 * 上下文构建器类
 */
export class ContextBuilder {
  /**
   * 追加用户消息
   *
   * @param messages 现有消息列表
   * @param content 用户消息内容
   * @returns 新的消息列表
   */
  static appendUserMessage(
    messages: ClaudeMessage[],
    content: string | ClaudeMessage["content"],
  ): ClaudeMessage[] {
    return [
      ...messages,
      {
        role: "user" as ClaudeRole,
        content,
      },
    ];
  }

  /**
   * 追加助手消息
   *
   * @param messages 现有消息列表
   * @param content 助手消息内容
   * @returns 新的消息列表
   */
  static appendAssistantMessage(
    messages: ClaudeMessage[],
    content: string | ClaudeMessage["content"],
  ): ClaudeMessage[] {
    return [
      ...messages,
      {
        role: "assistant" as ClaudeRole,
        content,
      },
    ];
  }

  /**
   * 构建重试上下文
   *
   * 用于工具调用失败后的重试，添加失败的输出和修正提示。
   *
   * @param originalMessages 原始消息列表
   * @param failedContent 失败的输出内容
   * @param priorText 失败前的文本（可选）
   * @param correctionPrompt 修正提示
   * @returns 新的消息列表
   */
  static buildRetryContext(
    originalMessages: ClaudeMessage[],
    failedContent: string,
    priorText: string,
    correctionPrompt: string,
  ): ClaudeMessage[] {
    // 1. 添加失败的助手消息
    const messagesWithFailed = ContextBuilder.appendAssistantMessage(
      originalMessages,
      priorText + failedContent,
    );

    // 2. 添加用户的修正提示
    return ContextBuilder.appendUserMessage(messagesWithFailed, correctionPrompt);
  }

  /**
   * 构建分析上下文
   *
   * 用于内部辅助 AI 请求（如搜索词生成、链接选择等），添加分析提示。
   *
   * @param originalMessages 原始消息列表
   * @param analysisPrompt 分析提示
   * @returns 新的消息列表
   */
  static buildAnalysisContext(
    originalMessages: ClaudeMessage[],
    analysisPrompt: string,
  ): ClaudeMessage[] {
    return ContextBuilder.appendUserMessage(originalMessages, analysisPrompt);
  }

  /**
   * 构建深入浏览上下文
   *
   * 用于智能搜索模式的深入浏览，添加初步分析和深入浏览内容。
   *
   * @param originalMessages 原始消息列表
   * @param initialAnalysis 初步分析内容
   * @param deepBrowseContent 深入浏览内容
   * @param finalPrompt 最终分析提示
   * @returns 新的消息列表
   */
  static buildDeepBrowseContext(
    originalMessages: ClaudeMessage[],
    initialAnalysis: string,
    deepBrowseContent: string,
    finalPrompt: string,
  ): ClaudeMessage[] {
    // 1. 添加初步分析（作为助手消息）
    const messagesWithInitial = ContextBuilder.appendAssistantMessage(
      originalMessages,
      initialAnalysis,
    );

    // 2. 添加深入浏览内容和最终提示（作为用户消息）
    return ContextBuilder.appendUserMessage(
      messagesWithInitial,
      `${deepBrowseContent}\n\n${finalPrompt}`,
    );
  }

  /**
   * 克隆消息列表（深拷贝）
   *
   * @param messages 消息列表
   * @returns 克隆的消息列表
   */
  static cloneMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : JSON.parse(JSON.stringify(msg.content)),
    }));
  }

  /**
   * 合并消息列表
   *
   * 将多个消息列表合并为一个，自动处理角色冲突。
   *
   * @param messageLists 多个消息列表
   * @returns 合并后的消息列表
   */
  static mergeMessages(...messageLists: ClaudeMessage[][]): ClaudeMessage[] {
    const merged: ClaudeMessage[] = [];

    for (const messages of messageLists) {
      for (const msg of messages) {
        // 检查是否与上一条消息角色相同
        const lastMsg = merged[merged.length - 1];

        if (lastMsg && lastMsg.role === msg.role) {
          // 合并相同角色的消息
          if (typeof lastMsg.content === "string" && typeof msg.content === "string") {
            lastMsg.content = `${lastMsg.content}\n\n${msg.content}`;
          } else {
            // 复杂内容类型，直接追加新消息
            merged.push(msg);
          }
        } else {
          merged.push(msg);
        }
      }
    }

    return merged;
  }

  /**
   * 截断消息列表（保留最近的 N 条消息）
   *
   * @param messages 消息列表
   * @param maxMessages 最大消息数量
   * @returns 截断后的消息列表
   */
  static truncateMessages(
    messages: ClaudeMessage[],
    maxMessages: number,
  ): ClaudeMessage[] {
    if (messages.length <= maxMessages) {
      return messages;
    }

    return messages.slice(messages.length - maxMessages);
  }

  /**
   * 计算消息列表的字符数（粗略估算）
   *
   * @param messages 消息列表
   * @returns 总字符数
   */
  static estimateMessageLength(messages: ClaudeMessage[]): number {
    let totalLength = 0;

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        totalLength += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && "text" in block) {
            totalLength += block.text.length;
          }
        }
      }
    }

    return totalLength;
  }
}
