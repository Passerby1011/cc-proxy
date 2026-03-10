/**
 * 闁告绻楅鍛存焻閸岀偛甯抽柛?
 *
 * 缂備胶鍠嶇粩瀛樺緞閸曨厽鍊炲☉鎾崇Т閹捇宕¤箛姘煎敶闁汇劌瀚Ο濠傤嚕閸岋妇绀夐梺鎻掓川閺併倗绮甸弽顐ｆ婵☆垪鈧磭纭€闁?
 * - 妫ｅ啯鎯?鐟滅増鎸告晶鐘碘偓鍦仧楠炲洭鏁嶅鍒緀nAI闁靛棔绔竛thropic
 * - 妫ｅ啯鏆?闁哄牜浜濆鐢稿箥閳轰胶娼旈柨娑欘儞emini闁挎稑鐗撻。鈺呮偩濞嗘瑧绀? *
 * 婵炴垵鐗撳▍?濠㈣泛瀚畷妤冩媼椤曗偓閳ь剙鍊块崢銈夋煂瀹ュ拋妲婚梺顐ｆ缁?
 */

import { ClaudeMessage, OpenAIChatMessage } from "../types.ts";
import { anthropicToOpenAIResponsesRequest } from "../openai_compat.ts";
import type { AIRequestOptions, AIResponse, Protocol, StreamChunk } from "./types.ts";

const OPENAI_CHAT_PASSTHROUGH_METADATA_KEY = "_openai_chat_passthrough";
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function parseDataUrlToImage(url: unknown): { media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } | undefined {
  if (typeof url !== "string") return undefined;
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
  if (!match) return undefined;

  const mediaType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return undefined;
  }

  return {
    media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
    data: match[2],
  };
}

/**
 * 闁告绻楅鍛存焻閸岀偛甯抽柛锝冨妽鐢挳宕?
 */
export interface ProtocolAdapter {
  /**
   * 闁哄瀚紓鎾舵嫚闁垮婀村ù?
   *
   * @param messages 婵炴垵鐗婃导鍛村礆濡ゅ嫨鈧?
   * @param options 閻犲洭鏀遍惇浼存焻婢舵劑鈧?
   * @returns JSON 閻庢稒顨堥浣圭▔?
   */
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string;

  /**
   * 闁哄瀚紓鎾舵嫚闁垮婀村?
   *
   * @param apiKey API 閻庨潧妫濋幐?
   * @returns 閻犲洭鏀遍惇鐗堝緞閺夋埈鍤犻悹?
   */
  buildHeaders(apiKey?: string): Record<string, string>;

  /**
   * 閻熸瑱绲鹃悗浠嬫閻愬銈︾€殿喖绻愰幖閿嬫償?
   *
   * @param json 闁告繂绉寸花?JSON 閻庣數顢婇挅?
   * @returns 缂備胶鍠嶇粩鎾儍?AI 闁告繂绉寸花鏌ュ冀閻撳海纭€
   */
  parseResponse(json: unknown): AIResponse;

  /**
   * 閻熸瑱绲鹃悗钘壝规担鍝ョ闁告繂绉寸花鏌ュ锤?
   *
   * @param line SSE 闁轰胶澧楀畵浣烘偘?
   * @returns 婵炵繝绀佺槐锟犲传瀹ュ懐瀹夐柛褎顨愮槐娆愪繆閸屾稓浜柡鍐У绾墎鎲撮敐鍡欌偓浠嬪礆濞嗘帞绠查柛?null闁?
   */
  parseStreamChunk(line: string): StreamChunk | null;

  /**
   * 闁兼儳鍢茶ぐ鍥础韫囨凹鍞撮柛姘Ф琚?   */
  getName(): Protocol;
}

/**
 * OpenAI 闁告绻楅鍛存焻閸岀偛甯抽柛?
 *
 * 妫ｅ啯鎯?鐟滅増鎸告晶鐘碘偓鍦仧楠炲洭鏁嶅鍒緀nAI Chat Completions API
 */
