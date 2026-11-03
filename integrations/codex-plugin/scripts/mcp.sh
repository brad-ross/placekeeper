#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
resources=$(CDPATH= cd -- "$plugin_root/../.." && pwd -P)
node="$resources/node/bin/node"
server="$resources/codex-mcp/server.js"
if [ ! -x "$node" ] || [ ! -f "$server" ]; then
  printf '%s\n' 'Placekeeper MCP files are missing. Install the matching Placekeeper app and plugin, reload Codex, then reopen the PDF.' >&2
  exit 1
fi
PLACEKEEPER_APP_RESOURCES="$resources"
PLACEKEEPER_LAUNCHER="$resources/bin/placekeeper"
export PLACEKEEPER_APP_RESOURCES PLACEKEEPER_LAUNCHER
exec "$node" "$server"
