#!/usr/bin/env bash
# chaincode <package|install|approve|commit|deploy|query|invoke|list> [flags]
#   query|invoke accept --user <name> to act as an enrolled application user instead of the org admin
# Each lifecycle step is its own script under scripts/chaincode/; `deploy` just runs them in order.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd jq; need_model
sub="${1:-}"; shift || true
D="$(dirname "$0")/chaincode"

case "$sub" in
  package|install|approve|commit) exec "$D/$sub.sh" "$@";;
  deploy)   # deploy --channel C --name N --path DIR [--version V] [--lang L] [--policy EXPR] [--sequence N]
    parse_flags "channel name path version lang policy sequence no_vendor init_required" -- "$@"
    : "${F_channel:?--channel}"; : "${F_name:?--name}"; : "${F_path:?--path}"
    F_version="${F_version:-1.0}"
    pk=(--name "$F_name" --path "$F_path" --version "$F_version"); [ -n "${F_lang:-}" ] && pk+=(--lang "$F_lang"); [ "${F_no_vendor:-}" = true ] && pk+=(--no-vendor)
    ap=(--channel "$F_channel" --name "$F_name" --version "$F_version")
    [ -n "${F_policy:-}" ] && ap+=(--policy "$F_policy"); [ -n "${F_sequence:-}" ] && ap+=(--sequence "$F_sequence"); [ "${F_init_required:-}" = true ] && ap+=(--init-required)
    "$D/package.sh" "${pk[@]}"
    "$D/install.sh" --channel "$F_channel" --name "$F_name" --version "$F_version"
    "$D/approve.sh" "${ap[@]}"
    "$D/commit.sh"  "${ap[@]}"
    ;;
  list)     # list --channel C [--org X]
    parse_flags "channel org" -- "$@"; : "${F_channel:?--channel}"
    for org in $(channel_orgs "$F_channel"); do
      [ -n "${F_org:-}" ] && [ "${org,,}" != "${F_org,,}" ] && continue
      peer_env "$org" cp 1; echo "== $org committed on $F_channel"
      peer lifecycle chaincode querycommitted -C "$F_channel" 2>&1 | grep -v "^20" || true
    done;;
  query|invoke)   # query|invoke --channel C --name N --fn F [--args '["a","b"]'] [--org X]
    parse_flags "channel name fn args org user" -- "$@"; [ -n "${F_user:-}" ] && export AS_USER="$F_user"; : "${F_channel:?--channel}"; : "${F_name:?--name}"; : "${F_fn:?--fn}"
    org="$(resolve_org "${F_org:-$(channel_orgs "$F_channel" | head -n1)}")"
    ctor="$(jq -cn --arg f "$F_fn" --argjson a "${F_args:-[]}" '{function:$f, Args:$a}')"
    peer_env "$org" lp 1
    if [ "$sub" = query ]; then peer chaincode query -C "$F_channel" -n "$F_name" -c "$ctor"
    else
      # endorse on lp1 of every channel org so MAJORITY/ALL policies are satisfied (--org only picks the signing identity's org)
      endorse=()
      for eo in $(channel_orgs "$F_channel"); do
        read -r ea et < <(AS_USER=Admin peer_env "$eo" lp 1 2>/dev/null; echo "$PEER_ADDR $CORE_PEER_TLS_ROOTCERT_FILE")
        endorse+=(--peerAddresses "$ea" --tlsRootCertFiles "$et")
      done
      peer_env "$org" lp 1
      # shellcheck disable=SC2046
      # LPs forward commits to their CP, so event wait may time out on extra peers even though the tx is VALID
      out="$(peer chaincode invoke $(orderer_args) -C "$F_channel" -n "$F_name" -c "$ctor" --waitForEvent "${endorse[@]}" 2>&1)" && rc=0 || rc=$?
      printf '%s\n' "$out"
      if [ "$rc" -ne 0 ] && grep -q "committed with status (VALID)" <<<"$out"; then
        echo "tx committed (VALID); ignoring event-wait timeout from additional peers"; rc=0
      fi
      exit "$rc"
    fi;;
  *) fatalln "usage: chaincode package|install|approve|commit|deploy|list|query|invoke ...";;
esac