export class OpenAIAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    // 閺夌儐鍓氬畷鎻掆槈閸喍绱栭柡宥囧帶缁憋繝鏁嶅▎鐮絘ude -> OpenAI
    const openaiMessages: OpenAIChatMessage[] = messages.map((msg) => ({
      role: msg.role as "user" | "assistant" | "system",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    }));

    // 妫ｅ啯鏂€ 濠㈣泛瀚幃?system prompt闁挎稒鑹鹃々褔寮?metadata 濞戞搩鍘肩€垫﹢宕?system闁挎稑鑻崹顖滀焊閸℃寰撳ù锝嗙矆鐠愮喎鈽夐崼鐔剁礀闁圭粯甯掗崣鍡涘礆閺夎￥浠堥梺?
    // 闁哄秷顫夊畵?supportsSystemPrompt 闁哄秴娲ょ换鏃堝礃閸愯尙鏆板ù锝堟硶閺?system 閻熸瑦甯熸竟濠冩交濡粯笑 user 閻熸瑦甯熸竟?
    if (options.metadata?.system) {
      const supportsSystemPrompt = options.metadata?.supportsSystemPrompt !== false;
      openaiMessages.unshift({
        role: supportsSystemPrompt ? "system" : "user",
        content: options.metadata.system as string,
      });
    }

    const requestBody: any = {
      model: options.metadata?.model || "gpt-4",
      messages: openaiMessages,
      stream: options.stream ?? false,
      max_tokens: options.max_tokens,
      temperature: options.temperature,
      top_p: options.top_p,
    };

    // 婵烇綀顕ф慨鐐差啅閵夈儱寰旈悗瑙勭煯缁?
    if (options.tools && (options.tools as unknown[]).length > 0) {
      requestBody.tools = options.tools;
    }
    if (options.tool_choice !== undefined) {
      requestBody.tool_choice = options.tool_choice;
    }

    const passthrough = options.metadata?.[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY];
    if (passthrough && typeof passthrough === "object") {
      for (const [key, value] of Object.entries(passthrough as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (requestBody[key] !== undefined) continue;
        requestBody[key] = value;
      }
    }

    return JSON.stringify(requestBody);
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    return headers;
  }

  parseResponse(json: unknown): AIResponse {
    const data = json as any;

    // OpenAI 闁告繂绉寸花鏌ュ冀閻撳海纭€
    const message = data.choices?.[0]?.message;
    const content = message?.content || "";

    return {
      content,
      usage: data.usage
        ? {
          input_tokens: data.usage.prompt_tokens || 0,
          output_tokens: data.usage.completion_tokens || 0,
        }
        : undefined,
      finish_reason: data.choices?.[0]?.finish_reason,
      raw: data,
    };
  }

  parseStreamChunk(line: string): StreamChunk | null {
    const trimmed = line.trim();

    // OpenAI SSE 闁哄秶鍘х槐锟犳晬濮濈€塼a: {json}
    if (!trimmed.startsWith("data: ")) {
      return null;
    }

    const dataStr = trimmed.slice(6);

    // 婵炵繝鑳剁划銊╁级閻斿摜鍨奸悹?
    if (dataStr === "[DONE]") {
      return { type: "done", data: null };
    }

    try {
      const data = JSON.parse(dataStr);
      const delta = data.choices?.[0]?.delta;
      const text = delta?.content || "";

      return {
        text,
        type: "content",
        data,
      };
    } catch {
      return null;
    }
  }

  getName(): Protocol {
    return "openai";
  }
}

/**
 * OpenAI Responses 閸楀繗顔呴柅鍌炲帳閸? */
