#!/bin/sh
# Generated into a release asset; placeholders are never resolved at installation time.
set -eu
PLACEKEEPER_HOST_PATH=${PLACEKEEPER_HOST_PATH:-${PATH:-/usr/bin:/bin}}
export PLACEKEEPER_HOST_PATH
PATH=/usr/bin:/bin
export PATH
LC_ALL=C
export LC_ALL
version='@VERSION@'
commit='@COMMIT@'
source_url='@SOURCE_URL@'
expected_sha256='@SHA256@'
fail() { printf 'Placekeeper source install: %s\n' "$1" >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/placekeeper-source.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Installing Placekeeper %s (source %s)\n' "$version" "$commit"
curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 600 --retry 2 "$source_url" -o "$work/source.tar.gz" || fail 'Release download failed. Check your connection and retry.'
actual_sha256=$(shasum -a 256 "$work/source.tar.gz") || fail 'Unable to verify source archive.'
[ "${actual_sha256%% *}" = "$expected_sha256" ] || fail 'Source archive checksum mismatch. Retry or report the damaged release.'
tar -tzf "$work/source.tar.gz" > "$work/paths" || fail 'Invalid source archive.'
# Reject links entirely, including hard links, and all device/special entries.
tar -tvzf "$work/source.tar.gz" > "$work/types" || fail 'Invalid source archive.'
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }' "$work/types" || fail 'Unsafe archive entry type.'
awk '
  !/^placekeeper-source\// || /[^A-Za-z0-9_@.\/-]/ || /\/\.\.?($|\/)/ || /\/\// { exit 1 }
  seen[$0]++ { exit 1 }
  END { if (NR == 0) exit 1 }
' "$work/paths" || fail 'Unsafe source archive path.'
mkdir "$work/extracted"
tar -xzf "$work/source.tar.gz" -C "$work/extracted" --no-same-owner --no-same-permissions || fail 'Source extraction failed.'
root="$work/extracted/placekeeper-source"
printf 'schema=1\nversion=%s\ncommit=%s\n' "$version" "$commit" > "$work/expected-descriptor"
[ -f "$root/release-descriptor.txt" ] && cmp -s "$work/expected-descriptor" "$root/release-descriptor.txt" || fail 'Unsupported or mismatched source release descriptor.'
[ -f "$root/install.sh" ] || fail 'Release source installer is missing.'
# The source installer retains toolchain checks, lifecycle coordination, and exit outcomes.
/bin/sh "$root/install.sh" "$@"
