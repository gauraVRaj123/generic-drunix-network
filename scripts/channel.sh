#!/usr/bin/env bash
# channel create <name> | join <name> [org] | list [org] | info <name> [org]
# create: builds the genesis block from the channel's profile, joins every orderer through the
#         channel-participation API, then joins each member org's peers (anchor peers come from the profile).
# join:   (re)joins peers - e.g. after adding more peers to an org.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd configtxgen osnadmin peer jq
need_model
action="${1:-}"; shift || true

orderer_admin_cert() { echo "$(org_dir "$(ORDERER_ORG)")/orderers/$1/tls"; }

create_block() {
  local ch="$1" profile
  profile="$(m --arg c "$ch" '.channels[] | select(.name==$c) | .profile')"
  mkdir -p "$ARTIFACTS"
  FABRIC_CFG_PATH="$GEN/configtx" configtxgen -profile "$profile" -channelID "$ch" \
    -outputBlock "$ARTIFACTS/$ch.block" >/dev/null 2>&1 \
    || { FABRIC_CFG_PATH="$GEN/configtx" configtxgen -profile "$profile" -channelID "$ch" -outputBlock "$ARTIFACTS/$ch.block"; fatalln "genesis block failed"; }
  okln "genesis block channel-artifacts/$ch.block"
}

join_orderers() {
  local ch="$1" id host addr aport tls
  while read -r id host addr aport; do
    tls="$(orderer_admin_cert "$host")"
    infoln "joining $id to $ch"
    local out rc=0
    for _ in 1 2 3 4 5 6; do
      out="$(osnadmin channel join --channelID "$ch" --config-block "$ARTIFACTS/$ch.block" \
        -o "$addr:$aport" --ca-file "$tls/ca.crt" --client-cert "$tls/server.crt" --client-key "$tls/server.key" 2>&1)" && { rc=0; break; } || rc=$?
      grep -q "already exists" <<<"$out" && { rc=0; break; }
      sleep 3
    done
    [ $rc -eq 0 ] || { echo "$out" >&2; fatalln "$id could not join $ch"; }
  done < <(m '.orderer_org.orderers[] | "\(.id) \(.host) \(.address) \(.admin_port)"')
}

join_peers() {
  local ch="$1" only="${2:-}" org role idx
  for org in $(channel_orgs "$ch"); do
    [ -n "$only" ] && [ "${org,,}" != "${only,,}" ] && continue
    while read -r role idx; do
      peer_env "$org" "$role" "$idx"
      infoln "joining $role$idx of $org to $ch"
      local out rc=0
      for _ in 1 2 3 4 5; do
        out="$(peer channel join -b "$ARTIFACTS/$ch.block" 2>&1)" && { rc=0; break; } || rc=$?
        grep -qi "already exists" <<<"$out" && { rc=0; break; }
        sleep 3
      done
      [ $rc -eq 0 ] || { echo "$out" >&2; fatalln "$role$idx of $org could not join $ch"; }
    done < <(channel_peers "$ch" "$org")
  done
}

case "$action" in
  create)
    ch="${1:?usage: channel create <name>}"; channel_exists "$ch" || fatalln "channel '$ch' is not defined in network.yaml (add it, then 'generate')"
    create_block "$ch"; join_orderers "$ch"; join_peers "$ch"
    okln "channel $ch is up with $(channel_orgs "$ch" | tr '\n' ' ')"
    ;;
  join)
    ch="${1:?usage: channel join <name> [org]}"; channel_exists "$ch" || fatalln "unknown channel '$ch'"
    [ -f "$ARTIFACTS/$ch.block" ] || create_block "$ch"
    join_peers "$ch" "${2:-}"
    ;;
  list)
    for org in $( [ -n "${1:-}" ] && resolve_org "$1" || org_names ); do
      peer_env "$org" cp 1; echo "== $org ($PEER_HOST)"; peer channel list 2>&1 | grep -v "^20" || true
    done
    ;;
  info)
    ch="${1:?usage: channel info <name> [org]}"; org="$(resolve_org "${2:-$(channel_orgs "$ch" | head -n1)}")"
    peer_env "$org" cp 1; peer channel getinfo -c "$ch" 2>&1 | grep -v "^20"
    ;;
  *) fatalln "usage: channel create|join|list|info ...";;
esac
