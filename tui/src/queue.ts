/**
 * Message queue prompt — modal overlay for queuing messages during streaming.
 *
 * When the user submits a message while the AI is still streaming,
 * a modal appears letting them choose when to deliver it:
 * - "next turn": injected between tool-use rounds
 * - "message end": sent after the AI turn finishes
 *
 * j/k and arrow keys toggle the selection. Enter confirms, Escape cancels.
 */

import type { KeyEvent } from "./input";
import type { RenderState, QueueTiming, QueuedMessage } from "./state";
import { isStreaming } from "./state";

// ── Key handling ───────────────────────────────────────────────────

export interface QueueKeyResult {
  type: "handled" | "confirm" | "cancel";
}

/**
 * Handle a key event while the queue prompt overlay is active.
 * Returns "confirm" when the user picks a timing, "cancel" on Escape.
 */
export function handleQueuePromptKey(key: KeyEvent, state: RenderState): QueueKeyResult {
  const qp = state.queuePrompt!;

  switch (key.type) {
    case "char":
      if (key.char === "h" || key.char === "k") {
        qp.selection = "next-turn";
      } else if (key.char === "l" || key.char === "j") {
        qp.selection = "message-end";
      }
      return { type: "handled" };
    case "left":
    case "up":
      qp.selection = "next-turn";
      return { type: "handled" };
    case "right":
    case "down":
      qp.selection = "message-end";
      return { type: "handled" };
    case "tab":
      qp.selection = qp.selection === "next-turn" ? "message-end" : "next-turn";
      return { type: "handled" };
    case "enter":
      return { type: "confirm" };
    case "escape":
    case "ctrl-c":
      return { type: "cancel" };
    default:
      return { type: "handled" };
  }
}

// ── Confirm / cancel ───────────────────────────────────────────────

/**
 * Confirm the queued message. If streaming already finished while the
 * overlay was showing, send directly instead of queuing.
 *
 * Returns { direct: true, text } when the message should be sent
 * immediately via the daemon, or { direct: false } when queued.
 */
export function confirmQueueMessage(
  state: RenderState,
): { direct: true; text: string } | { direct: false } {
  const qp = state.queuePrompt!;
  const timing = qp.selection;
  const convId = state.convId;

  // If streaming already finished while the overlay was showing, send directly
  if (!isStreaming(state) && convId) {
    const text = qp.text;
    state.queuePrompt = null;
    state.inputBuffer = "";
    state.cursorPos = 0;
    return { direct: true, text };
  }

  if (!convId) {
    // No conversation — can't queue. Cancel silently.
    state.inputBuffer = qp.text;
    state.cursorPos = qp.text.length;
    state.queuePrompt = null;
    return { direct: false };
  }

  // Queue the message
  const queued: QueuedMessage = {
    convId,
    text: qp.text,
    timing,
  };
  state.queuedMessages.push(queued);
  state.queuePrompt = null;
  state.inputBuffer = "";
  state.cursorPos = 0;
  return { direct: false };
}

/**
 * Cancel the queue prompt — restore the text to the input buffer.
 */
export function cancelQueuePrompt(state: RenderState): void {
  const qp = state.queuePrompt!;
  state.inputBuffer = qp.text;
  state.cursorPos = qp.text.length;
  state.queuePrompt = null;
}

// ── Drain ──────────────────────────────────────────────────────────

/**
 * Drain queued messages for a conversation with the given timing.
 * Removes and returns the matching messages from the queue.
 */
export function drainQueuedMessages(
  state: RenderState,
  convId: string,
  timing?: QueueTiming,
): QueuedMessage[] {
  const drained: QueuedMessage[] = [];
  const remaining: QueuedMessage[] = [];
  for (const qm of state.queuedMessages) {
    if (qm.convId === convId && (timing === undefined || qm.timing === timing)) {
      drained.push(qm);
    } else {
      remaining.push(qm);
    }
  }
  state.queuedMessages = remaining;
  return drained;
}
