/**
 * Write tool — write content to a file.
 *
 * Creates the file if it doesn't exist, overwrites if it does.
 * Parent directories are created automatically.
 * Requires absolute paths.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { log } from "../log";

// ── Execution ──────────────────────────────────────────────────────

async function executeWrite(input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = input.file_path as string;
  const content = input.content as string;

  if (!filePath) return { output: "Error: missing 'file_path' parameter", isError: true };
  if (content == null) return { output: "Error: missing 'content' parameter", isError: true };
  if (!filePath.startsWith("/")) {
    return { output: `Error: file_path must be absolute, got: ${filePath}`, isError: true };
  }

  try {
    const file = Bun.file(filePath);
    const existed = await file.exists();

    // Create parent directories if needed
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (dir) {
      const { mkdirSync } = await import("fs");
      try { mkdirSync(dir, { recursive: true }); } catch {}
    }

    await Bun.write(filePath, content);

    const lines = content.split("\n").length;
    const bytes = Buffer.byteLength(content, "utf-8");
    const action = existed ? "Updated" : "Created";
    return { output: `${action} ${filePath} (${lines} lines, ${bytes} bytes)`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `writeFile: ${filePath}: ${msg}`);
    return { output: `Error writing ${filePath}: ${msg}`, isError: true };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const filePath = (input.file_path as string) ?? "";
  return { label: "Write", detail: filePath };
}

// ── Tool definition ────────────────────────────────────────────────

export const write: Tool = {
  name: "write",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to write" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["file_path", "content"],
  },
  display: {
    label: "Write",
    color: "#c792ea",  // soft purple
  },
  summarize,
  execute: executeWrite,
};
