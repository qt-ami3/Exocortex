/**
 * In-memory conversation store.
 *
 * Owns the conversation map and active job tracking.
 * When persistence is added, this is the file that changes.
 */

import type { Conversation, ModelId } from "./messages";
import { createConversation } from "./messages";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const activeJobs = new Map<string, AbortController>();

// ── IDs ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Conversations ───────────────────────────────────────────────────

export function create(id: string, model: ModelId): Conversation {
  const conv = createConversation(id, model);
  conversations.set(id, conv);
  return conv;
}

export function get(id: string): Conversation | undefined {
  return conversations.get(id);
}

// ── Active jobs (abort controllers for in-flight streams) ───────────

/** Streaming state is derived from activeJobs — no boolean on Conversation. */
export function isStreaming(convId: string): boolean {
  return activeJobs.has(convId);
}

export function setActiveJob(convId: string, ac: AbortController): void {
  activeJobs.set(convId, ac);
}

export function getActiveJob(convId: string): AbortController | undefined {
  return activeJobs.get(convId);
}

export function clearActiveJob(convId: string): void {
  activeJobs.delete(convId);
}
