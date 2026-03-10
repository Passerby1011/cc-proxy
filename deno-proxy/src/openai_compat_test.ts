import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  anthropicToOpenAIChatResponse,
  anthropicToOpenAIResponsesResponse,
  openAIResponsesToAnthropic,
} from "./openai_compat.ts";

Deno.test("openAIResponsesToAnthropic converts basic input and tools", () => {
  const request = openAIResponsesToAnthropic({
    model: "gpt-4.1",
    input: [{ type: "message", role: "user", content: "hello" }],
    tools: [{
      type: "function",
      name: "get_weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    }],
  });

  assertEquals(request.model, "gpt-4.1");
  assertEquals(request.messages, [{ role: "user", content: "hello" }]);
  assertEquals(request.tools?.[0].name, "get_weather");
});

Deno.test("openAIResponsesToAnthropic converts OpenAI web search tool", () => {
  const request = openAIResponsesToAnthropic({
    model: "gpt-4.1",
    input: [{ type: "message", role: "user", content: "search latest news" }],
    tools: [{
      type: "web_search_preview",
      allowed_domains: ["openai.com"],
    } as any],
  });

  assertEquals((request.tools?.[0] as any).type, "web_search_20250305");
  assertEquals((request.tools?.[0] as any).name, "web_search");
  assertEquals((request.tools?.[0] as any).allowed_domains, ["openai.com"]);
});

Deno.test("openAIResponsesToAnthropic converts image and reasoning content", () => {
  const request = openAIResponsesToAnthropic({
    model: "gpt-4.1",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    }, {
      type: "message",
      role: "assistant",
      content: [{ type: "reasoning", summary: "thinking content" }],
    }],
  } as any);

  const userBlocks = request.messages[0].content as any[];
  assertEquals(userBlocks[0].type, "text");
  assertEquals(userBlocks[1].type, "image");

  const assistantBlocks = request.messages[1].content as any[];
  assertEquals(assistantBlocks[0].type, "thinking");
  assertEquals(assistantBlocks[0].thinking, "thinking content");
});

Deno.test("openAIResponsesToAnthropic preserves web_search_call history items", () => {
  const request = openAIResponsesToAnthropic({
    model: "gpt-4.1",
    input: [{
      type: "web_search_call",
      id: "ws_1",
      query: "OpenAI news",
      results: [{ url: "https://openai.com", title: "OpenAI", encrypted_content: "abc" }],
    } as any],
  } as any);

  const assistant = request.messages[0].content as any[];
  assertEquals(assistant[0].type, "server_tool_use");
  assertEquals(assistant[0].name, "web_search");
  assertEquals(assistant[0].input.query, "OpenAI news");

  const toolResultMessage = request.messages[1].content as any[];
  assertEquals(toolResultMessage[0].type, "web_search_tool_result");
  assertEquals(toolResultMessage[0].tool_use_id, "ws_1");
});

Deno.test("anthropicToOpenAIChatResponse converts tool_use blocks", () => {
  const response = anthropicToOpenAIChatResponse({
    id: "msg_1",
    model: "claude-test",
    content: [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "tool_1", name: "get_weather", input: { city: "Tokyo" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 2 },
  });

  assertEquals((response.choices as any[])[0].message.role, "assistant");
  assertEquals((response.choices as any[])[0].message.tool_calls[0].function.name, "get_weather");
  assertEquals((response.choices as any[])[0].finish_reason, "tool_calls");
});

Deno.test("anthropicToOpenAIResponsesResponse converts text blocks", () => {
  const response = anthropicToOpenAIResponsesResponse({
    id: "msg_2",
    model: "claude-test",
    content: [{ type: "text", text: "hello world" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4 },
  });

  assertEquals(response.object, "response");
  assertEquals((response.output as any[])[0].type, "message");
  assertEquals((response.output as any[])[0].content[0].text, "hello world");
});

Deno.test("anthropicToOpenAIResponsesResponse converts web search blocks", () => {
  const response = anthropicToOpenAIResponsesResponse({
    id: "msg_3",
    model: "claude-test",
    content: [
      {
        type: "server_tool_use",
        id: "srvtool_1",
        name: "web_search",
        input: { query: "OpenAI" },
      } as any,
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtool_1",
        content: [{ url: "https://openai.com", title: "OpenAI", encrypted_content: "abc" }],
      } as any,
    ],
    stop_reason: "end_turn",
  });

  assertEquals((response.output as any[])[0].type, "web_search_call");
  assertEquals((response.output as any[])[0].query, "OpenAI");
  assertEquals((response.output as any[])[0].results[0].url, "https://openai.com");
});

Deno.test("anthropicToOpenAIResponsesResponse converts thinking and image blocks", () => {
  const response = anthropicToOpenAIResponsesResponse({
    id: "msg_4",
    model: "claude-test",
    content: [
      { type: "thinking", thinking: "inner-thought" },
      { type: "text", text: "done" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "BBBB",
        },
      } as any,
    ],
    stop_reason: "end_turn",
  });

  const output = response.output as any[];
  assertEquals(output[0].type, "message");
  assertEquals(output[0].content[0].type, "output_text");
  assertEquals(output[0].content[0].text, "<thinking>inner-thought</thinking>");
  assertEquals(output[0].content[2].type, "output_image");
});
