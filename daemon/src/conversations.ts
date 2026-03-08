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
/** Original startedAt timestamp per streaming job (for late-joining clients). */
const streamingStartedAt = new Map<string, number>();

const CHUNK_SAVE_INTERVAL = 5;

// ── IDs ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Conversations ───────────────────────────────────────────────────

export function create(id: string, model: ModelId): Conversation {
  // New conversations go to the top of unpinned: find min sortOrder and subtract 1
  let minOrder = 0;
  for (const c of conversations.values()) {
    if (!c.pinned && c.sortOrder < minOrder) minOrder = c.sortOrder;
  }
  const conv = createConversation(id, model, minOrder - 1);
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

export function rename(id: string, title: string): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.title = title;
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
  // Pinned first (by sortOrder), then unpinned (by sortOrder)
  summaries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.sortOrder - b.sortOrder;
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
  conv.pinned = pinned;
  if (pinned) {
    // Pinning: place at the bottom of the pinned section
    let maxOrder = -Infinity;
    for (const c of conversations.values()) {
      if (c.pinned && c.id !== id && c.sortOrder > maxOrder) maxOrder = c.sortOrder;
    }
    conv.sortOrder = maxOrder === -Infinity ? 0 : maxOrder + 1;
  } else {
    // Unpinning: place at the top of the unpinned section
    let minOrder = 0;
    for (const c of conversations.values()) {
      if (!c.pinned && c.id !== id && c.sortOrder < minOrder) minOrder = c.sortOrder;
    }
    conv.sortOrder = minOrder - 1;
  }
  markDirty(id);
  flush(id);
  return true;
}

/** Move a conversation up or down within its section (pinned or unpinned). */
export function move(id: string, direction: "up" | "down"): boolean {
  const summaries = listSummaries();
  const idx = summaries.findIndex(s => s.id === id);
  if (idx === -1) return false;

  const current = summaries[idx];
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= summaries.length) return false;

  const target = summaries[targetIdx];
  // Don't cross the pinned/unpinned boundary
  if (target.pinned !== current.pinned) return false;

  // Swap sortOrder values
  const currentConv = conversations.get(id)!;
  const targetConv = conversations.get(target.id)!;
  const tmp = currentConv.sortOrder;
  currentConv.sortOrder = targetConv.sortOrder;
  targetConv.sortOrder = tmp;

  markDirty(id);
  markDirty(target.id);
  flush(id);
  flush(target.id);
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
    title: conv.title ?? null,
    marked: conv.marked,
    pinned: conv.pinned,
    streaming: activeJobs.has(conv.id),
    unread: unread.has(conv.id),
    sortOrder: conv.sortOrder,
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

export function setActiveJob(convId: string, ac: AbortController, startedAt: number): void {
  activeJobs.set(convId, ac);
  streamingStartedAt.set(convId, startedAt);
}

export function getActiveJob(convId: string): AbortController | undefined {
  return activeJobs.get(convId);
}

export function clearActiveJob(convId: string): void {
  activeJobs.delete(convId);
  streamingStartedAt.delete(convId);
}

export function getStreamingStartedAt(convId: string): number | undefined {
  return streamingStartedAt.get(convId);
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
