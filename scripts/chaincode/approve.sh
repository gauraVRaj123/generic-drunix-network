#!/usr/bin/env bash
# chaincode approve --channel C --name N [--version 1.0] [--sequence N|auto] [--org X] [--policy EXPR] [--init-required]
# Each organisation approves the definition for itself. Run it once per org (--org) - on that org's
# host in multi-host mode - or without --org to approve for every member org from this machine.
set -euo pipefail
. "$(dirname "$0")/../../lib/common.sh"
require_cmd peer jq; need_model
F_version=1.0; F_sequence=auto
parse_flags "channel name version sequence org policy init_required" -- "$@"
: "${F_channel:?--channel is required}"; : "${F_name:?--name is required}"
label="${F_name}_${F_version}"
first_org="$(channel_orgs "$F_channel" | head -n1)"
[ "$F_sequence" = auto ] && F_sequence=$(( $(committed_sequence "$F_channel" "$F_name" "$first_org") + 1 ))

for org in $(channel_orgs "$F_channel"); do
  [ -n "${F_org:-}" ] && [ "${org,,}" != "${F_org,,}" ] && continue
  peer_env "$org" lp 1
  pkgid="$(peer lifecycle chaincode queryinstalled --output json 2>/dev/null | jq -r --arg l "$label" '.installed_chaincodes[]? | select(.label==$l) | .package_id' | head -n1)"
  [ -n "$pkgid" ] || fatalln "$label is not installed on $org's lite peer - run 'chaincode install'"
  peer_env "$org" cp 1       # approvals are submitted through the (stable) committing peer
  args=(--channelID "$F_channel" --name "$F_name" --version "$F_version" --package-id "$pkgid" --sequence "$F_sequence")
  [ -n "${F_policy:-}" ] && args+=(--signature-policy "$F_policy")
  [ "${F_init_required:-}" = true ] && args+=(--init-required)
  infoln "$org approves $label (sequence $F_sequence)"
  # shellcheck disable=SC2046
  peer lifecycle chaincode approveformyorg $(orderer_args) "${args[@]}" >/dev/null 2>&1 \
    || { peer lifecycle chaincode approveformyorg $(orderer_args) "${args[@]}"; fatalln "approval failed for $org"; }
done
okln "approved (sequence $F_sequence)"
