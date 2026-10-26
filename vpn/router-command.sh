#!/bin/sh
# Forced-command endpoint for the dedicated LOST SSH key. No shell/eval input.
set -f
export PATH=/opt/bin:/opt/sbin:/usr/bin:/usr/sbin:/bin:/sbin
cli=/opt/bin/adguardvpn-cli
original=${SSH_ORIGINAL_COMMAND-}
fail() { echo 'Invalid LOST VPN command' >&2; exit 64; }
[ ${#original} -le 512 ] || fail
# Newlines, tabs and every other control character are forbidden even in arguments.
[ "$(printf '%s' "$original" | tr -d '[:cntrl:]')" = "$original" ] || fail
case "$original" in
 status) exec "$cli" status;;
 locations) exec "$cli" list-locations;;
 license) exec "$cli" license;;
 config)
  umask 077
  temp=$(mktemp /tmp/lost-vpn-config.XXXXXX) || exit 1
  trap 'rm -f "$temp"' EXIT HUP INT TERM
  "$cli" config show >"$temp" 2>/dev/null || exit 1
  sed -E '/[Pp]assword|[Uu]sername|[Tt]oken|[Ss]ecret|[Cc]redential/c\[СКРЫТО]' "$temp"
  exit $?;;
 guard) exec /opt/bin/agvpn-guard status;;
 version) exec "$cli" --version;;
 check-update) exec "$cli" check-update;;
 fastest) exec "$cli" connect --fastest -y;;
 last) exec "$cli" connect -y;;
 disconnect) exec "$cli" disconnect;;
 update) exec "$cli" update -y;;
 logout) exec "$cli" logout;;
 export-logs) umask 077; "$cli" export-logs -o /opt/var/log/lost-vpn-logs.zip -f >/dev/null 2>&1 || exit 1; chmod 600 /opt/var/log/lost-vpn-logs.zip; printf '%s\n' /opt/var/log/lost-vpn-logs.zip; exit 0;;
 'connect '*) location=${original#connect }; [ ${#location} -le 100 ] || fail; printf '%s\n' "$location" | grep -Eq "^[a-zA-Z0-9][a-zA-Z0-9 ()'.-]*$" || fail; exec "$cli" connect -l "$location" -y;;
 esac
# All remaining commands use fixed, whitespace-free tokens.
set -- $original
[ "$#" -ge 2 ] || fail
case "$1" in
 exclusions-show|exclusions-mode|exclusions-clear)
  [ "$#" -eq 2 ] || fail
  case "$2" in general|selective) ;; *) fail;; esac
  case "$1" in
   exclusions-show) exec "$cli" site-exclusions show --for-mode "$2";;
   exclusions-mode) exec "$cli" site-exclusions mode "$2";;
   exclusions-clear) exec "$cli" site-exclusions clear --for-mode "$2";;
  esac;;
 exclusions-add|exclusions-remove)
  [ "$#" -eq 3 ] || fail
  case "$2" in general|selective) ;; *) fail;; esac
  [ ${#3} -le 253 ] || fail
  printf '%s\n' "$3" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || fail
  case "$1" in exclusions-add) verb=add;; exclusions-remove) verb=remove;; esac
  exec "$cli" site-exclusions "$verb" "$3 *.$3" --for-mode "$2";;
 protocol)
  [ "$#" -eq 2 ] || fail; case "$2" in auto|http2|quic) exec "$cli" config set-protocol "$2";; *) fail;; esac;;
 setting)
  [ "$#" -eq 3 ] || fail
  name=$2; value=$3
  case "$name" in
   set-mode) case "$value" in TUN|SOCKS) ;; *) fail;; esac;;
   set-dns) [ ${#value} -le 253 ] || fail; printf '%s\n' "$value" | grep -Eq '^[a-zA-Z0-9][][a-zA-Z0-9.:/_%-]*$' || fail;;
   set-socks-port) printf '%s\n' "$value" | grep -Eq '^[0-9]{1,5}$' || fail; [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || fail;;
   set-socks-host) [ "$value" = localhost ] || { [ ${#value} -le 64 ] && printf '%s\n' "$value" | grep -Eq '^[][0-9a-fA-F:.]{2,64}$'; } || fail;;
   set-tun-routing-mode) case "$value" in AUTO|SCRIPT|NONE) ;; *) fail;; esac;;
   set-post-quantum|set-debug-logging|set-show-hints|set-show-notifications|set-change-system-dns|set-crash-reporting|set-telemetry) case "$value" in on|off) ;; *) fail;; esac;;
   set-update-channel) case "$value" in release|beta|nightly) ;; *) fail;; esac;;
   set-bound-if-override) [ ${#value} -le 32 ] || fail; printf '%s\n' "$value" | grep -Eq '^[a-zA-Z0-9_.:-]+$' || fail; [ "$value" != '-' ] || value=;;
   *) fail;;
  esac
  exec "$cli" config "$name" "$value";;
 *) fail;;
esac
fail
