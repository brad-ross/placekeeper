#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  printf 'Usage: %s <built-app> <app-destination> [readiness-executable] [installed-smoke-port]\n' "$0" >&2
  exit 2
fi

built_app=$1
app_path=$2
readiness_executable=${3:-}
installed_smoke_port=${4:-}
case "$installed_smoke_port" in
  "") ;;
  *[!0-9]*) printf '%s\n' "Invalid installed smoke port." >&2; exit 2 ;;
  *)
  if [ "$installed_smoke_port" -lt 1 ] || [ "$installed_smoke_port" -gt 65535 ]; then
    printf '%s\n' "Invalid installed smoke port." >&2
    exit 2
  fi
  ;;
esac

if [ ! -x "$built_app/Contents/MacOS/placekeeper" ] || \
   [ ! -x "$built_app/Contents/MacOS/droplet" ] || \
   [ ! -x "$built_app/Contents/MacOS/placekeeper-chrome-host" ] || \
   [ ! -x "$built_app/Contents/Resources/node/bin/node" ] || \
   [ ! -f "$built_app/Contents/Resources/service/main.js" ] || \
   [ ! -f "$built_app/Contents/Resources/integrations/chrome-extension/manifest.json" ]; then
  printf '%s\n' "The built app is incomplete; live destinations were not changed." >&2
  exit 1
fi
case "$app_path" in */Placekeeper.app) ;; *) printf 'Refusing unexpected app destination: %s\n' "$app_path" >&2; exit 1 ;; esac