export class OpenAIResponsesAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    const request = anthropicToOpenAIResponsesRequest(
      {
        model: (options.metadata?.model as string) || "gpt-4.1",
        max_tokens: options.max_tokens || 4096,
        messages,
        system: options.metadata?.system as string | undefined,
        stream: options.stream ?? false,
        temperature: options.temperature,
        top_p: options.top_p,
        metadata: options.metadata,
        tools: options.tools as any[] | undefined,
        tool_choice: options.tool_choice,
      } as any,
      (options.metadata?.model as string) || "gpt-4.1",
      options.metadata?.supportsSystemPrompt !== false,
    );

    return JSON.stringify(request);
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    return headers;
  }

  parseResponse(json: unknown): AIResponse {
    const data = json as any;
    const blocks: any[] = [];
    let textContent = "";

    for (const item of data.output ?? []) {
      if (item?.type === "message") {
        for (const part of item.content ?? []) {
          if (part?.type === "output_text") {
            const text = part.text || "";
            textContent += text;
            if (text) {
              blocks.push({ type: "text", text });
            }
          } else if (part?.type === "reasoning") {
            const reasoningText = typeof part.summary === "string"
              ? part.summary
              : (typeof part.text === "string" ? part.text : "");
            if (reasoningText) {
              blocks.push({
                type: "thinking",
                thinking: reasoningText,
              });
            }
          } else if (part?.type === "output_image") {
            const parsed = parseDataUrlToImage(part.image_url ?? part.url);
            if (parsed) {
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: parsed.media_type,
                  data: parsed.data,
                },
              });
            }
          }
        }
      } else if (item?.type === "function_call") {
        let input = {};
        try {
          input = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
          name: item.name || "function",
          input,
        });
      } else if (item?.type === "web_search_call") {
        const id = item.id || `web_${crypto.randomUUID()}`;
        blocks.push({
          type: "server_tool_use",
          id,
          name: "web_search",
          input: {
            query: item.query,
          },
        });
        if (Array.isArray(item.results)) {
          blocks.push({
            type: "web_search_tool_result",
            tool_use_id: id,
            content: item.results,
          });
        }
      } else if (item?.type === "web_fetch_call") {
        const id = item.id || `fetch_${crypto.randomUUID()}`;
        blocks.push({
          type: "server_tool_use",
          id,
          name: "web_fetch",
          input: {
            url: item.url,
          },
        });
        if (Array.isArray(item.content)) {
          blocks.push({
            type: "web_fetch_tool_result",
            tool_use_id: id,
            content: item.content,
          });
        }
      }
    }

    return {
      content: blocks.length > 0 ? blocks : textContent,
      usage: data.usage
        ? {
          input_tokens: data.usage.input_tokens || 0,
          output_tokens: data.usage.output_tokens || 0,
        }
        : undefined,
      finish_reason: data.status,
      raw: data,
    };
  }

  parseStreamChunk(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (trimmed.startsWith("event: ")) {
      return { type: trimmed.slice(7), data: null };
    }
    if (!trimmed.startsWith("data: ")) {
      return null;
    }

    try {
      const data = JSON.parse(trimmed.slice(6));
      if (data.type === "response.output_text.delta") {
        return {
          text: data.delta || "",
          type: "content",
          data,
        };
      }
      if (data.type === "response.reasoning_summary_text.delta") {
        return {
          text: data.delta || "",
          type: "content",
          data,
        };
      }
      if (data.type === "response.completed") {
        return { type: "done", data };
      }
      return { type: data.type, data };
    } catch {
      return null;
    }
  }

  getName(): Protocol {
    return "openai-responses";
  }
}
/**
 * Anthropic 闁告绻楅鍛存焻閸岀偛甯抽柛?
 *
 * 妫ｅ啯鎯?鐟滅増鎸告晶鐘碘偓鍦仧楠炲洭鏁嶅▎鐨€thropic Messages API
 */
