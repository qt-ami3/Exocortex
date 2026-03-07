/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map, active job tracking, and dirty/flush
 * mechanism for saving to disk. Persistence operations are delegated
 * to persistence.ts.
 */

import type { Conversation, ModelId, ConversationSummary, Block } from "./messages";
import { createConversation } from "./messages";
import * as persistence from "./persistence";
import { log } from "./log";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const activeJobs = new Map<string, AbortController>();
const dirty = new Set<string>();
const chunkCounters = new Map<string, number>();
const unread = new Set<string>();
/** Accumulated display blocks for in-flight streams (for late-joining clients). */
const streamingBlocks = new Map<string, Block[]>();

const CHUNK_SAVE_INTERVAL = 5;

// ── IDs ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Conversations ───────────────────────────────────────────────────

export function create(id: string, model: ModelId): Conversation {
  const conv = createConversation(id, model);
  conversations.set(id, conv);
  markDirty(id);
  flush(id);
  return conv;
}

export function get(id: string): Conversation | undefined {
  return conversations.get(id);
}

export function remove(id: string): boolean {
  const existed = conversations.delete(id);
  if (existed) {
    dirty.delete(id);
    activeJobs.delete(id);
    persistence.deleteFile(id);
  }
  return existed;
}

export function setModel(id: string, model: ModelId): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.model = model;
  markDirty(id);
  flush(id);
  return true;
}

// ── Persistence ─────────────────────────────────────────────────────

/** Load all conversations from disk into memory on daemon startup. */
export function loadFromDisk(): void {
  const summaries = persistence.loadAll();
  for (const summary of summaries) {
    if (conversations.has(summary.id)) continue;
    const conv = persistence.load(summary.id);
    if (conv) {
      conversations.set(conv.id, conv);
    }
  }
  log("info", `conversations: loaded ${conversations.size} from disk`);
}

/** Mark a conversation as needing a save. */
export function markDirty(id: string): void {
  dirty.add(id);
}

/** Flush a dirty conversation to disk. */
export function flush(id: string): void {
  if (!dirty.has(id)) return;
  const conv = conversations.get(id);
  if (!conv) return;
  persistence.save(conv);
  dirty.delete(id);
}

/** Flush all dirty conversations. */
export function flushAll(): void {
  for (const id of dirty) {
    const conv = conversations.get(id);
    if (conv) persistence.save(conv);
  }
  dirty.clear();
}

/** Track chunk count and flush every N chunks. */
export function onChunk(id: string): void {
  const count = (chunkCounters.get(id) ?? 0) + 1;
  chunkCounters.set(id, count);
  if (count >= CHUNK_SAVE_INTERVAL) {
    markDirty(id);
    flush(id);
    chunkCounters.set(id, 0);
  }
}

/** Reset chunk counter (call on block boundaries / message complete). */
export function resetChunkCounter(id: string): void {
  chunkCounters.delete(id);
}

/** Get conversation summaries for the sidebar (from in-memory state). */
export function listSummaries(): ConversationSummary[] {
  const summaries: ConversationSummary[] = [];
  for (const conv of conversations.values()) {
    const s = getSummary(conv.id);
    if (s) summaries.push(s);
  }
  // Pinned first (stable order among pinned), then unpinned by updatedAt desc
  summaries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return summaries;
}

/** Toggle or set the marked flag on a conversation. */
export function mark(id: string, marked: boolean): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.marked = marked;
  markDirty(id);
  flush(id);
  return true;
}

/** Toggle or set the pinned flag on a conversation. */
export function pin(id: string, pinned: boolean): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  // Unpinning: bump updatedAt so it appears at the top of unpinned
  if (!pinned && conv.pinned) conv.updatedAt = Date.now();
  conv.pinned = pinned;
  markDirty(id);
  flush(id);
  return true;
}

/** Get a single conversation's summary. */
export function getSummary(id: string): ConversationSummary | null {
  const conv = conversations.get(id);
  if (!conv) return null;
  const firstUserMsg = conv.messages.find(m => m.role === "user");
  const preview = firstUserMsg
    ? typeof firstUserMsg.content === "string"
      ? firstUserMsg.content.slice(0, 80)
      : ""
    : "";
  return {
    id: conv.id,
    model: conv.model,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    preview,
    marked: conv.marked,
    pinned: conv.pinned,
    streaming: activeJobs.has(conv.id),
    unread: unread.has(conv.id),
  };
}

// ── Display data ───────────────────────────────────────────────────

import { buildDisplayData, type ConversationDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";

export type { ConversationDisplayData, DisplayEntry } from "./display";

export function getDisplayData(id: string): ConversationDisplayData | null {
  const conv = conversations.get(id);
  if (!conv) return null;
  return buildDisplayData(conv.id, conv.model, conv.messages, conv.lastContextTokens, summarizeTool);
}

// ── Unread state (runtime only, not persisted) ──────────────────────

export function markUnread(convId: string): void {
  unread.add(convId);
}

export function clearUnread(convId: string): boolean {
  return unread.delete(convId);
}

export function isUnread(convId: string): boolean {
  return unread.has(convId);
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

// ── Streaming blocks (accumulated display blocks for late-joiners) ──

/** Initialize streaming blocks for a new stream. */
export function initStreamingBlocks(convId: string): void {
  streamingBlocks.set(convId, []);
}

/** Get the accumulated streaming blocks (for late-joining clients). */
export function getStreamingBlocks(convId: string): Block[] | undefined {
  return streamingBlocks.get(convId);
}

/** Push a new block to the streaming accumulator. */
export function pushStreamingBlock(convId: string, block: Block): void {
  const blocks = streamingBlocks.get(convId);
  if (blocks) blocks.push(block);
}

/** Append text to the last streaming block of the given type. */
export function appendToStreamingBlock(convId: string, type: "text" | "thinking", chunk: string): void {
  const blocks = streamingBlocks.get(convId);
  if (!blocks) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === type) last.text += chunk;
}

/** Clear streaming blocks (call when stream finishes). */
export function clearStreamingBlocks(convId: string): void {
  streamingBlocks.delete(convId);
}
