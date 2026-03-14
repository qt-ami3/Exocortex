# exo — Exocortex CLI

A stateless, machine-friendly command-line interface to the Exocortex daemon (`exocortexd`).

Designed for AI-to-AI interaction and scripting. Each invocation connects to the daemon via Unix socket, sends a command, waits for the response, and disconnects. The daemon owns all state — conversation IDs are the only handles.

## Install

```bash
cd cli && make install
```

This symlinks `bin/exo` into `~/.local/bin/`. Requires `bun` on `PATH`.

To uninstall:

```bash
cd cli && make uninstall
```

## Usage

### Send messages

```bash
# New conversation (returns response + conversation ID)
exo "What is the capital of France?"

# Continue an existing conversation
exo "What about Germany?" -c <convId>

# Choose a model
exo "Explain quantum entanglement" --opus
exo "Quick question" --haiku

# Read message from stdin
cat prompt.txt | exo -
echo "Summarize this" | exo - -c <convId>

# Get only the conversation ID (for scripting)
CONV=$(exo "Start a task" --id)
exo "Continue the task" -c "$CONV"
```

### One-shot LLM

Fire-and-forget completion — no conversation created or persisted.

```bash
exo llm "Translate 'hello' to Japanese"
exo llm "Classify this sentiment" --system "You are a sentiment classifier" --haiku
cat document.txt | exo llm - --system "Summarize in 3 bullets"
```

### Manage conversations

```bash
exo ls                          # List all conversations
exo ls --json                   # JSON output

exo info <convId>               # Metadata: model, tokens, message count
exo info <convId> --json

exo history <convId>            # Full message transcript
exo history <convId> --full     # Include thinking blocks + tool results
exo history <convId> --json

exo rename <convId> "new title"
exo rm <convId>
exo abort <convId>              # Abort an in-flight stream
```

### Daemon health

```bash
exo status                      # Ping daemon, show summary
exo status --json
```

## Output modes

| Flag       | Description                                        |
|------------|----------------------------------------------------|
| *(default)* | Human-readable text. Tool calls shown as summaries. Thinking and tool results hidden. |
| `--full`   | Include thinking blocks (💭) and tool results (┃).  |
| `--json`   | Structured JSON output.                             |
| `--stream` | NDJSON events as they arrive from the daemon.       |
| `--id`     | Print only the conversation ID (for scripting).     |

## Flags

| Flag                  | Description                                |
|-----------------------|--------------------------------------------|
| `--opus`              | Use Claude Opus                            |
| `--sonnet`            | Use Claude Sonnet                          |
| `--haiku`             | Use Claude Haiku                           |
| `-c`, `--conv <id>`   | Continue an existing conversation          |
| `--system <prompt>`   | System prompt (for `llm` command)          |
| `--timeout <sec>`     | Max wait time in seconds (default: 300)    |

## Auto-titling

Conversations created via the CLI are automatically titled with a `cli:` prefix followed by the first line of the message (truncated to 80 chars). This makes it easy to distinguish CLI-spawned conversations from human-created ones in `exo ls` and the TUI sidebar.

## Exit codes

| Code | Meaning                    |
|------|----------------------------|
| 0    | Success                    |
| 1    | Daemon error / bad input   |
| 2    | Connection failed (daemon not running) |

## Architecture

```
exo ──unix socket──▸ exocortexd ──▸ Claude API
                         │
                    state on disk
                    (conversations, config)
```

The CLI is fully stateless. It uses the same Unix socket protocol and shared types as the TUI. The daemon is the single source of truth for all conversation state.

### File structure

```
cli/
├── bin/exo            Bash wrapper (resolves project root, execs bun)
├── Makefile           install/uninstall targets
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts        Entry point: arg parsing, subcommand dispatch
    ├── commands.ts    All command implementations
    ├── conn.ts        Promise-based Unix socket client
    ├── collect.ts     Event collector for streaming responses
    ├── format.ts      Block → text/JSON formatting
    └── help.ts        Help text for global and per-command --help
```

## Per-command help

Every command has detailed help accessible via:

```bash
exo <command> --help
exo help <command>
```
