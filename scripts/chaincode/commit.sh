#!/usr/bin/env bash
# chaincode commit --channel C --name N [--version 1.0] [--sequence N|auto] [--policy EXPR] [--init-required]
# Checks commit readiness, then commits the definition once enough orgs have approved.
set -euo pipefail
. "$(dirname "$0")/../../lib/common.sh"
require_cmd peer jq; need_model
F_version=1.0; F_sequence=auto
parse_flags "channel name version sequence policy init_required" -- "$@"
: "${F_channel:?--channel is required}"; : "${F_name:?--name is required}"
first_org="$(channel_orgs "$F_channel" | head -n1)"
[ "$F_sequence" = auto ] && F_sequence=$(( $(committed_sequence "$F_channel" "$F_name" "$first_org") + 1 ))

peer_env "$first_org" cp 1
args=(--channelID "$F_channel" --name "$F_name" --version "$F_version" --sequence "$F_sequence")
[ -n "${F_policy:-}" ] && args+=(--signature-policy "$F_policy")
[ "${F_init_required:-}" = true ] && args+=(--init-required)

infoln "commit readiness"
peer lifecycle chaincode checkcommitreadiness "${args[@]}" --output json | jq -c '.approvals'
infoln "committing $F_name $F_version (sequence $F_sequence) on $F_channel"
# shellcheck disable=SC2046
peer lifecycle chaincode commit $(orderer_args) "${args[@]}" $(commit_peer_flags "$F_channel") >/dev/null 2>&1 \
  || { peer lifecycle chaincode commit $(orderer_args) "${args[@]}" $(commit_peer_flags "$F_channel"); fatalln "commit failed"; }
okln "committed"
peer lifecycle chaincode querycommitted -C "$F_channel" --name "$F_name" 2>&1 | tail -n 2
