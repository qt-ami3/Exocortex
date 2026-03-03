/**
 * TUI render state.
 *
 * Owns the shape of the UI state that drives rendering.
 * Message and block types live in messages.ts.
 */

import type { ModelId } from "./messages";
import type { Message, AIMessage } from "./messages";

export interface RenderState {
  messages: Message[];
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  streaming: boolean;
  streamStartedAt: number | null;
  model: ModelId;
  convId: string | null;
  inputBuffer: string;
  cursorPos: number;
  cols: number;
  rows: number;
  scrollOffset: number;
}

export function createInitialState(): RenderState {
  return {
    messages: [],
    pendingAI: null,
    streaming: false,
    streamStartedAt: null,
    model: "sonnet",
    convId: null,
    inputBuffer: "",
    cursorPos: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollOffset: 0,
  };
}