export class AnthropicAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    const requestBody: any = {
      model: options.metadata?.model || "claude-3-5-sonnet-20241022",
      messages: messages,
      stream: options.stream ?? false,
      max_tokens: options.max_tokens || 4096,
    };

    // 闁告瑯浜濋崸濠囧礉閻樿櫕绠掗柛濠呭亹濞堟垿宕ｉ鐐╁亾婢跺﹦鎽熸繛?
    if (options.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options.top_p !== undefined) {
      requestBody.top_p = options.top_p;
    }
    if (options.metadata?.system) {
      requestBody.system = options.metadata.system;
    }

    // 婵烇綀顕ф慨鐐差啅閵夈儱寰旈悗瑙勭煯缁?
    if (options.tools && (options.tools as unknown[]).length > 0) {
      requestBody.tools = options.tools;
    }
    if (options.tool_choice !== undefined) {
      requestBody.tool_choice = options.tool_choice;
    }

    // 缂佸顭峰▍?undefined 閻庢稒顨嗛宀勬晬閸繂钃熼梺鎻掔С缁绘岸姊介埡瀣
    Object.keys(requestBody).forEach((key) => {
      if (requestBody[key as keyof typeof requestBody] === undefined) {
        delete requestBody[key as keyof typeof requestBody];
      }
    });

    return JSON.stringify(requestBody);
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    return headers;
  }

  parseResponse(json: unknown): AIResponse {
    const data = json as any;

    // Anthropic 闁告繂绉寸花鏌ュ冀閻撳海纭€
    const content = data.content;
    let textContent = "";

    if (Array.isArray(content)) {
      const textBlocks = content.filter((block: any) => block.type === "text");
      textContent = textBlocks.map((block: any) => block.text).join("\n");
    }

    return {
      content: textContent || content,
      usage: data.usage
        ? {
          input_tokens: data.usage.input_tokens || 0,
          output_tokens: data.usage.output_tokens || 0,
        }
        : undefined,
      finish_reason: data.stop_reason,
      raw: data,
    };
  }

  parseStreamChunk(line: string): StreamChunk | null {
    const trimmed = line.trim();

    // Anthropic SSE 闁哄秶鍘х槐锟犳晬濮濈劑ent: {type}\ndata: {json}
    if (trimmed.startsWith("event: ")) {
      // 濞存粌顑勫▎銏㈢尵鐠囪尙鈧鎮板畝瀣閻犲搫鐤囩换鍐晬閸垺鏆犲☉鎾愁儎缁斿鎮板畝鈧▓?data 濠㈣泛瀚幃濠囨晬?
      return { type: trimmed.slice(7), data: null };
    }

    if (!trimmed.startsWith("data: ")) {
      return null;
    }

    const dataStr = trimmed.slice(6);

    try {
      const data = JSON.parse(dataStr);

      // 濠㈣泛瀚幃?content_block_delta 濞存粌顑勫▎?
      if (data.type === "content_block_delta") {
        const delta = data.delta;
        if (delta?.type === "text_delta") {
          return {
            text: delta.text || "",
            type: "content",
            data,
          };
        }
      }

      // 濠㈣泛瀚幃?message_stop 濞存粌顑勫▎?
      if (data.type === "message_stop") {
        return { type: "done", data };
      }

      return { type: data.type, data };
    } catch {
      return null;
    }
  }

  getName(): Protocol {
    return "anthropic";
  }
}

/**
 * Gemini 闁告绻楅鍛存焻閸岀偛甯抽柛锝庣厜缁辨瑦锛愰崟顓熸畬闁?
 *
 * 妫ｅ啯鏆?闁哄牜浜濆鐢碘偓鍦仧楠炲洭鏁嶅▎绔渙gle Gemini API
 */
export class GeminiAdapter implements ProtocolAdapter {
  buildRequestBody(messages: ClaudeMessage[], options: AIRequestOptions): string {
    // 妫ｅ啯鏆?闁哄牜浜濆鐢碘偓鍦仧楠炲洭鏁?
    // 1. 閺夌儐鍓氬畷鎻掆槈閸喍绱栭柡宥囧帶缁扁剝绋?Gemini 闁哄秶鍘х槐?
    // 2. 濠㈣泛瀚幃?Gemini 闁绘顫夊﹢渚€鎯冮崟顐㈡闁?
    throw new Error("GeminiAdapter not implemented yet");
  }

