import {
  ClaudeContentBlock,
  ClaudeRequest,
  ClaudeToolDefinition,
} from "./types.ts";
import { ToolCallDelimiter } from "./signals.ts";

const DEFAULT_TEMPLATE = `
You are an intelligent assistant equipped with specific tools. Your behavior changes based on the user's request type.
In this environment you have access to a set of tools you can use to answer the user's question.  
When you need to use a tool, you MUST strictly follow the format below.

### 1. Available Tools
<antml:tools>
{tools_list}
</antml:tools>

### 2. Response Strategy (Execute vs. Chat)
You must assess the user request and choose ONE of the following modes immediately:
**MODE A: TOOL EXECUTION (Prioritize this for functionality)**
- **Trigger Condition:** If the request requires data fetching, file manipulation, calculation, or any action supported by your tools.
- **Behavior:** **BE SILENT AND ACT.** Do NOT explain what you are going to do. Do NOT say "I will check that for you."
- **Output:** Start immediately with the tool call block using the exact delimiters provided.
- **Constraint:** The tool call block must be the **ONLY** content of your response if you enter this mode. Correctness is paramount.
**MODE B: CONVERSATION (Only when tools are useless)**
- **Trigger Condition:** If the user is greeting, asking for general advice, or asking a question that tools cannot solve.
- **Behavior:** Respond naturally and helpfully in plain text.
- **Constraint:** Do NOT output any tool call delimiters or formatting in this mode.

### 3. How to call tools
When you need to call a tool, you MUST use this EXACT format at the END of your response:

{TC_START}
{NAME_START}function_name{NAME_END}
{ARGS_START}{"param": "value"}{ARGS_END}
{TC_END}

### 4. Strict Tool Implementation Rules
1. Tool calls MUST be at the END of your response.
2. Copy the delimiters EXACTLY as shown below.
3. **Arguments must be valid JSON (PERFECT SYNTAX IS MANDATORY)**
4. One tool per block.
5. You may provide explanations or reasoning BEFORE the tool call block.
6. Once the tool call block ({TC_START}) starts, no other text may be added until the closing delimiter ({TC_END}).
7. After the closing delimiter ({TC_END}), NO additional text may be added.
8. Parameters must retain punctuation (including hyphen prefixes) exactly as defined.
9. Encode arrays and objects in JSON before placing inside parameters.
10. Be concise when not using tools.
11. After invoking the tool, you will receive the result of the tool call. Wait until you obtain the result from one tool call before invoking the next one.
12. Special Conditions: If you plan to use editing tools to edit a **long text** in the future, please perform the editing in multiple commands, with each command not exceeding 2500 tokens.

### 5. Delimiters to use for this session:
- TC_START: {TC_START}
- TC_END: {TC_END}
- NAME_START: {NAME_START}
- NAME_END: {NAME_END}
- ARGS_START: {ARGS_START}
- ARGS_END: {ARGS_END}
`;

// 思考模式相关的常量定义
const THINKING_START_TAG = "<thinking>";
const THINKING_END_TAG = "</thinking>";

function escapeText(text: string): string {
  return text.replace(/</g, "<").replace(/>/g, ">");
}

function buildToolsXml(tools: ClaudeToolDefinition[]): string {
  if (!tools.length) return "<function_list>None</function_list>";
  const items = tools.map((tool, index) => {
    const schema = tool.input_schema ?? {};
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];
    const parameters = Object.entries(props).map(([name, info]) => {
      const paramInfo = info as Record<string, unknown>;
      const type = paramInfo.type ?? "any";
      const desc = paramInfo.description ?? "";
      const requiredFlag = required.includes(name);
      const enumValues = paramInfo.enum ? JSON.stringify(paramInfo.enum) : undefined;
      return [
        `    <parameter name="${name}">`,
        `      <type>${type}</type>`,
        `      <required>${requiredFlag}</required>`,
        desc ? `      <description>${escapeText(String(desc))}</description>` : "",
        enumValues ? `      <enum>${escapeText(enumValues)}</enum>` : "",
        "    </parameter>",
      ].filter(Boolean).join("\n");
    }).join("\n");

    const requiredXml = required.length
      ? required.map((r) => `    <param>${r}</param>`).join("\n")
      : "    <param>None</param>";

    return [
      `  <tool id="${index + 1}">`,
      `    <name>${tool.name}</name>`,
      `    <description>${escapeText(tool.description ?? "None")}</description>`,
      "    <required>",
      requiredXml,
      "    </required>",
      parameters ? `    <parameters>\n${parameters}\n    </parameters>` : "    <parameters>None</parameters>",
      "  </tool>",
    ].join("\n");
  }).join("\n");
  return `<function_list>\n${items}\n</function_list>`;
}

