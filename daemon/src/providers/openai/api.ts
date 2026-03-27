import { log } from "../../log";
import type { ApiMessage, ModelId } from "../../messages";
import { getVerifiedSession, AuthError } from "./auth";
import { OPENAI_CODEX_RESPONSES_URL, OPENAI_ORIGINATOR } from "./constants";
import { buildOpenAIInput, buildRequestBody, type OpenAIReasoningItem } from "./request";
import type { ApiToolCall, ContentBlock, StreamCallbacks, StreamOptions, StreamResult } from "../types";

export { AuthError };

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;

interface OpenAIStreamToolState {
  id: string;
  name: string;
  arguments: string;
}

function retryBackoff(
  attempt: number,
  errMsg: string,
  callbacks: StreamCallbacks,
): Promise<void> {
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
  const delaySec = Math.round(delay / 1000);
  log("warn", `openai api: ${errMsg}, retry ${attempt + 1}/${MAX_RETRIES} in ${delaySec}s`);
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export function buildOpenAIInputForTest(messages: ApiMessage[]): unknown[] {
  return buildOpenAIInput(messages);
}

export function buildRequestBodyForTest(
  messages: ApiMessage[],
  model: ModelId,
  _maxTokens: number,
  options: StreamOptions,
): Record<string, unknown> {
  return buildRequestBody(messages, model, options).body;
}

function finalizeTextBlock(text: string, blocks: ContentBlock[]): void {
  if (text) blocks.push({ type: "text", text });
}

function finalizeReasoningItem(
  reasoning: OpenAIReasoningItem | undefined,
  blocks: ContentBlock[],
  fullThinking: { value: string },
): void {
  if (!reasoning) return;
  for (const summary of reasoning.summaries) {
    blocks.push({ type: "thinking", text: summary, signature: "" });
    fullThinking.value += summary;
  }
}

function parseEventData(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const pieces = chunk.split("\n\n");
  for (const piece of pieces) {
    const lines = piece.split("\n").map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.slice(6)).join("\n");
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return events;
}

async function readStream(
  res: Response,
  cb: StreamCallbacks,
  requestShapeHash?: string,
): Promise<StreamResult> {
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason = "";
  let fullText = "";
  const fullThinking = { value: "" };
  const blocks: ContentBlock[] = [];
  const toolCalls: ApiToolCall[] = [];
  const textStarted = new Set<string>();
  const toolStates = new Map<number, OpenAIStreamToolState>();
  const reasoningStates = new Map<number, OpenAIReasoningItem>();
  const currentReasoningIndexes = new Map<number, number>();
  let currentReasoningOutputIndex: number | null = null;

  const handleEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case "response.created":
        responseId = (event.response as { id?: string } | undefined)?.id;
        break;

      case "response.output_item.added": {
        const outputIndex = event.output_index as number;
        const item = event.item as Record<string, unknown> | undefined;
        if (!item) break;
        if (item.type === "function_call") {
          toolStates.set(outputIndex, {
            id: String(item.call_id ?? ""),
            name: String(item.name ?? ""),
            arguments: "",
          });
        } else if (item.type === "reasoning") {
          reasoningStates.set(outputIndex, {
            id: String(item.id ?? outputIndex),
            encryptedContent: typeof item.encrypted_content === "string" ? item.encrypted_content : null,
            summaries: [],
          });
          currentReasoningOutputIndex = outputIndex;
        }
        break;
      }

      case "response.output_text.delta": {
        const itemId = String(event.item_id ?? "assistant");
        if (!textStarted.has(itemId)) {
          textStarted.add(itemId);
          cb.onBlockStart?.("text");
        }
        const delta = String(event.delta ?? "");
        fullText += delta;
        cb.onText(delta);
        break;
      }

      case "response.function_call_arguments.delta": {
        const outputIndex = event.output_index as number;
        const state = toolStates.get(outputIndex);
        if (state) state.arguments += String(event.delta ?? "");
        break;
      }

      case "response.reasoning_summary_part.added": {
        const outputIndex = currentReasoningOutputIndex;
        if (outputIndex == null) break;
        const summaryIndex = Number(event.summary_index ?? 0);
        currentReasoningIndexes.set(outputIndex, summaryIndex);
        const state = reasoningStates.get(outputIndex);
        if (!state) break;
        while (state.summaries.length <= summaryIndex) state.summaries.push("");
        cb.onBlockStart?.("thinking");
        break;
      }

      case "response.reasoning_summary_text.delta": {
        const outputIndex = currentReasoningOutputIndex;
        if (outputIndex == null) break;
        const summaryIndex = currentReasoningIndexes.get(outputIndex) ?? Number(event.summary_index ?? 0);
        const state = reasoningStates.get(outputIndex);
        if (!state) break;
        while (state.summaries.length <= summaryIndex) state.summaries.push("");
        const delta = String(event.delta ?? "");
        state.summaries[summaryIndex] += delta;
        cb.onThinking(delta);
        break;
      }

      case "response.output_item.done": {
        const outputIndex = event.output_index as number;
        const item = event.item as Record<string, unknown> | undefined;
        if (!item) break;
        if (item.type === "function_call") {
          const state = toolStates.get(outputIndex);
          const rawArgs = state?.arguments || String(item.arguments ?? "{}");
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
          } catch {
            log("warn", `openai api: failed to parse tool input for ${String(item.name ?? "unknown")}`);
          }
          toolCalls.push({
            id: state?.id || String(item.call_id ?? ""),
            name: state?.name || String(item.name ?? ""),
            input,
          });
          toolStates.delete(outputIndex);
        } else if (item.type === "reasoning") {
          const state = reasoningStates.get(outputIndex);
          if (state) {
            if (typeof item.encrypted_content === "string") {
              state.encryptedContent = item.encrypted_content;
            }
            reasoningStates.set(outputIndex, state);
          }
          if (currentReasoningOutputIndex === outputIndex) {
            currentReasoningOutputIndex = null;
          }
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const response = event.response as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
          };
          incomplete_details?: { reason?: string };
          output?: Array<Record<string, unknown>>;
        } | undefined;
        inputTokens = response?.usage?.input_tokens;
        outputTokens = response?.usage?.output_tokens;
        for (const item of response?.output ?? []) {
          if (item.type === "reasoning") {
            const existing = [...reasoningStates.values()].find((candidate) => candidate.id === String(item.id ?? ""));
            const summaries = Array.isArray(item.summary)
              ? item.summary
                  .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
                  .filter((part) => part.type === "summary_text")
                  .map((part) => part.text ?? "")
              : [];
            if (existing) {
              if (existing.summaries.length === 0 && summaries.length > 0) {
                existing.summaries.push(...summaries);
              }
              if (existing.encryptedContent === null && typeof item.encrypted_content === "string") {
                existing.encryptedContent = item.encrypted_content;
              }
            } else {
              reasoningStates.set(reasoningStates.size, {
                id: String(item.id ?? reasoningStates.size),
                encryptedContent: typeof item.encrypted_content === "string" ? item.encrypted_content : null,
                summaries,
              });
            }
          } else if (item.type === "function_call") {
            if (!toolCalls.some((call) => call.id === String(item.call_id ?? ""))) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(String(item.arguments ?? "{}")) as Record<string, unknown>;
              } catch {}
              toolCalls.push({
                id: String(item.call_id ?? ""),
                name: String(item.name ?? ""),
                input,
              });
            }
          } else if (item.type === "message" && !fullText) {
            const content = Array.isArray(item.content) ? item.content : [];
            fullText = content
              .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
              .filter((part) => part.type === "output_text")
              .map((part) => part.text ?? "")
              .join("");
          }
        }
        stopReason = event.type === "response.completed"
          ? (toolCalls.length > 0 ? "tool_use" : "stop")
          : String(response?.incomplete_details?.reason ?? "incomplete");
        break;
      }

      case "response.failed": {
        const response = event.response as { error?: { message?: string } } | undefined;
        throw new Error(response?.error?.message ?? "OpenAI response failed");
      }

      case "error": {
        const err = event.error as { message?: string } | undefined;
        throw new Error(err?.message ?? "OpenAI stream error");
      }
    }
  };

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () => reject(new Error(`No data for ${STREAM_STALL_TIMEOUT / 1000}s`)),
          STREAM_STALL_TIMEOUT,
        );
      }),
    ]).finally(() => clearTimeout(stallTimer!));

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) continue;
    const ready = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseEventData(ready)) {
      handleEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const event of parseEventData(buffer)) {
      handleEvent(event);
    }
  }

  finalizeTextBlock(fullText, blocks);
  const orderedReasoningItems = [...reasoningStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item)
    .filter((item) => item.summaries.some((summary) => summary.length > 0));
  for (const item of orderedReasoningItems) {
    finalizeReasoningItem(item, blocks, fullThinking);
  }

  if (!stopReason && toolCalls.length > 0) stopReason = "tool_use";

  return {
    text: fullText,
    thinking: fullThinking.value,
    stopReason,
    blocks: [
      ...blocks.filter((block) => block.type === "thinking"),
      ...blocks.filter((block) => block.type === "text"),
    ],
    toolCalls,
    inputTokens,
    outputTokens,
    assistantProviderData: {
      openai: {
        ...(responseId ? { responseId } : {}),
        ...(requestShapeHash ? { requestShapeHash } : {}),
        reasoningItems: orderedReasoningItems,
      },
    },
  };
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const session = await getVerifiedSession();
  let retryAttempt = 0;
  const requestPlan = buildRequestBody(messages, model, options);
  const requestBody = requestPlan.body;

  while (true) {
    const res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        originator: OPENAI_ORIGINATOR,
        "User-Agent": "exocortexd/openai",
        ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    if (res.status === 401) {
      throw new AuthError("OpenAI authentication failed. Re-run `bun run src/main.ts login openai`.");
    }

    if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}`, callbacks);
        continue;
      }
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${text}`);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readStream(res, callbacks, requestPlan.requestShapeHash);
    } catch (err) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks);
        continue;
      }
      throw err;
    }
  }
}