  buildHeaders(apiKey?: string): Record<string, string> {
    // 妫ｅ啯鏆?闁哄牜浜濆鐢碘偓鍦仧楠炲洭鏁?
    // 1. Gemini API 閻庨潧妫濋幐婊堝冀閻撳海纭€闁挎稑鐗嗚ぐ鏌ユ嚄閼恒儲笑 URL 闁告瑥鍊归弳鐔兼晬?
    // 2. Gemini 闁绘顫夊﹢渚€鎯冮崟顕呭殲婵懓鍊搁妵?
    throw new Error("GeminiAdapter not implemented yet");
  }

  parseResponse(json: unknown): AIResponse {
    // 妫ｅ啯鏆?闁哄牜浜濆鐢碘偓鍦仧楠炲洭鏁?
    // 1. 閻熸瑱绲鹃悗?Gemini 闁告繂绉寸花鏌ュ冀閻撳海纭€
    // 2. 閺夌儐鍓氬畷鍙夌▔閾忓湱鍩犲☉鎾亾闁?AIResponse
    throw new Error("GeminiAdapter not implemented yet");
  }

  parseStreamChunk(line: string): StreamChunk | null {
    // 妫ｅ啯鏆?闁哄牜浜濆鐢碘偓鍦仧楠炲洭鏁?
    // 1. 閻熸瑱绲鹃悗?Gemini SSE 闁哄秶鍘х槐?
    // 2. 闁圭粯鍔曡ぐ鍥棘閸ャ劍鎷遍柛鎰噹椤?
    throw new Error("GeminiAdapter not implemented yet");
  }

  getName(): Protocol {
    return "gemini";
  }
}

/**
 * 闁告绻楅鍛存焻閸岀偛甯抽柛锝冨妼娴兼劙宕?
 */
export class ProtocolAdapterFactory {
  private static adapters: Map<Protocol, ProtocolAdapter> = new Map([
    ["openai", new OpenAIAdapter()],
    ["openai-responses", new OpenAIResponsesAdapter()],
    ["anthropic", new AnthropicAdapter()],
    // Gemini 闂侇偄鍊块崢銈夊闯閵婏附鐣☉鎾崇У閺佺偤宕樺畝瀣缂佹稑顦欢鐔衡偓鍦仧楠?
    // ["gemini", new GeminiAdapter()],
  ]);

  /**
   * 闁告帗绋戠紓鎾诲础韫囨凹鍞撮梺顐㈠€块崢銈夊闯?
   *
   * @param protocol 闁告绻楅鍛尵鐠囪尙鈧?
   * @returns 闁告绻楅鍛存焻閸岀偛甯抽柛锝冨妼閻ゅ嫭绗?
   */
  static create(protocol: Protocol): ProtocolAdapter {
    const adapter = this.adapters.get(protocol);

    if (!adapter) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    return adapter;
  }

  /**
   * 婵炲鍔岄崬浠嬪棘閹殿喗鐣遍柛妤€绻楅鍛存焻閸岀偛甯抽柛?
   *
   * @param protocol 闁告绻楅鍛尵鐠囪尙鈧?
   * @param adapter 闂侇偄鍊块崢銈夊闯閵娿儳鏉藉〒?
   */
  static register(protocol: Protocol, adapter: ProtocolAdapter): void {
    this.adapters.set(protocol, adapter);
  }

  /**
   * 闁兼儳鍢茶ぐ鍥箥閳ь剟寮垫径瀣殰闁归晲鑳跺▓鎴﹀础韫囨凹鍞?   */
  static getSupportedProtocols(): Protocol[] {
    return Array.from(this.adapters.keys());
  }
}
