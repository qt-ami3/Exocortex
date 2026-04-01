/**
 * Auto-compaction — transparent context management between agent loop rounds.
 *
 * When the conversation's context tokens exceed AUTO_COMPACT_THRESHOLD,
 * progressively frees space:
 *   1. Strip thinking blocks from old assistant turns (lossless)
 *   2. Strip large tool result outputs (near-lossless)
 *   3. Summarize the oldest turns via LLM (lossy, last resort)
 *
 * Targets CONTEXT_TARGET tokens. The caller is responsible for
 * triggering a message rebuild after modification.
 */

import type { Conversation, StoredMessage, ApiContentBlock } from "./messages";
import { isToolResultMessage } from "./messages";
import { complete } from "./llm";
import { log } from "./log";
import { CONTEXT_TARGET } from "./constants";

// ── Configuration ────────────────────────────────────────────────────

/** Auto-compact fires when context tokens exceed this. */
export const AUTO_COMPACT_THRESHOLD = 500_000;

/** Number of recent non-system messages protected from compaction. */
const PROTECTED_RECENT = 10;

/** Placeholder for stripped tool results. */
const STRIPPED_PLACEHOLDER = "[Output removed by auto-compact]";

/** Minimum estimated tokens for a range to be worth summarizing. */
const MIN_SUMMARIZE_TOKENS = 2_000;

// ── Helpers ──────────────────────────────────────────────────────────

function blockChars(block: ApiContentBlock): number {
  switch (block.type) {
    case "text": return block.text.length;
    case "thinking": return block.thinking.length + block.signature.length;
    case "tool_use": return JSON.stringify(block.input).length + block.name.length;
    case "tool_result":
      return typeof block.content === "string"
        ? block.content.length
        : JSON.stringify(block.content).length;
    case "image": return block.source.data.length;
    default: return 0;
  }
}

function messageChars(msg: StoredMessage): number {
  if (typeof msg.content === "string") return msg.content.length;
  let total = 0;
  for (const b of msg.content) total += blockChars(b);
  return total;
}

/**
 * Find the message index where the protected tail begins.
 * Messages before this index are eligible for compaction.
 * Returns 0 if the conversation is too short to compact.
 */
function protectedBoundary(messages: StoredMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "system") {
      count++;
      if (count >= PROTECTED_RECENT) return i;
    }
  }
  return 0;
}

// ── Step 1: Strip thinking ──────────────────────────────────────────

function stripThinking(messages: StoredMessage[], boundary: number): number {
  let removedChars = 0;

  for (let i = 0; i < boundary; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const blocks = msg.content as ApiContentBlock[];
    const thinkingBlocks = blocks.filter(b => b.type === "thinking");
    if (thinkingBlocks.length === 0) continue;

    const filtered = blocks.filter(b => b.type !== "thinking");
    if (filtered.length === 0) continue; // Only thinking — can't strip safely

    for (const b of thinkingBlocks) {
      if (b.type === "thinking") {
        removedChars += b.thinking.length + b.signature.length;
      }
    }

    msg.content = filtered;
  }

  return removedChars;
}

// ── Step 2: Strip tool results ──────────────────────────────────────

function stripResults(messages: StoredMessage[], boundary: number): number {
  let removedChars = 0;

  for (let i = 0; i < boundary; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (const b of msg.content as ApiContentBlock[]) {
      if (b.type !== "tool_result") continue;
      if (b.content === STRIPPED_PLACEHOLDER) continue;
      if (b.content === "[Output removed by context tool]") continue;

      const oldLen = typeof b.content === "string"
        ? b.content.length
        : JSON.stringify(b.content).length;

      const saved = oldLen - STRIPPED_PLACEHOLDER.length;
      if (saved <= 0) continue;

      removedChars += saved;
      (b as { content: string }).content = STRIPPED_PLACEHOLDER;
    }
  }

  return removedChars;
}

// ── Step 3: Summarize old turns ─────────────────────────────────────

