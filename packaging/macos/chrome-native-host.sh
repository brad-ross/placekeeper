#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  exit 2
fi

macos_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$macos_dir/placekeeper" chrome-native-host "$1"
