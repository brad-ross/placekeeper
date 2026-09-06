#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
master="$script_dir/Placekeeper.svg"
renderer="$script_dir/render-svg.js"
iconset="$script_dir/Placekeeper.iconset"

render() {
  /usr/bin/osascript -l JavaScript "$renderer" "$master" "$2" "$1" >/dev/null
}

render 16 "$iconset/icon_16x16.png"
render 32 "$iconset/icon_16x16@2x.png"
render 32 "$iconset/icon_32x32.png"
render 64 "$iconset/icon_32x32@2x.png"
render 128 "$iconset/icon_128x128.png"
render 256 "$iconset/icon_128x128@2x.png"
render 256 "$iconset/icon_256x256.png"
render 512 "$iconset/icon_256x256@2x.png"
render 512 "$iconset/icon_512x512.png"
render 1024 "$iconset/icon_512x512@2x.png"
render 128 "$repo_root/apps/vscode/assets/placekeeper.png"

cp "$master" "$repo_root/apps/vscode/assets/placekeeper.svg"
cp "$master" "$repo_root/integrations/codex-plugin/assets/placekeeper.svg"
cp "$master" "$repo_root/integrations/codex-plugin/skills/placekeeper/assets/placekeeper.svg"
