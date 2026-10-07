#!/bin/sh
set -eu
app="$HOME/Applications/Placekeeper.app"
node="$app/Contents/Resources/node/bin/node"
server="$app/Contents/Resources/codex-mcp/server.js"
if [ ! -x "$node" ] || [ ! -f "$server" ]; then
  printf '%s\n' 'Placekeeper native MCP files are missing. Install the matching Placekeeper app and plugin, reload Codex, then reopen the PDF.' >&2
  exit 1
fi
exec "$node" "$server"
