# Port an external tool to the Exocortex standard

You are porting an external tool to the Exocortex external-tools system.

## References

- **Standard**: Read `~/Workspace/Exocortex/external-tools/TOOL_STANDARD.md` — this defines
  the directory layout, manifest format, CLI conventions, output format, and everything else.
- **Reference implementation**: `~/Workspace/Exocortex/external-tools/gmail-cli/` — a fully
  ported tool you should study before making changes. Read its `manifest.json`, `bin/gmail`,
  and the Python source in `src/` to understand the patterns.

## What to do

1. Read both references above before writing any code.
2. Copy the tool into `~/Workspace/Exocortex/external-tools/<tool-name>/`.
3. Restructure it to match the standard (bin/, src/, config/, manifest.json, .gitignore).
4. Review and fix CLI ergonomics (subcommand naming, output format, confirmations, auth).
5. Create the venv and install dependencies if Python-based.
6. Test that `bin/<tool-name> --help` works and the daemon discovers it.
7. Initialize a git repo, set the upstream remote, commit, and push.

## Before you start

Ask the user:
- Where is the current tool source?
- What is the upstream git remote (if any)?
- Are there credentials/config files that need to be carried over?
