/**
 * Auto-generate conversation titles via Haiku.
 *
 * Collects all user messages from the conversation and sends them
 * to the daemon's llm_complete endpoint so the title reflects the
 * full scope of the conversation. Called when `/rename` is used
 * with no arguments — can be re-run when the topic shifts.
 */

import type { DaemonClient } from "./client";
import type { RenderState } from "./state";

// ── Prompt ─────────────────────────────────────────────────────────

const INSTRUCTION = `You generate short conversation titles. Output ONLY the title — 3 to 4 lowercase words, no quotes, no punctuation, no explanation. Match this naming style:
exo bash truncate, exo code qa, berlin airbnb, tokens bug, context tool, unbricking convo, merging img pasting, netherlands trains, exo vim linewrapping, exo msg queuing, fixing message queuing, airpods pro autoconnect, discord streaming, context management

Here is the conversation to generate a title for:
<prompt>`;

// Must exceed the thinking budget (10000) configured in api.ts for
// non-adaptive models — otherwise all tokens go to thinking and the
// text response is empty.
const MAX_TOKENS = 10200;

/** Max characters of user message context to send for title generation. */
const MAX_CONTEXT_CHARS = 2000;

/** Placeholder title shown while generation is in-flight. */
export const PENDING_TITLE = "pending";

// ── Helpers ────────────────────────────────────────────────────────

/** Collect user messages into a single string, truncated to MAX_CONTEXT_CHARS. */
function extractUserContext(state: RenderState): string {
  const parts: string[] = [];
  let total = 0;
  for (const msg of state.messages) {
    if (msg.role !== "user" || !("text" in msg)) continue;
    const text = msg.text;
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    parts.push(text.slice(0, remaining));
    total += text.length;
  }
  return parts.join("\n\n");
}

// ── Public API ─────────────────────────────────────────────────────

export function generateTitle(
  convId: string,
  state: RenderState,
  daemon: DaemonClient,
  scheduleRender: () => void,
): void {
  const context = extractUserContext(state);
  const prompt = `${INSTRUCTION}\n${context}\n</prompt>`;

  daemon.llmComplete(
    "",
    prompt,
    (generatedTitle) => {
      const title = generatedTitle.trim().toLowerCase().replace(/["""''`.]/g, "");
      daemon.renameConversation(convId, title);
      const conv = state.sidebar.conversations.find(c => c.id === convId);
      if (conv) conv.title = title;
      scheduleRender();
    },
    (error) => {
      // Leave as "pending" — no preview fallback exists anymore.
      state.messages.push({ role: "system", text: `✗ Title generation failed: ${error}`, metadata: null });
      scheduleRender();
    },
    "haiku",
    MAX_TOKENS,
  );
}
