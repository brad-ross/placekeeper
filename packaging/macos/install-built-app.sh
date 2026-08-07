#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH

if [ "$#" -ne 3 ]; then
  printf 'Usage: %s <built-app> <app-destination> <quick-action-destination>\n' "$0" >&2
  exit 2
fi

built_app=$1
app_path=$2
quick_action=$3
built_action="$built_app/Contents/Library/Services/PDF Proofreader.workflow"

if [ ! -x "$built_app/Contents/MacOS/pdf-proofreader" ] || [ ! -d "$built_action" ]; then
  printf '%s\n' "The built app is incomplete; live destinations were not changed." >&2
  exit 1
fi
case "$app_path" in */PDF\ Proofreader.app) ;; *) printf 'Refusing unexpected app destination: %s\n' "$app_path" >&2; exit 1 ;; esac
case "$quick_action" in */PDF\ Proofreader.workflow) ;; *) printf 'Refusing unexpected Quick Action destination: %s\n' "$quick_action" >&2; exit 1 ;; esac

tmp_root=${TMPDIR:-/tmp}
case "$tmp_root" in /*) ;; *) tmp_root=/tmp ;; esac
transaction_dir=$(/usr/bin/mktemp -d "$tmp_root/pdf-proofreader-replace.XXXXXX")
committed=0
had_app=0
had_action=0
app_touched=0
action_touched=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" -ne 1 ]; then
    if [ "$action_touched" -eq 1 ] && [ -e "$quick_action" ]; then
      /bin/mv "$quick_action" "$transaction_dir/failed.workflow" || status=1
    fi
    if [ "$had_action" -eq 1 ] && [ -e "$transaction_dir/previous.workflow" ]; then
      /bin/mv "$transaction_dir/previous.workflow" "$quick_action" || status=1
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
/bin/mkdir -p "$(/usr/bin/dirname -- "$quick_action")"
if [ -e "$app_path" ]; then
  had_app=1
  /bin/mv "$app_path" "$transaction_dir/previous.app"
fi
app_touched=1
/usr/bin/ditto "$built_app" "$app_path"

if [ -e "$quick_action" ]; then
  had_action=1
  /bin/mv "$quick_action" "$transaction_dir/previous.workflow"
fi
action_touched=1
/usr/bin/ditto "$built_action" "$quick_action"

committed=1
