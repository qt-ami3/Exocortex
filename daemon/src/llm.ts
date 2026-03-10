/**
 * Lightweight inner LLM completions.
 *
 * Wraps streamMessage() for simple prompt-in / text-out use cases
 * where tools and streaming callbacks aren't needed — e.g. a tool
 * that wants to post-process its output through a model before
 * returning the result to the agent loop.
 *
 * This is NOT the main conversation path. For the outer agent loop
 * see agent.ts; for the full orchestration see orchestrator.ts.
 */

import { streamMessage } from "./api";
import { log } from "./log";
import type { ModelId } from "./messages";

// ── Types ──────────────────────────────────────────────────────────

export interface CompleteOptions {
  /** Model to use. Defaults to "sonnet". */
  model?: ModelId;
  /** Max output tokens. Defaults to 4096. */
  maxTokens?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

// ── No-op callbacks ────────────────────────────────────────────────

const noop = () => {};

// ── Public API ─────────────────────────────────────────────────────

/**
 * Run a single LLM completion. No tools, no streaming callbacks,
 * no conversation state — just system + user text in, text out.
 *
 * ```ts
 * const { text } = await complete("Summarize this page.", markdown);
 * ```
 */
export async function complete(
  system: string,
  userText: string,
  options: CompleteOptions = {},
): Promise<CompleteResult> {
  const {
    model = "sonnet",
    maxTokens = 4096,
    signal,
  } = options;

  const messages = [{ role: "user" as const, content: userText }];

  log("info", `llm: inner completion (model=${model}, maxTokens=${maxTokens}, input=${userText.length} chars)`);

  const result = await streamMessage(messages, model, {
    onText: noop,
    onThinking: noop,
  }, {
    system,
    maxTokens,
    signal,
  });

  log("info", `llm: inner completion done (in=${result.inputTokens ?? "?"}, out=${result.outputTokens ?? "?"}, text=${result.text.length} chars)`);

  return {
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
