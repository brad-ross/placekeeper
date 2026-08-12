#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH

if [ "$#" -ne 3 ] && [ "$#" -ne 4 ]; then
  printf 'Usage: %s <built-app> <app-destination> <obsolete-quick-action> [readiness-executable]\n' "$0" >&2
  exit 2
fi

built_app=$1
app_path=$2
obsolete_action=$3
readiness_executable=${4:-}

if [ ! -x "$built_app/Contents/MacOS/pdf-proofreader" ] || [ ! -x "$built_app/Contents/MacOS/droplet" ]; then
  printf '%s\n' "The built app is incomplete; live destinations were not changed." >&2
  exit 1
fi
case "$app_path" in */PDF\ Proofreader.app) ;; *) printf 'Refusing unexpected app destination: %s\n' "$app_path" >&2; exit 1 ;; esac
case "$obsolete_action" in */PDF\ Proofreader.workflow) ;; *) printf 'Refusing unexpected legacy Quick Action: %s\n' "$obsolete_action" >&2; exit 1 ;; esac

tmp_root=${TMPDIR:-/tmp}
case "$tmp_root" in /*) ;; *) tmp_root=/tmp ;; esac
transaction_dir=$(/usr/bin/mktemp -d "$tmp_root/pdf-proofreader-replace.XXXXXX")
committed=0
had_app=0
app_touched=0
action_removed=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" -ne 1 ]; then
    if [ "$action_removed" -eq 1 ] && [ -e "$transaction_dir/previous.workflow" ]; then
      /bin/mv "$transaction_dir/previous.workflow" "$obsolete_action" || status=1
    fi
    if [ "$app_touched" -eq 1 ] && [ -e "$app_path" ]; then
      /bin/mv "$app_path" "$transaction_dir/failed.app" || status=1
    fi
    if [ "$had_app" -eq 1 ] && [ -e "$transaction_dir/previous.app" ]; then
      /bin/mv "$transaction_dir/previous.app" "$app_path" || status=1
    fi
  fi
  case "$transaction_dir" in
    "$tmp_root"/pdf-proofreader-replace.*)
      if [ -d "$transaction_dir" ]; then /bin/rm -rf "$transaction_dir"; fi
      ;;
    *)
      printf 'Refusing to clean unexpected transaction directory: %s\n' "$transaction_dir" >&2
      status=1
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/bin/mkdir -p "$(/usr/bin/dirname -- "$app_path")"
/usr/bin/ditto "$built_app" "$transaction_dir/staged.app"
if [ -e "$app_path" ]; then
  had_app=1
  /bin/mv "$app_path" "$transaction_dir/previous.app"
fi
app_touched=1
/bin/mv "$transaction_dir/staged.app" "$app_path"

if [ -e "$obsolete_action" ]; then
  action_removed=1
  /bin/mv "$obsolete_action" "$transaction_dir/previous.workflow"
fi

# Keep the previous bundle inside the transaction until the newly installed
# launcher has started and handshaken with its exact daemon build. A readiness
# failure therefore follows the same rollback path as any other partial install.
if [ -n "$readiness_executable" ]; then
  case "$readiness_executable" in
    "$app_path"/Contents/MacOS/pdf-proofreader) ;;
    *) printf 'Refusing unexpected readiness executable: %s\n' "$readiness_executable" >&2; exit 1 ;;
  esac
  "$readiness_executable" daemon ensure-ready
fi

committed=1
