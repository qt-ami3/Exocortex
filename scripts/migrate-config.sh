#!/usr/bin/env bash
# Remove compatibility symlinks from the config dir reorganization
# and restart the daemon so it picks up the new paths.
set -euo pipefail

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/exocortex"

echo "Cleaning up compatibility symlinks in $CONFIG_DIR ..."

SYMLINKS=(env credentials.json conversations trash instances cron usage.json)

for link in "${SYMLINKS[@]}"; do
  target="$CONFIG_DIR/$link"
  if [ -L "$target" ]; then
    rm "$target"
    echo "  ✓ removed $link"
  elif [ -e "$target" ]; then
    echo "  ⚠ $link exists but is not a symlink — skipping"
  else
    echo "  · $link already gone"
  fi
done

# The daemon recreated exocortex.log at the old root while running old code.
# Clean it up — new code writes to runtime/exocortex.log.
if [ -f "$CONFIG_DIR/exocortex.log" ] && [ ! -L "$CONFIG_DIR/exocortex.log" ]; then
  rm "$CONFIG_DIR/exocortex.log"
  echo "  ✓ removed stale exocortex.log from config root"
fi

echo ""
echo "Restarting daemon ..."
systemctl --user restart exocortex-daemon
sleep 1
systemctl --user status exocortex-daemon --no-pager
