#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH

if [ "$#" -ne 2 ] && [ "$#" -ne 3 ]; then
  printf 'Usage: %s <built-app> <app-destination> [readiness-executable]\n' "$0" >&2
  exit 2
fi

built_app=$1
app_path=$2
readiness_executable=${3:-}

if [ ! -x "$built_app/Contents/MacOS/placekeeper" ] || [ ! -x "$built_app/Contents/MacOS/droplet" ]; then
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
readiness_started=0
readiness_receipt="$transaction_dir/candidate-ready.json"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rollback_safe=1
  if [ "$committed" -ne 1 ]; then
    # Never restore the old bundle while a daemon from the candidate may still
    # resolve code or assets through the installed path. The readiness receipt
    # binds this stop to the exact candidate process started by this transaction.
    if [ "$readiness_started" -eq 1 ]; then
      if ! "$readiness_executable" daemon stop-ready --receipt "$readiness_receipt" >/dev/null; then
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

/bin/mkdir -p "$(/usr/bin/dirname -- "$app_path")"
/usr/bin/ditto "$built_app" "$transaction_dir/staged.app"
if [ -e "$app_path" ]; then
  had_app=1
  /bin/mv "$app_path" "$transaction_dir/previous.app"
fi
app_touched=1
/bin/mv "$transaction_dir/staged.app" "$app_path"

# Keep the previous bundle inside the transaction until the newly installed
# launcher has started and handshaken with its exact daemon build. A readiness
# failure therefore follows the same rollback path as any other partial install.
if [ -n "$readiness_executable" ]; then
  case "$readiness_executable" in
    "$app_path"/Contents/MacOS/placekeeper) ;;
    *) printf 'Refusing unexpected readiness executable: %s\n' "$readiness_executable" >&2; exit 1 ;;
  esac
  readiness_started=1
  "$readiness_executable" daemon ensure-ready --receipt "$readiness_receipt"
fi

committed=1
