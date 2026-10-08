#!/usr/bin/env bash
# chaincode install --channel C --name N [--version 1.0] [--org X]
# Installs the package on every LITE peer of the channel's member orgs (CPs refuse installs).
set -euo pipefail
. "$(dirname "$0")/../../lib/common.sh"
require_cmd peer jq; need_model
F_version=1.0
parse_flags "channel name version org" -- "$@"
: "${F_channel:?--channel is required}"; : "${F_name:?--name is required}"
pkg="$CC_DIST/${F_name}_${F_version}.tar.gz"
[ -f "$pkg" ] || fatalln "$pkg not found - run 'chaincode package' first"

for org in $(channel_orgs "$F_channel"); do
  [ -n "${F_org:-}" ] && [ "${org,,}" != "${F_org,,}" ] && continue
  while read -r role idx; do
    [ "$role" = lp ] || continue
    peer_env "$org" lp "$idx"
    infoln "installing ${F_name}_${F_version} on lp$idx of $org"
    ok=false
    for attempt in 1 2 3; do
      out="$(peer lifecycle chaincode install "$pkg" 2>&1)" && { ok=true; break; }
      grep -q "already successfully installed" <<<"$out" && { ok=true; break; }
      warnln "attempt $attempt failed, retrying"; sleep 5
    done
    $ok || { echo "$out" >&2; fatalln "install failed on lp$idx of $org"; }
  done < <(channel_peers "$F_channel" "$org")
done
okln "installed ${F_name}_${F_version}"
