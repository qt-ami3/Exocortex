/**
 * Event collector for the send command.
 *
 * Subscribes to a conversation, sends a message, and collects
 * all events until streaming_stopped. Handles the full agentic
 * loop (multiple API turns with tool calls).
 */

import type { Connection } from "./conn";
import type { Event, Block } from "@exocortex/shared/protocol";

export interface CollectedResponse {
  convId: string;
  /** All blocks from all agentic turns, in order. */
  blocks: Block[];
  /** Total output tokens across all turns. */
  tokens: number;
  /** Wall-clock duration in seconds. */
  duration: number;
}

export type StreamCallback = (event: Event) => void;

/**
 * Send a message and collect the full response.
 *
 * Assumes the connection is already established and the client
 * is subscribed to the conversation.
 */
export function collectResponse(
  conn: Connection,
  convId: string,
  text: string,
  timeoutMs: number,
  onStream?: StreamCallback,
): Promise<CollectedResponse> {
  return new Promise((resolve, reject) => {
    const blocks: Block[] = [];
    let tokens = 0;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for response"));
    }, timeoutMs);

    // Stderr hint if the response is taking a while. Useful for humans
    // watching; harmless for scripts (goes to stderr, not stdout).
    const waitHint = setTimeout(() => {
      process.stderr.write("waiting for response…\n");
    }, 5_000);

    const handler = (event: Event) => {
      // Only care about events for our conversation
      if (!("convId" in event) || event.convId !== convId) return;

      onStream?.(event);

      switch (event.type) {
        case "message_complete":
          // Each agentic turn produces a message_complete with its blocks.
          blocks.push(...event.blocks);
          tokens += event.tokens;
          break;

        case "streaming_stopped":
          // The full agentic loop is done.
          cleanup();
          resolve({
            convId,
            blocks,
            tokens,
            duration: (Date.now() - startedAt) / 1000,
          });
          break;

        case "error":
          cleanup();
          reject(new Error(event.message));
          break;
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(waitHint);
      conn.offEvent(handler);
    };

    conn.onEvent(handler);
    conn.send({
      type: "send_message",
      convId,
      text,
      startedAt,
    });
  });
}
