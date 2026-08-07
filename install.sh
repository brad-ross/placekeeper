#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH

NODE_VERSION="24.14.0"
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_SHA256="a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3"
PNPM_VERSION="11.16.0"

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
user_home=${PDF_PROOFREADER_USER_HOME:-"$HOME"}
install_root=${PDF_PROOFREADER_INSTALL_ROOT:-"$user_home/Applications"}
app_path="$install_root/PDF Proofreader.app"
quick_action="$user_home/Library/Services/PDF Proofreader.workflow"
node_root="$repo_root/.local/toolchains/node-v${NODE_VERSION}-darwin-arm64"
node_bin="$node_root/bin/node"

case "$#" in
  0) install_mode=install ;;
  1)
    if [ "$1" != "--dry-run" ]; then
      printf 'Usage: %s [--dry-run]\n' "$0" >&2
      exit 2
    fi
    install_mode=dry-run
    ;;
  *)
    printf 'Usage: %s [--dry-run]\n' "$0" >&2
    exit 2
    ;;
esac
if [ "$(/usr/bin/uname -s)" != "Darwin" ] || [ "$(/usr/bin/uname -m)" != "arm64" ]; then
  printf '%s\n' "PDF Proofreader currently supports source installation on Apple-silicon macOS only." >&2
  exit 1
fi
for command in /usr/bin/curl /usr/bin/ditto /usr/bin/shasum /usr/bin/tar /usr/bin/mktemp; do
  if [ ! -x "$command" ]; then
    printf 'Required macOS tool is unavailable: %s\n' "$command" >&2
    exit 1
  fi
done

if [ "$install_mode" = "dry-run" ]; then
  printf '%s\n' \
    "PDF Proofreader Apple-silicon source install (dry run)" \
    "Toolchain: Node ${NODE_VERSION}, pnpm ${PNPM_VERSION}" \
    "App destination: ${app_path}" \
    "Quick Action: ${quick_action}" \
    "No files were changed"
  exit 0
fi

tmp_root=${TMPDIR:-/tmp}
case "$tmp_root" in /*) ;; *) tmp_root=/tmp ;; esac
work_dir=$(/usr/bin/mktemp -d "$tmp_root/pdf-proofreader-install.XXXXXX")
cleanup() {
  case "$work_dir" in
    "$tmp_root"/pdf-proofreader-install.*)
      if [ -d "$work_dir" ]; then /bin/rm -rf "$work_dir"; fi
      ;;
    *)
      printf 'Refusing to clean unexpected installer directory: %s\n' "$work_dir" >&2
      ;;
  esac
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -x "$node_bin" ]; then
  installed_version=$("$node_bin" --version)
  if [ "$installed_version" != "v${NODE_VERSION}" ]; then
    printf 'Cached toolchain has %s; remove %s and rerun.\n' "$installed_version" "$node_root" >&2
    exit 1
  fi
else
  if [ -e "$node_root" ]; then
    printf 'Cached toolchain is incomplete; remove %s and rerun.\n' "$node_root" >&2
    exit 1
  fi
  archive="$work_dir/$NODE_ARCHIVE"
  printf 'Downloading pinned Node %s toolchain...\n' "$NODE_VERSION"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 600 \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
    --output "$archive"
  actual_sha=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')
  if [ "$actual_sha" != "$NODE_SHA256" ]; then
    printf 'Node archive checksum mismatch. Expected %s, received %s.\n' "$NODE_SHA256" "$actual_sha" >&2
    exit 1
  fi
  /usr/bin/tar -xzf "$archive" -C "$work_dir"
  /bin/mkdir -p "$(dirname -- "$node_root")"
  /bin/mv "$work_dir/node-v${NODE_VERSION}-darwin-arm64" "$node_root"
fi

npm_cli="$node_root/lib/node_modules/npm/bin/npm-cli.js"
if [ ! -f "$npm_cli" ]; then
  printf 'Pinned Node toolchain does not contain npm: %s\n' "$npm_cli" >&2
  exit 1
fi
run_pnpm() {
  PATH="$node_root/bin:/usr/bin:/bin" "$node_bin" "$npm_cli" exec --yes "pnpm@${PNPM_VERSION}" -- "$@"
}

cd "$repo_root"
printf 'Installing pinned project dependencies...\n'
run_pnpm install --frozen-lockfile
printf 'Generating local PDF fixtures...\n'
run_pnpm fixtures:pdf
printf 'Building the Apple-silicon app...\n'
build_root="$work_dir/build"
/bin/mkdir -p "$build_root"
run_pnpm package:macos -- --arch arm64 --node-runtime "$node_bin" --output "$build_root"
built_app="$build_root/PDF Proofreader.app"
if [ ! -x "$built_app/Contents/MacOS/pdf-proofreader" ]; then
  printf '%s\n' "The app build did not produce its launcher." >&2
  exit 1
fi

printf 'Checking the packaged writer offline before installation...\n'
run_pnpm smoke:installed -- "$built_app" "$repo_root/test/fixtures/pdfs/text-native.pdf"

"$repo_root/packaging/macos/install-built-app.sh" "$built_app" "$app_path" "$quick_action"

launch_services="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$launch_services" ]; then
  if ! "$launch_services" -f "$app_path" >/dev/null 2>&1; then
    printf '%s\n' "Warning: macOS did not refresh Open With registration. The Finder Quick Action is installed; reopen Finder before trying Open With." >&2
  fi
else
  printf '%s\n' "Warning: LaunchServices registration is unavailable. The Finder Quick Action is installed; Open With may appear after Finder refreshes." >&2
fi

printf '\nPDF Proofreader installed successfully.\n'
printf 'App: %s\n' "$app_path"
printf 'Finder: select one PDF, then use Open With or Quick Actions -> PDF Proofreader.\n'
printf 'If macOS warns on first launch, Control-click the app in Finder and choose Open.\n'