/**
 * 将工具消息块（tool_use, tool_result）和思考块转换为文本格式，同时保留图片块
 */
function normalizeBlocks(
  content: string | ClaudeContentBlock[],
  delimiter: ToolCallDelimiter,
): ClaudeContentBlock[] {
  const m = delimiter.getMarkers();
  if (typeof content === "string") {
    return [{
      type: "text",
      text: content,
    }];
  }

  const result: ClaudeContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text") {
      result.push({
        type: "text",
        text: block.text,
      });
    } else if (block.type === "image") {
      result.push(block);
    } else if (block.type === "thinking") {
      result.push({
        type: "text",
        text: `${THINKING_START_TAG}${block.thinking}${THINKING_END_TAG}`,
      });
    } else if (block.type === "tool_result") {
      let toolResult: any = block.content ?? "";
      if (typeof toolResult !== "string") {
        if (Array.isArray(toolResult)) {
          toolResult = toolResult
            .filter((item: any) => item && item.type === "text")
            .map((item: any) => item.text || "")
            .join("\n");
        } else if (typeof toolResult === "object" && toolResult !== null) {
          toolResult = JSON.stringify(toolResult, null, 2);
        }
      }
      result.push({
        type: "text",
        text: `${m.RESULT_START}[ID: ${block.tool_use_id}]\n${toolResult}${m.RESULT_END}`,
      });
    } else if (block.type === "tool_use") {
      const args = JSON.stringify(block.input ?? {});
      result.push({
        type: "text",
        text: `${m.TC_START}\n${m.NAME_START}${block.name}${m.NAME_END}\n${m.ARGS_START}${args}${m.ARGS_END}\n${m.TC_END}`,
      });
    }
  }

  return result;
}

export interface EnrichedClaudeRequest {
  request: ClaudeRequest;
  delimiter?: ToolCallDelimiter;
}

/**
 * 增强 ClaudeRequest：注入工具定义并处理消息中的工具块
 */
export function enrichClaudeRequest(request: ClaudeRequest): EnrichedClaudeRequest {
  const tools = request.tools ?? [];
  if (!tools.length) {
    return { request };
  }

  const delimiter = new ToolCallDelimiter();
  const markers = delimiter.getMarkers();
  const toolsXml = buildToolsXml(tools);
  
  let template = DEFAULT_TEMPLATE
    .replace("{tools_list}", toolsXml);

  // 替换所有标记占位符
  for (const [key, value] of Object.entries(markers)) {
    template = template.replaceAll(`{${key}}`, String(value));
  }

  // 1. 处理 System Prompt
  let systemContent = "";
  if (request.system) {
    if (typeof request.system === "string") {
      systemContent = request.system;
    } else {
      systemContent = request.system.map(b => b.type === "text" ? b.text : "").join("\n");
    }
  }
  const enrichedSystem = `${template}\n\n${systemContent}`.trim();

  // 2. 处理 Messages
  const enrichedMessages = request.messages.map((msg) => ({
    ...msg,
    content: normalizeBlocks(msg.content, delimiter),
  }));

  // 3. 构造新请求（清空 tools，注入 system）
  const enrichedRequest: ClaudeRequest = {
    ...request,
    system: enrichedSystem,
    messages: enrichedMessages,
    tools: undefined, // 清空上游工具定义，因为我们要模拟
  };

  return { request: enrichedRequest, delimiter };
}

