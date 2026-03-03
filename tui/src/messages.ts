/**
 * Message and block model for the Exocortex TUI.
 *
 * This is the domain model — the core data structures that represent
 * conversations on the client side. Blocks are the atoms of an AI
 * message. Messages are the units of a conversation. Everything about
 * shape, metadata, and construction of messages lives here.
 */

// ── Models ──────────────────────────────────────────────────────────

export type ModelId = "sonnet" | "haiku" | "opus";

export const MODEL_MAP: Record<ModelId, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
  opus:   "claude-opus-4-6",
};

// ── Blocks ──────────────────────────────────────────────────────────

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export type Block = ThinkingBlock | TextBlock | ToolCallBlock | ToolResultBlock;

// ── Messages ────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  text: string;
}

export interface AIMessage {
  role: "assistant";
  blocks: Block[];
  model?: ModelId;
  tokens?: number;
  /** Timestamp (ms) when the daemon began processing this message. */
  startedAt: number;
  /** Timestamp (ms) when the daemon finished. Null while streaming. */
  endedAt: number | null;
}

/**
 * System messages are daemon-generated notices (errors, status changes).
 * Shown to the user, persisted in the conversation, never sent to the AI.
 */
export interface SystemMessage {
  role: "system";
  text: string;
}

export type Message = UserMessage | AIMessage | SystemMessage;

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a fresh pending AI message for streaming. */
export function createPendingAI(startedAt: number): AIMessage {
  return { role: "assistant", blocks: [], startedAt, endedAt: null };
}

/**
 * Get or create the last block of the given type in an AI message.
 * Used during streaming to append chunks to the right block.
 */
export function ensureCurrentBlock(msg: AIMessage, type: "text" | "thinking"): Block {
  const blocks = msg.blocks;
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) return last;

  const block: Block = { type, text: "" };
  blocks.push(block);
  return block;
}
