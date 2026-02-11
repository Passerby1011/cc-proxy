import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ToolifyParser } from "./parser.ts";
import { ToolCallDelimiter } from "./signals.ts";

Deno.test("ToolifyParser - XML format (old) should be treated as text", () => {
  const delimiter = new ToolCallDelimiter();
  const parser = new ToolifyParser(delimiter);
  
  const input = `<invoke name="test"><parameter name="a">1</parameter></invoke>`;
  for (const char of input) {
    parser.feedChar(char);
  }
  parser.finish();
  
  const events = parser.consumeEvents();
  assertEquals(events[0].type, "text");
  assertEquals(events[0].content, input);
});

Deno.test("ToolifyParser - New Delimiter format - Basic Tool Call", () => {
  const delimiter = new ToolCallDelimiter();
  const m = delimiter.getMarkers();
  const parser = new ToolifyParser(delimiter);
  
  const toolCall = `${m.TC_START}\n${m.NAME_START}get_weather${m.NAME_END}\n${m.ARGS_START}{"city": "London"}${m.ARGS_END}\n${m.TC_END}`;
  const input = `I will check the weather.\n${toolCall}`;
  
  for (const char of input) {
    parser.feedChar(char);
  }
  parser.finish();
  
  const events = parser.consumeEvents();
  
  // 预期：一段文本 + 一个工具调用
  assertEquals(events[0].type, "text");
  if (events[0].type === "text") {
    assertEquals(events[0].content.trim(), "I will check the weather.");
  }
  
  assertEquals(events[1].type, "tool_call");
  if (events[1].type === "tool_call") {
    assertEquals(events[1].call.name, "get_weather");
    assertEquals(events[1].call.arguments, { city: "London" });
  }
});

Deno.test("ToolifyParser - Partial marker matching", () => {
  const delimiter = new ToolCallDelimiter();
  const m = delimiter.getMarkers();
  const parser = new ToolifyParser(delimiter);
  
  // 模拟流式输入，在标记中间断开
  const part1 = "Hello! " + m.TC_START.slice(0, 2);
  const part2 = m.TC_START.slice(2) + `\n${m.NAME_START}test${m.NAME_END}\n${m.ARGS_START}{}${m.ARGS_END}\n${m.TC_END}`;
  
  for (const char of part1) {
    parser.feedChar(char);
  }
  // 此时 part1 末尾的标记前缀应该被缓冲在 pendingText 中，不应该发出
  let events = parser.consumeEvents();
  assertEquals(events.length, 1);
  assertEquals(events[0].content, "Hello! ");
  
  for (const char of part2) {
    parser.feedChar(char);
  }
  parser.finish();
  
  events = parser.consumeEvents();
  assertEquals(events[0].type, "tool_call");
  assertEquals(events[0].call.name, "test");
});

Deno.test("ToolifyParser - Thinking + Tool Call", () => {
  const delimiter = new ToolCallDelimiter();
  const m = delimiter.getMarkers();
  const parser = new ToolifyParser(delimiter, true); // 开启 thinking
  
  const input = `<thinking>I need to use a tool</thinking>\n${m.TC_START}\n${m.NAME_START}tool${m.NAME_END}\n${m.ARGS_START}{}${m.ARGS_END}\n${m.TC_END}`;
  
  for (const char of input) {
    parser.feedChar(char);
  }
  parser.finish();
  
  const events = parser.consumeEvents();
  assertEquals(events[0].type, "thinking");
  assertEquals(events[0].content, "I need to use a tool");
  assertEquals(events[1].type, "text"); // 换行符
  assertEquals(events[2].type, "tool_call");
});

Deno.test("ToolifyParser - Native reasoning_content support", () => {
  const delimiter = new ToolCallDelimiter();
  const parser = new ToolifyParser(delimiter);
  
  parser.feedReasoning("Native thinking process");
  const events = parser.consumeEvents();
  
  assertEquals(events.length, 1);
  assertEquals(events[0].type, "thinking");
  assertEquals(events[0].content, "Native thinking process");
});


Deno.test("ToolifyParser - Invalid JSON arguments", () => {
  const delimiter = new ToolCallDelimiter();
  const m = delimiter.getMarkers();
  const parser = new ToolifyParser(delimiter);
  
  const input = `${m.TC_START}\n${m.NAME_START}test${m.NAME_END}\n${m.ARGS_START}{invalid-json}${m.ARGS_END}\n${m.TC_END}`;
  
  for (const char of input) {
    parser.feedChar(char);
  }
  parser.finish();
  
  const events = parser.consumeEvents();
  // 解析失败应回退为文本
  assertEquals(events[0].type, "text");
  assertEquals(events[0].content, input);
});

Deno.test("ToolifyParser - Indented and Multi-line Tool Call (Tolerance Test)", () => {
  const delimiter = new ToolCallDelimiter();
  const m = delimiter.getMarkers();
  const parser = new ToolifyParser(delimiter);
  
  // 模拟带缩进和换行的输出
  const toolCall = `  ${m.TC_START}\n  ${m.NAME_START}bash${m.NAME_END}\n  ${m.ARGS_START}\n  {"command": "ls"}\n  ${m.ARGS_END}\n  ${m.TC_END}`;
  const input = `Sure, I can help.\n${toolCall}`;
  
  for (const char of input) {
    parser.feedChar(char);
  }
  parser.finish();
  
  const events = parser.consumeEvents();
  
  // 即使有缩进和换行，也应该能识别
  assertEquals(events[0].type, "text");
  assertEquals(events[1].type, "tool_call");
  if (events[1].type === "tool_call") {
    assertEquals(events[1].call.name, "bash");
    assertEquals(events[1].call.arguments, { command: "ls" });
  }
});

Deno.test("ToolifyParser - JSON Repair (Tolerance Test)", () => {
  const delimiter = new ToolCallDelimiter();
  const m = delimiter.getMarkers();
  const parser = new ToolifyParser(delimiter);
  
  // 模拟 JSON 中带有未转义换行符的情况
  const toolCall = `${m.TC_START}${m.NAME_START}test${m.NAME_END}${m.ARGS_START}{\n"msg": "hello\nworld"\n}${m.ARGS_END}${m.TC_END}`;
  
  for (const char of toolCall) {
    parser.feedChar(char);
  }
  parser.finish();
  
  const events = parser.consumeEvents();
  assertEquals(events[0].type, "tool_call");
  if (events[0].type === "tool_call") {
    assertEquals((events[0].call.arguments as any).msg, "hello\nworld");
  }
});
