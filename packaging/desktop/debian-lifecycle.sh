#!/bin/sh
# dpkg owns the compressed payload and bootstrap only. Materialized versions
# stay outside its file list, including during removal and purge.
set -eu
if [ "$(id -u)" != 0 ]; then echo 'Runtime staging requires root' >&2; exit 1; fi
case "${1:-}" in
  remove|purge|deconfigure)
    echo 'Placekeeper runtime versions in /opt/placekeeper/runtimes are retained for active sessions and recovery. After all users close Placekeeper, an administrator may remove that directory and /opt/placekeeper/available. User documents, settings and recovery data are never removed.' >&2
    exit 0 ;;
  configure) ;;
  *) exit 0 ;;
esac
payload=/usr/lib/placekeeper/payload
store=/opt/placekeeper/runtimes
identity=$(cat "$payload/identity")
case "$identity" in *[!a-f0-9]*|'') echo 'Invalid runtime identity' >&2; exit 1;; esac
[ "${#identity}" = 64 ] || exit 1
# Refuse redirected or writable ancestors, including an existing marker.
for path in /opt /opt/placekeeper "$store"; do
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then mkdir "$path"; chmod 755 "$path"; fi
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(stat -c %u "$path")" = 0 ] || exit 1
  [ -z "$(find "$path" -maxdepth 0 -perm /022 -print)" ] || exit 1
done
if [ -e /opt/placekeeper/available ] || [ -L /opt/placekeeper/available ]; then
  [ -f /opt/placekeeper/available ] && [ ! -L /opt/placekeeper/available ] && [ "$(stat -c %u /opt/placekeeper/available)" = 0 ] || exit 1
  [ -z "$(find /opt/placekeeper/available -maxdepth 0 -perm /022 -print)" ] || exit 1
fi
(cd "$payload" && sha256sum -c runtime.tar.gz.sha256)
version="$store/$identity"
stage=''
marker=''
trap '[ -z "$stage" ] || rm -rf -- "$stage"; [ -z "$marker" ] || rm -f -- "$marker"' EXIT HUP INT TERM
if [ ! -e "$version" ] && [ ! -L "$version" ]; then
  stage=$(mktemp -d "$store/.staging-XXXXXXXX")
  # Payload archives are produced without links/devices. Reject them before any
  # privileged extraction, as well as absolute paths and parent traversal.
  tar -tzf "$payload/runtime.tar.gz" | awk '/^\// || /(^|\/)\.\.($|\/)/ {exit 1}'
  tar -tvzf "$payload/runtime.tar.gz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}'
  tar --no-same-owner --no-same-permissions -xzf "$payload/runtime.tar.gz" -C "$stage"
  chmod 755 "$stage"
  chown -R 0:0 "$stage"
  chmod -R go-w "$stage"
  [ -f "$stage/chrome-sandbox" ] && [ ! -L "$stage/chrome-sandbox" ] || exit 1
  chmod 4755 "$stage/chrome-sandbox"
  options=$(findmnt -n -o OPTIONS -T "$stage/chrome-sandbox")
  case ",$options," in *,noexec,*|*,nosuid,*) echo 'Placekeeper requires an executable, SUID-capable runtime filesystem; ask an administrator to relocate it. The sandbox cannot be disabled.' >&2; exit 1;; esac
  printf '%s\n' "$identity" > "$stage/.complete"
  chmod 644 "$stage/.complete"
  # A competing or interrupted installation never replaces an existing version.
  [ ! -e "$version" ] && [ ! -L "$version" ] || exit 1
  mv -T "$stage" "$version"
  stage=''
fi
[ -d "$version" ] && [ ! -L "$version" ] && [ -f "$version/.complete" ] && [ ! -L "$version/.complete" ] || exit 1
[ "$(cat "$version/.complete")" = "$identity" ] || exit 1
[ -z "$(find "$version" \( ! -user root -o -perm /022 -o -type l \) -print -quit)" ] || exit 1
[ "$(stat -c %a "$version/chrome-sandbox")" = 4755 ] || exit 1
options=$(findmnt -n -o OPTIONS -T "$version/chrome-sandbox")
case ",$options," in *,noexec,*|*,nosuid,*) echo 'Runtime filesystem does not permit the sandbox' >&2; exit 1;; esac
marker=$(mktemp /opt/placekeeper/.available-XXXXXXXX)
printf '%s\n' "$identity" > "$marker"
chmod 644 "$marker"
mv -T "$marker" /opt/placekeeper/available
marker=''
