import {
  ClaudeContentBlock,
  ClaudeRequest,
  ClaudeToolDefinition,
} from "./types.ts";
import { randomTriggerSignal } from "./signals.ts";

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
- **Output:** Start immediately with the trigger signal "{trigger_signal}", followed by the XML block.
- **Constraint:** The XML must be the **ONLY** content of your response. Correctness is paramount.
**MODE B: CONVERSATION (Only when tools are useless)**
- **Trigger Condition:** If the user is greeting, asking for general advice, or asking a question that tools cannot solve.
- **Behavior:** Respond naturally and helpfully in plain text.
- **Constraint:** Do NOT output any trigger signals or XML tags in this mode.

### 3. Strict Tool Implementation Rules
If you enter **MODE A**, you must adhere to these technical rules:
	
When you decide to call a tool, you MUST output EXACTLY this trigger signal: {trigger_signal}
The trigger signal MUST be output on a completely empty line by itself before any tool calls.
Do NOT add any other text, spaces, or characters before or after {trigger_signal} on that line.
You may provide explanations or reasoning before outputting {trigger_signal}", but once you decide to make a tool call, {trigger_signal} must come first.
You MUST output the trigger signal {trigger_signal} ONLY ONCE per response. Never output multiple trigger signals in a single response.

After outputting the trigger signal, immediately provide your tool calls enclosed in <invoke> XML tags.
    
4.  **XML Structure:**
Your tool calls must be structured EXACTLY as follows. This is the ONLY format you can use, and any deviation will result in failure.
    	
    <antml:format>
    {trigger_signal}
    <invoke name="$TOOL_NAME">
    <parameter name="$PARAM_NAME">$VALUE_OR_JSON_STRING</parameter>
    </invoke>
    </antml:format>
    
5.  IMPORTANT RULES:
  - You may provide explanations or reasoning before deciding to call a tool.
  - Once you decide to call a tool, you must first output the trigger signal {trigger_signal} on a separate line by itself.
  - The trigger signal may only appear once per response and must not be repeated.
  - Tool calls must use the exact XML format below: immediately after the trigger signal, use <invoke> and <parameter> tags.
  - No additional text may be added after the closing </invoke> tag.
  - Parameters must retain punctuation (including hyphen prefixes) exactly as defined.
  - Encode arrays and objects in JSON before placing inside <parameter>.
  - Be concise when not using tools.
  - After invoking the tool,  you will receive the result of the tool call. Therefore,  please wait until you obtain the result from one tool call before invoking the next one 
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
  triggerSignal: string,
): ClaudeContentBlock[] {
  if (typeof content === "string") {
    return [{
      type: "text",
      text: content
        .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
        .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, ""),
    }];
  }

  const result: ClaudeContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text") {
      result.push({
        type: "text",
        text: block.text
          .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
          .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, ""),
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
        text: `[工具调用结果 - ID: ${block.tool_use_id}]\n${toolResult}`,
      });
    } else if (block.type === "tool_use") {
      const params = Object.entries(block.input ?? {})
        .map(([key, value]) => {
          const stringValue = typeof value === "string" ? value : JSON.stringify(value);
          return `<parameter name="${key}">${stringValue}</parameter>`;
        })
        .join("\n");
      result.push({
        type: "text",
        text: `${triggerSignal}\n<invoke name="${block.name}">\n${params}\n</invoke>`,
      });
    }
  }

  return result;
}

export interface EnrichedClaudeRequest {
  request: ClaudeRequest;
  triggerSignal?: string;
}

/**
 * 增强 ClaudeRequest：注入工具定义并处理消息中的工具块
 */
export function enrichClaudeRequest(request: ClaudeRequest): EnrichedClaudeRequest {
  const tools = request.tools ?? [];
  if (!tools.length) {
    // 即使没有工具，我们也可能需要处理历史消息中的文本过滤（防注入）
    // 但为了保持原样，如果没工具就直接返回，历史消息中的 tool_use 理论上不该存在
    return { request };
  }

  const signal = randomTriggerSignal();
  const toolsXml = buildToolsXml(tools);
  const template = DEFAULT_TEMPLATE
    .replaceAll("{trigger_signal}", signal)
    .replace("{tools_list}", toolsXml);

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
    content: normalizeBlocks(msg.content, signal),
  }));

  // 3. 构造新请求（清空 tools，注入 system）
  const enrichedRequest: ClaudeRequest = {
    ...request,
    system: enrichedSystem,
    messages: enrichedMessages,
    tools: undefined, // 清空上游工具定义，因为我们要模拟
  };

  return { request: enrichedRequest, triggerSignal: signal };
}
