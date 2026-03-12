import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MessageFormatConverter,
  OPENAI_CHAT_PASSTHROUGH_METADATA_KEY,
} from "./tools/message_format_converter.ts";

Deno.test("openAIToAnthropic converts image blocks and keeps OpenAI passthrough params", () => {
  const converted = MessageFormatConverter.openAIToAnthropic({
    model: "gpt-test",
    max_completion_tokens: 321,
    stop: ["END"],
    presence_penalty: 0.2,
    metadata: { source: "unit-test" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
        },
      ],
    }],
  } as any);

  assertEquals(converted.max_tokens, 321);
  assertEquals((converted as any).stop_sequences, ["END"]);

  const contentBlocks = converted.messages[0].content as any[];
  assertEquals(contentBlocks[0].type, "text");
  assertEquals(contentBlocks[1].type, "image");

  const passthrough = (converted.metadata as any)[OPENAI_CHAT_PASSTHROUGH_METADATA_KEY];
  assertEquals(passthrough.presence_penalty, 0.2);
  assertEquals(passthrough.metadata, { source: "unit-test" });
});

Deno.test("anthropicToOpenAI restores multimodal content, stop and passthrough params", () => {
  const converted = MessageFormatConverter.anthropicToOpenAI({
    model: "claude-test",
    max_tokens: 256,
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inner" },
        { type: "text", text: "answer" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "BBBB",
          },
        },
      ],
    }],
    metadata: {
      [OPENAI_CHAT_PASSTHROUGH_METADATA_KEY]: {
        presence_penalty: 0.7,
        user: "user-1",
      },
    },
    stop_sequences: ["STOP"],
  } as any);

  assertEquals((converted as any).presence_penalty, 0.7);
  assertEquals((converted as any).user, "user-1");
  assertEquals((converted as any).stop, ["STOP"]);

  const assistant = converted.messages[0];
  const content = assistant.content as any[];
  assertEquals(content[0].type, "text");
  assertEquals(content[0].text, "<thinking>inner</thinking>");
  assertEquals(content[2].type, "image_url");
  assertEquals(content[2].image_url.url, "data:image/png;base64,BBBB");
});

Deno.test("openAIToAnthropic drops empty assistant text when tool_calls present", () => {
  const converted = MessageFormatConverter.openAIToAnthropic({
    model: "gpt-test",
    max_completion_tokens: 128,
    messages: [{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "add_numbers",
          arguments: "{\"a\":1,\"b\":2}",
        },
      }],
    }],
  } as any);

  const contentBlocks = converted.messages[0].content as any[];
  assertEquals(contentBlocks.length, 1);
  assertEquals(contentBlocks[0].type, "tool_use");
  assertEquals(contentBlocks[0].name, "add_numbers");
});
