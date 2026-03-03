/**
 * System prompt for exocortexd.
 *
 * Builds the system prompt sent to the Anthropic API.
 * Will grow as tools and capabilities are added.
 */

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  return [
    `You are an AI assistant. You are helpful, harmless, and honest.`,
    ``,
    `Environment:`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
  ].join("\n");
}
