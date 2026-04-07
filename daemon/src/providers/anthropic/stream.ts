import { log } from "../../log";
import type { ApiToolCall, ContentBlock, StreamCallbacks, StreamResult } from "../types";

const NON_RETRYABLE_STREAM_ERRORS = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
]);

export class RetryableStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableStreamError";
  }
}

interface BlockState {
  type: "text" | "thinking" | "tool_use";
  text: string;
  id: string;
  name: string;
  inputJson: string;
  signature: string;
}

function finalizeBlock(
  block: BlockState,
  orderedBlocks: ContentBlock[],
  toolCalls: ApiToolCall[],
): void {
  if (block.type === "thinking") {
    if (block.text) {
      orderedBlocks.push({ type: "thinking", text: block.text, signature: block.signature });
    }
  } else if (block.type === "text") {
    if (block.text) {
      orderedBlocks.push({ type: "text", text: block.text });
    }
  } else if (block.type === "tool_use") {
    let input: Record<string, unknown> = {};
    try {
      if (block.inputJson) input = JSON.parse(block.inputJson);
    } catch {
      log("warn", `api: failed to parse tool input JSON for ${block.name}: ${block.inputJson.slice(0, 200)}`);
    }
    toolCalls.push({ id: block.id, name: block.name, input });
  }
}

export async function readAnthropicStream(
  res: Response,
  cb: StreamCallbacks,
  stallTimeoutMs: number,
): Promise<StreamResult> {
  if (!res.body) throw new Error("No response body");

  let fullText = "";
  let fullThinking = "";
  let stopReason = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const toolCalls: ApiToolCall[] = [];
  const orderedBlocks: ContentBlock[] = [];
  const blocks = new Map<number, BlockState>();

  const processEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case "content_block_start": {
        const idx = event.index as number;
        const contentBlock = event.content_block as Record<string, unknown>;
        if (contentBlock.type === "text") {
          blocks.set(idx, { type: "text", text: "", id: "", name: "", inputJson: "", signature: "" });
          cb.onBlockStart?.("text");
        } else if (contentBlock.type === "thinking") {
          blocks.set(idx, { type: "thinking", text: "", id: "", name: "", inputJson: "", signature: "" });
          cb.onBlockStart?.("thinking");
        } else if (contentBlock.type === "tool_use") {
          blocks.set(idx, {
            type: "tool_use",
            text: "",
            id: (contentBlock.id as string) ?? "",
            name: (contentBlock.name as string) ?? "",
            inputJson: "",
            signature: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const idx = event.index as number;
        const block = blocks.get(idx);
        if (!block) break;
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.type === "text_delta") {
          block.text += delta.text;
          fullText += delta.text;
          cb.onText(delta.text);
        } else if (delta?.type === "thinking_delta") {
          block.text += delta.thinking;
          fullThinking += delta.thinking;
          cb.onThinking(delta.thinking);
        } else if (delta?.type === "signature_delta") {
          block.signature = delta.signature;
          cb.onSignature?.(delta.signature);
        } else if (delta?.type === "input_json_delta") {
          block.inputJson += delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const idx = event.index as number;
        const block = blocks.get(idx);
        if (block) finalizeBlock(block, orderedBlocks, toolCalls);
        break;
      }
      case "message_start": {
        const msg = event.message as Record<string, Record<string, number>> | undefined;
        if (msg?.usage) {
          inputTokens = (msg.usage.input_tokens ?? 0)
            + (msg.usage.cache_creation_input_tokens ?? 0)
            + (msg.usage.cache_read_input_tokens ?? 0);
        }
        break;
      }
      case "message_delta": {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        break;
      }
      case "error": {
        const err = event.error as Record<string, string> | undefined;
        const errType = err?.type ?? "unknown";
        const reason = err?.message || errType;
        if (NON_RETRYABLE_STREAM_ERRORS.has(errType)) throw new Error(reason);
        throw new RetryableStreamError(reason);
      }
    }
  };

  const processLines = (lines: string[]) => {
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        processEvent(JSON.parse(data));
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () => reject(new RetryableStreamError(`No data for ${stallTimeoutMs / 1000}s`)),
          stallTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(stallTimer!));
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    processLines(lines);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processLines(buffer.split("\n"));

  if (!stopReason && toolCalls.length > 0) stopReason = "tool_use";

  return { text: fullText, thinking: fullThinking, stopReason, blocks: orderedBlocks, toolCalls, inputTokens, outputTokens };
}
