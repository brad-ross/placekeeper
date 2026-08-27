#!/bin/sh
set -eu

resources_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd -P)

if [ "$#" -ne 1 ]; then
  exit 2
fi

PLACEKEEPER_PDFIUM_WASM="$resources_dir/pdfium/pdfium.wasm"
export PLACEKEEPER_PDFIUM_WASM

exec "$resources_dir/node/bin/node" \
  "$resources_dir/service/main.js" \
  chrome-native-host \
  "$1"
