#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Source installation requires Node.js 24 or newer and a C compiler (clang on macOS, cc on Linux). Windows users: run install.ps1 in a Visual Studio Developer PowerShell.' >&2
  exit 1
fi
exec node "$repo_root/packaging/desktop/source-install.mjs" "$@"
