#!/usr/bin/env bash
# crypto export [org...] | import <tarball>...
# Multi-host helper: every host enrolls its own org (private keys never leave it) and exchanges only
# PUBLIC material - org MSP (cacerts, tlscacerts, config.yaml), tlsca, and orderer/peer TLS certs.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd tar jq; need_model
action="${1:-}"; shift || true
case "$action" in
  export)
    orgs=("$@"); [ ${#orgs[@]} -eq 0 ] && mapfile -t orgs < <(all_ca_orgs)
    mkdir -p "$ROOT/dist"
    for o in "${orgs[@]}"; do
      [ "$o" = "$(ORDERER_ORG)" ] || o="$(resolve_org "$o")"
      d="$(org_dir "$o")"; [ -d "$d" ] || fatalln "no crypto for $o"
      rel="${d#$ROOT/}"; out="$ROOT/dist/public-crypto-${o,,}.tar.gz"
      tmp="$(mktemp -d)"; mkdir -p "$tmp/$rel"
      mkdir -p "$tmp/$rel/msp"
      cp -r "$d/msp/cacerts" "$d/msp/tlscacerts" "$d/msp/config.yaml" "$tmp/$rel/msp/"
      cp -r "$d/tlsca" "$d/ca" "$tmp/$rel/"
      # server certificates only (never keys) - needed as raft consenter certs and peer TLS trust
      for sub in orderers peers; do
        for n in "$d/$sub"/*/; do [ -d "$n" ] || continue
          mkdir -p "$tmp/$rel/$sub/$(basename "$n")/tls"
          cp "$n/tls/ca.crt" "$n/tls/server.crt" "$tmp/$rel/$sub/$(basename "$n")/tls/"
        done
      done
      tar -C "$tmp" -czf "$out" "$rel"; rm -rf "$tmp"
      okln "public bundle for $o -> ${out#$ROOT/}"
    done
    ;;
  import)
    [ $# -ge 1 ] || fatalln "usage: crypto import <tarball>..."
    for t in "$@"; do tar -C "$ROOT" -xzf "$t"; okln "imported $t"; done
    ;;
  *) fatalln "usage: crypto export [org...] | import <tarball>...";;
esac
