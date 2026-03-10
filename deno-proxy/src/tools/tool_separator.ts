/**
 * 工具分离器
 *
 * 将工具定义分为两类：
 * 1. Web 工具：需要拦截并自动执行（Web Search, Web Fetch）
 * 2. 原生工具：传递给上游 API 处理
 */

import type { ClaudeToolDefinition } from "../types.ts";
import { isAnyWebFetchTool, isAnyWebSearchTool } from "./types.ts";

/**
 * 分离后的工具
 */
export interface SeparatedTools {
  /** Web 工具（需要拦截） */
  webTools: ClaudeToolDefinition[];
  /** 原生工具（传递给上游） */
  nativeTools: ClaudeToolDefinition[];
}

/**
 * 工具分离器
 */
export class ToolSeparator {
  /**
   * 分离工具定义
   *
   * @param tools 工具定义数组
   * @returns 分离后的工具
   */
  static separate(tools: ClaudeToolDefinition[] | undefined): SeparatedTools {
    if (!tools || tools.length === 0) {
      return {
        webTools: [],
        nativeTools: [],
      };
    }

    const webTools: ClaudeToolDefinition[] = [];
    const nativeTools: ClaudeToolDefinition[] = [];

    for (const tool of tools) {
      if (this.isWebTool(tool)) {
        webTools.push(tool);
      } else {
        nativeTools.push(tool);
      }
    }

    return { webTools, nativeTools };
  }

  /**
   * 判断是否为 Web 工具
   *
   * 通过 type 字段识别（Anthropic Server Tools 格式）
   *
   * @param tool 工具定义
   * @returns 是否为 Web 工具
   */
  static isWebTool(tool: any): boolean {
    if (!tool || typeof tool !== "object") {
      return false;
    }
    return isAnyWebSearchTool(tool) || isAnyWebFetchTool(tool);
  }

  /**
   * 检查是否包含 Web 工具
   *
   * @param tools 工具定义数组
   * @returns 是否包含 Web 工具
   */
  static hasWebTools(tools: ClaudeToolDefinition[] | undefined): boolean {
    if (!tools || tools.length === 0) {
      return false;
    }

    return tools.some(tool => this.isWebTool(tool));
  }

  /**
   * 检查是否包含原生工具
   *
   * @param tools 工具定义数组
   * @returns 是否包含原生工具
   */
  static hasNativeTools(tools: ClaudeToolDefinition[] | undefined): boolean {
    if (!tools || tools.length === 0) {
      return false;
    }

    return tools.some(tool => !this.isWebTool(tool));
  }
}
