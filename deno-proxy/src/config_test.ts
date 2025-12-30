import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectProtocol } from "./config.ts";

Deno.test("detectProtocol - identifies openai", () => {
  assertEquals(detectProtocol("https://api.openai.com/v1/chat/completions", "anthropic"), "openai");
  assertEquals(detectProtocol("http://localhost:8000/v1/chat/completions", "anthropic"), "openai");
  assertEquals(detectProtocol("http://proxy.com/v1/chat/completions?key=abc", "anthropic"), "openai");
});

Deno.test("detectProtocol - identifies anthropic", () => {
  assertEquals(detectProtocol("https://api.anthropic.com/v1/messages", "openai"), "anthropic");
  assertEquals(detectProtocol("http://localhost:8000/v1/messages", "openai"), "anthropic");
  assertEquals(detectProtocol("https://my-proxy.workers.dev/v1/messages", "openai"), "anthropic");
});

Deno.test("detectProtocol - falls back to default", () => {
  assertEquals(detectProtocol("https://api.openai.com/v1/models", "anthropic"), "anthropic");
  assertEquals(detectProtocol("invalid-url", "openai"), "openai");
});
