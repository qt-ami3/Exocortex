import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import type { ApiMessage } from "../../messages";
import { buildOpenAIInputForTest, buildRequestBodyForTest } from "./api";

function requestShapeHash(system = "You are a helpful assistant.") {
  return createHash("sha256").update(JSON.stringify({
    model: "gpt-5.4",
    instructions: system,
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: "high",
      summary: "concise",
    },
  })).digest("hex");
}

describe("OpenAI replay input", () => {
  test("does not reuse response ids as assistant item ids", () => {
    const messages: ApiMessage[] = [
      {
        role: "user",
        content: "first prompt",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        providerData: {
          openai: {
            responseId: "resp_abc123",
            reasoningItems: [],
          },
        },
      },
      {
        role: "user",
        content: "follow-up",
      },
    ];

    const input = buildOpenAIInputForTest(messages) as Array<Record<string, unknown>>;
    const assistantItem = input.find((item) => item.role === "assistant");

    expect(assistantItem).toBeDefined();
    expect(assistantItem?.id).toBeUndefined();
  });

  test("request body omits max_output_tokens on the codex backend", () => {
    const body = buildRequestBodyForTest([
      { role: "user", content: "hello" },
    ], "gpt-5.4", 1234, {});

    expect(body.max_output_tokens).toBeUndefined();
  });

  test("reuses previous_response_id and sends only appended input when request shape matches", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        providerData: {
          openai: {
            responseId: "resp_abc123",
            requestShapeHash: requestShapeHash(),
            reasoningItems: [],
          },
        },
      },
      { role: "user", content: "follow-up" },
    ];

    const body = buildRequestBodyForTest(messages, "gpt-5.4", 1234, { promptCacheKey: "conv-1" });

    expect(body.previous_response_id).toBe("resp_abc123");
    expect(body.prompt_cache_key).toBe("conv-1");
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "follow-up" }],
      },
    ]);
  });

  test("falls back to full replay when request shape changes", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        providerData: {
          openai: {
            responseId: "resp_abc123",
            requestShapeHash: requestShapeHash(),
            reasoningItems: [],
          },
        },
      },
      { role: "user", content: "follow-up" },
    ];

    const body = buildRequestBodyForTest(messages, "gpt-5.4", 1234, { system: "Different instructions" });

    expect(body.previous_response_id).toBeUndefined();
    expect(body.input).toEqual(buildOpenAIInputForTest(messages));
  });
});