async function summarizeOldTurns(
  messages: StoredMessage[],
  boundary: number,
  tokensToFree: number,
  charsPerToken: number,
  signal?: AbortSignal,
): Promise<number> {
  // Collect non-system message indices before boundary
  const indices: number[] = [];
  for (let i = 0; i < boundary; i++) {
    if (messages[i].role !== "system") indices.push(i);
  }

  if (indices.length < 4) return 0;

  // Determine how many turns to summarize (from the start)
  const charsToFree = tokensToFree * charsPerToken;
  let accChars = 0;
  let count = 0;
  for (const idx of indices) {
    accChars += messageChars(messages[idx]);
    count++;
    if (accChars >= charsToFree) break;
  }

  // Snap: if last included message is assistant with tool_use, include the next (tool_result)
  if (count < indices.length) {
    const lastMsg = messages[indices[count - 1]];
    if (lastMsg.role === "assistant" && Array.isArray(lastMsg.content) &&
        (lastMsg.content as ApiContentBlock[]).some(b => b.type === "tool_use")) {
      count = Math.min(count + 1, indices.length);
    }
  }

  if (count < 2) return 0;

  // Recompute accChars for the actual range (may have expanded by snap)
  accChars = 0;
  for (let i = 0; i < count; i++) {
    accChars += messageChars(messages[indices[i]]);
  }

  const rangeTokens = Math.round(accChars / charsPerToken);
  if (rangeTokens < MIN_SUMMARIZE_TOKENS) return 0;

  // Extract text for summarization
  const textParts: string[] = [];
  for (let i = 0; i < count; i++) {
    const msg = messages[indices[i]];
    if (msg.role === "user" && !isToolResultMessage(msg)) {
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content as ApiContentBlock[])
            .filter(b => b.type === "text")
            .map(b => (b as { type: "text"; text: string }).text)
            .join("\n");
      textParts.push(`User: ${text}`);
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const b of msg.content as ApiContentBlock[]) {
        if (b.type === "text" && b.text) parts.push(b.text);
        else if (b.type === "tool_use") parts.push(`[Tool: ${b.name}]`);
      }
      if (parts.length > 0) textParts.push(`Assistant: ${parts.join("\n")}`);
    }
    // Skip tool_result messages — verbose, findings captured in assistant text
  }

  const extractedText = textParts.join("\n\n");
  if (extractedText.length < 100) return 0;

  const maxTokens = Math.min(4096, Math.max(256, Math.round(rangeTokens / 3)));

  let summaryText: string;
  try {
    const result = await complete(
      `You are a conversation summarizer. Produce a concise summary preserving:
- Key decisions and conclusions
- Important file paths, commands, and code snippets
- What tools were used and their significant findings
- Errors encountered and resolutions
Omit verbose tool outputs. Output plain text, not markdown. Aim for at most ${maxTokens} tokens.`,
      extractedText,
      { model: "haiku", maxTokens, signal },
    );
    summaryText = result.text;
  } catch (err) {
    log("error", `autocompact: summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  // Splice: remove from first included index to last included index (inclusive),
  // including any system messages in between.
  const removeFrom = indices[0];
  const removeTo = indices[count - 1] + 1;

  const replacement: StoredMessage[] = [
    { role: "user" as const, content: `[Auto-compact summary of ${count} turns]`, metadata: null },
    { role: "assistant" as const, content: summaryText, metadata: null },
  ];

  const removedChars = accChars - summaryText.length - (replacement[0].content as string).length;
  messages.splice(removeFrom, removeTo - removeFrom, ...replacement);

  return Math.max(0, removedChars);
}

// ── Main entry point ────────────────────────────────────────────────

export interface AutoCompactResult {
  modified: boolean;
  report: string;
}

export async function autoCompact(
  conv: Conversation,
  signal?: AbortSignal,
): Promise<AutoCompactResult> {
  const lastCtx = conv.lastContextTokens;
  if (!lastCtx || lastCtx < AUTO_COMPACT_THRESHOLD) {
    return { modified: false, report: "" };
  }

  const target = CONTEXT_TARGET;
  const tokensToFree = lastCtx - target;

  log("info", `autocompact: triggered (${lastCtx} tokens, target ${target}, need to free ~${tokensToFree})`);

  const boundary = protectedBoundary(conv.messages);
  if (boundary <= 0) {
    log("info", "autocompact: conversation too short to compact");
    return { modified: false, report: "" };
  }

  const totalChars = conv.messages.reduce(
    (sum, m) => sum + (m.role !== "system" ? messageChars(m) : 0), 0,
  );
  const charsPerToken = lastCtx > 0 && totalChars > 0 ? totalChars / lastCtx : 4;

  const steps: string[] = [];
  let totalFreedChars = 0;

  // Step 1: Strip thinking
  const thinkingFreed = stripThinking(conv.messages, boundary);
  if (thinkingFreed > 0) {
    totalFreedChars += thinkingFreed;
    const tokFreed = Math.round(thinkingFreed / charsPerToken);
    steps.push(`stripped thinking (~${Math.round(tokFreed / 1000)}k tok)`);
    log("info", `autocompact: stripped thinking, freed ~${tokFreed} tokens`);

    if (totalFreedChars / charsPerToken >= tokensToFree) {
      return { modified: true, report: buildReport(steps, totalFreedChars, charsPerToken) };
    }
  }

  // Step 2: Strip tool results
  const resultsFreed = stripResults(conv.messages, boundary);
  if (resultsFreed > 0) {
    totalFreedChars += resultsFreed;
    const tokFreed = Math.round(resultsFreed / charsPerToken);
    steps.push(`stripped results (~${Math.round(tokFreed / 1000)}k tok)`);
    log("info", `autocompact: stripped results, freed ~${tokFreed} tokens`);

    if (totalFreedChars / charsPerToken >= tokensToFree) {
      return { modified: true, report: buildReport(steps, totalFreedChars, charsPerToken) };
    }
  }

  // Step 3: Summarize oldest turns
  const remaining = tokensToFree - Math.round(totalFreedChars / charsPerToken);
  const summaryFreed = await summarizeOldTurns(
    conv.messages,
    protectedBoundary(conv.messages),
    remaining,
    charsPerToken,
    signal,
  );
  if (summaryFreed > 0) {
    totalFreedChars += summaryFreed;
    const tokFreed = Math.round(summaryFreed / charsPerToken);
    steps.push(`summarized old turns (~${Math.round(tokFreed / 1000)}k tok)`);
    log("info", `autocompact: summarized old turns, freed ~${tokFreed} tokens`);
  }

  if (steps.length === 0) {
    return { modified: false, report: "" };
  }

  return { modified: true, report: buildReport(steps, totalFreedChars, charsPerToken) };
}

function buildReport(steps: string[], totalFreedChars: number, charsPerToken: number): string {
  const totalTok = Math.round(totalFreedChars / charsPerToken / 1000);
  return `Auto-compacted: ${steps.join(", ")}. ~${totalTok}k tokens freed.`;
}
