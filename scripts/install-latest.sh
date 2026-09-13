#!/bin/sh
# Keep execution inside a function so an incomplete streamed body cannot run.
placekeeper_install_latest() (
  set -eu
  work=$(mktemp -d "${TMPDIR:-/tmp}/placekeeper-latest.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if ! curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 120 \
    https://github.com/brad-ross/placekeeper/releases/latest/download/install-placekeeper.sh -o "$work/install.sh"; then
    printf '%s\n' 'Placekeeper: installer download failed. Please try again.' >&2
    exit 1
  fi
  sh "$work/install.sh" "$@"
)
placekeeper_install_latest "$@"
