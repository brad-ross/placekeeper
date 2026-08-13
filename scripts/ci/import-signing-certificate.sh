#!/bin/sh
set -eu
umask 077

: "${CERTIFICATE_P12:?MACOS_CERTIFICATE_P12 is required}"
: "${CERTIFICATE_PASSWORD:?MACOS_CERTIFICATE_PASSWORD is required}"
: "${KEYCHAIN_PASSWORD:?MACOS_KEYCHAIN_PASSWORD is required}"

certificate_path="${RUNNER_TEMP}/placekeeper-signing.p12"
keychain_path="${RUNNER_TEMP}/placekeeper-signing.keychain-db"
trap '/bin/rm -f "$certificate_path"' EXIT

/bin/echo "$CERTIFICATE_P12" | /usr/bin/base64 -D -o "$certificate_path"
/usr/bin/security create-keychain -p "$KEYCHAIN_PASSWORD" "$keychain_path"
/usr/bin/security set-keychain-settings -lut 21600 "$keychain_path"
/usr/bin/security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain_path"
/usr/bin/security import "$certificate_path" -P "$CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain_path"
/usr/bin/security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$keychain_path"
/usr/bin/security list-keychains -d user -s "$keychain_path" login.keychain-db
