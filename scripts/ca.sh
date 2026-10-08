#!/usr/bin/env bash
# ca up|down [org...]   - start/stop the Fabric CAs (all, or only the named orgs)
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd docker jq
need_model
action="${1:-up}"; shift || true
orgs=("$@"); [ ${#orgs[@]} -eq 0 ] && mapfile -t orgs < <(all_ca_orgs)

docker network inspect "$(DOCKER_NET)" >/dev/null 2>&1 || docker network create "$(DOCKER_NET)" >/dev/null

for o in "${orgs[@]}"; do
  [ "$o" = "$(ORDERER_ORG)" ] || o="$(resolve_org "$o")"
  f="$GEN/compose/ca-${o,,}.yaml"
  mkdir -p "$ORGS_DIR/fabric-ca/${o,,}"
  case "$action" in
    up)
      [ -s "$(secret_file "ca-${o,,}")" ] || fatalln "secrets missing - run './drunix-net.sh secrets init'"
      infoln "starting CA for $o"
      docker compose -p "$(m .name)-ca-${o,,}" -f "$f" up -d >/dev/null
      ;;
    down)
      docker compose -p "$(m .name)-ca-${o,,}" -f "$f" down >/dev/null
      ;;
    *) fatalln "usage: ca up|down [org...]";;
  esac
done
if [ "$action" = up ]; then
  for o in "${orgs[@]}"; do
    [ "$o" = "$(ORDERER_ORG)" ] || o="$(resolve_org "$o")"
    p="$(ca_port "$o")"; h="$(ca_host "$o")"
    wait_for_port "$h" "$p" 90 || fatalln "CA for $o did not become reachable on $h:$p"
    okln "CA $o ready on $h:$p"
  done
fi