tmp_root=${TMPDIR:-/tmp}
case "$tmp_root" in /*) ;; *) tmp_root=/tmp ;; esac
transaction_dir=$(/usr/bin/mktemp -d "$tmp_root/placekeeper-replace.XXXXXX")
committed=0
had_app=0
app_touched=0
had_chrome_extension=0
chrome_extension_touched=0
readiness_started=0
had_chrome_manifest=0
chrome_manifest_touched=0
readiness_receipt="$transaction_dir/candidate-ready.json"
user_home=${PLACEKEEPER_USER_HOME:-"$HOME"}
chrome_manifest_dir="$user_home/Library/Application Support/Google/Chrome/NativeMessagingHosts"
chrome_manifest_path="$chrome_manifest_dir/com.placekeeper.chrome.json"
chrome_extension_path="$(/usr/bin/dirname -- "$app_path")/Placekeeper Chrome Extension"
chrome_extension_marker="$chrome_extension_path/.placekeeper-managed-extension"
chrome_extension_owner="com.placekeeper.chrome"

ensure_secure_directory() {
  directory=$1
  if [ -L "$directory" ]; then
    printf 'Refusing symbolic-link Chrome registration directory: %s\n' "$directory" >&2
    exit 1
  fi
  if [ ! -e "$directory" ]; then
    /bin/mkdir -m 700 "$directory"
  fi
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then
    printf 'Refusing invalid Chrome registration directory: %s\n' "$directory" >&2
    exit 1
  fi
  directory_owner=$(/usr/bin/stat -f '%u' "$directory")
  directory_mode=$(/usr/bin/stat -f '%Lp' "$directory")
  if [ "$directory_owner" -ne "$(/usr/bin/id -u)" ] || [ $((0$directory_mode & 022)) -ne 0 ]; then
    printf 'Refusing insecure Chrome registration directory: %s\n' "$directory" >&2
    exit 1
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rollback_safe=1
  if [ "$committed" -ne 1 ]; then
    # Never restore the old bundle while a daemon from the candidate may still
    # resolve code or assets through the installed path. The readiness receipt
    # binds this stop to the exact candidate process started by this transaction.
    if [ "$readiness_started" -eq 1 ]; then
      if [ -n "$installed_smoke_port" ]; then
        stop_status=0
        "$readiness_executable" daemon stop-ready --receipt "$readiness_receipt" --isolated-installed-smoke --http-port "$installed_smoke_port" >/dev/null || stop_status=$?
      else
        stop_status=0
        "$readiness_executable" daemon stop-ready --receipt "$readiness_receipt" >/dev/null || stop_status=$?
      fi
      if [ "$stop_status" -ne 0 ]; then
        printf '%s\n' "Candidate retirement failed; preserving the transaction and installed candidate." >&2
        rollback_safe=0
        status=1
      fi
    fi
    if [ "$rollback_safe" -eq 1 ]; then
      if [ "$app_touched" -eq 1 ] && [ -e "$app_path" ]; then
        /bin/mv "$app_path" "$transaction_dir/failed.app" || status=1
      fi
      if [ "$had_app" -eq 1 ] && [ -e "$transaction_dir/previous.app" ]; then
        /bin/mv "$transaction_dir/previous.app" "$app_path" || status=1
      fi
      if [ "$chrome_extension_touched" -eq 1 ] && [ -e "$chrome_extension_path" ]; then
        /bin/mv "$chrome_extension_path" "$transaction_dir/failed-chrome-extension" || status=1
      fi
      if [ "$had_chrome_extension" -eq 1 ] && [ -e "$transaction_dir/previous-chrome-extension" ]; then
        /bin/mv "$transaction_dir/previous-chrome-extension" "$chrome_extension_path" || status=1
      fi
      if [ "$chrome_manifest_touched" -eq 1 ]; then
        if [ -e "$chrome_manifest_path" ]; then /bin/rm -f "$chrome_manifest_path" || status=1; fi
        if [ "$had_chrome_manifest" -eq 1 ] && [ -e "$transaction_dir/previous-chrome-manifest.json" ]; then
          /bin/mv "$transaction_dir/previous-chrome-manifest.json" "$chrome_manifest_path" || status=1
        fi
      fi
    fi
  fi
  if [ "$rollback_safe" -eq 1 ]; then
    case "$transaction_dir" in
      "$tmp_root"/placekeeper-replace.*)
        if [ -d "$transaction_dir" ]; then /bin/rm -rf "$transaction_dir"; fi
        ;;
      *)
        printf 'Refusing to clean unexpected transaction directory: %s\n' "$transaction_dir" >&2
        status=1
        ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The candidate itself validates the coupled extension, wrapper, identity,
# origin and protocol range before either installed endpoint changes.
"$built_app/Contents/Resources/node/bin/node" \
  "$built_app/Contents/Resources/service/main.js" \
  chrome-registration render \
  --candidate-app "$built_app" \
  --installed-app "$app_path" \
  --output "$transaction_dir/staged-chrome-manifest.json"

/bin/mkdir -p "$(/usr/bin/dirname -- "$app_path")"
/usr/bin/ditto "$built_app" "$transaction_dir/staged.app"
/usr/bin/ditto \
  "$built_app/Contents/Resources/integrations/chrome-extension" \
  "$transaction_dir/staged-chrome-extension"
printf '%s\n' "$chrome_extension_owner" > "$transaction_dir/staged-chrome-extension/.placekeeper-managed-extension"
if [ -L "$chrome_extension_path" ] || { [ -e "$chrome_extension_path" ] && [ ! -d "$chrome_extension_path" ]; }; then
  printf 'Refusing invalid Chrome extension destination: %s\n' "$chrome_extension_path" >&2
  exit 1
fi
if [ -e "$chrome_extension_path" ]; then
  legacy_extension="$app_path/Contents/Resources/integrations/chrome-extension"
  if [ -f "$chrome_extension_marker" ] && [ ! -L "$chrome_extension_marker" ] && \
     [ "$(/bin/cat "$chrome_extension_marker")" = "$chrome_extension_owner" ]; then
    : # A prior managed version may predate the candidate's extension schema.
  elif [ -d "$legacy_extension" ] && /usr/bin/diff -qr "$chrome_extension_path" "$legacy_extension" >/dev/null; then
    : # Adopt the one pre-marker release only when its complete tree matches the installed bundle.
  else
    printf 'Refusing unmanaged Chrome extension destination: %s\n' "$chrome_extension_path" >&2
    exit 1
  fi
fi
if [ -e "$app_path" ]; then
  had_app=1
  /bin/mv "$app_path" "$transaction_dir/previous.app"
fi
app_touched=1
/bin/mv "$transaction_dir/staged.app" "$app_path"
if [ -e "$chrome_extension_path" ]; then
  had_chrome_extension=1
  /bin/mv "$chrome_extension_path" "$transaction_dir/previous-chrome-extension"
  if [ "${PLACEKEEPER_TEST_INTERRUPT_AFTER_CHROME_EXTENSION_BACKUP:-0}" = 1 ]; then
    /bin/kill -TERM "$$"
  fi
fi
chrome_extension_touched=1
/bin/mv "$transaction_dir/staged-chrome-extension" "$chrome_extension_path"
/bin/chmod -R go-w "$chrome_extension_path"

ensure_secure_directory "$user_home"
chrome_parent=$user_home
for chrome_component in "Library" "Application Support" "Google" "Chrome" "NativeMessagingHosts"; do
  chrome_parent="$chrome_parent/$chrome_component"
  ensure_secure_directory "$chrome_parent"
done
/bin/chmod 700 "$chrome_manifest_dir"
if [ -e "$chrome_manifest_path" ]; then
  had_chrome_manifest=1
  /bin/mv "$chrome_manifest_path" "$transaction_dir/previous-chrome-manifest.json"
fi
chrome_manifest_touched=1
/bin/mv "$transaction_dir/staged-chrome-manifest.json" "$chrome_manifest_path"
/bin/chmod 600 "$chrome_manifest_path"

# Keep the previous bundle inside the transaction until the newly installed
# launcher has started and handshaken with its exact daemon build. A readiness
# failure therefore follows the same rollback path as any other partial install.
if [ -n "$readiness_executable" ]; then
  case "$readiness_executable" in
    "$app_path"/Contents/MacOS/placekeeper) ;;
    *) printf 'Refusing unexpected readiness executable: %s\n' "$readiness_executable" >&2; exit 1 ;;
  esac
  readiness_started=1
  if [ -n "$installed_smoke_port" ]; then
    "$readiness_executable" daemon ensure-ready --receipt "$readiness_receipt" --isolated-installed-smoke --http-port "$installed_smoke_port"
  else
    "$readiness_executable" daemon ensure-ready --receipt "$readiness_receipt"
  fi
fi

committed=1
