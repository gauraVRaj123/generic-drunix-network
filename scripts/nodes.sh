#!/usr/bin/env bash
# nodes up|down|status [orderers|monitoring|<org>...]   |   nodes reset-lp <org> <lpN>
# Starts/stops the ordering service, the peer groups and the monitoring stack.
# With no target everything defined in network.yaml is handled; in multi-host mode
# pass only the targets that run on this machine.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd docker jq
need_model
action="${1:-up}"; shift || true

# reset-lp <org> <lpN>: recover a lite peer stuck in a crash/restart loop (e.g. "no such block number
# in index" after the known LP crash). Drops that LP's ledger volume, starts it again and re-joins it to
# its channels. Chaincode must be installed on it again afterwards ('chaincode install').
if [ "$action" = reset-lp ]; then
  org="$(resolve_org "${1:?usage: nodes reset-lp <org> <lpN>}")"; lp="${2:?usage: nodes reset-lp <org> <lpN>}"
  read -r container volume < <(m --arg o "$org" --arg i "$lp" '.orgs[] | select(.name==$o) | .nodes[] | select(.id==$i and .role=="lp") | "\(.container) \(.data_volume)"')
  [ -n "${container:-}" ] || fatalln "$org has no lite peer '$lp'"
  infoln "resetting $container"
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  "$0" up "$org"
  idx="${lp#lp}"
  for ch in $(channel_names); do
    channel_orgs "$ch" | grep -qx "$org" || continue
    channel_peers "$ch" "$org" | grep -qx "lp $idx" || continue
    "$(dirname "$0")/channel.sh" join "$ch" "$org"
  done
  okln "$container reset - re-install chaincode on it: ./drunix-net.sh chaincode install --channel <ch> --name <cc> --org $org"
  exit 0
fi
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(orderers); mapfile -t more < <(org_names); targets+=("${more[@]}")
  [ "$(m '.monitoring.enabled')" = "true" ] && targets+=(monitoring)
fi

docker network inspect "$(DOCKER_NET)" >/dev/null 2>&1 || docker network create "$(DOCKER_NET)" >/dev/null
export DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"

compose_for() {  # compose_for <target> -> "<project> <file>"
  case "$1" in
    orderers)   echo "$(m .name)-orderers $GEN/compose/orderers.yaml";;
    monitoring) echo "$(m .name)-monitoring $GEN/compose/monitoring.yaml";;
    *) local o; o="$(resolve_org "$1")"; echo "$(m .name)-${o,,} $GEN/compose/org-${o,,}.yaml";;
  esac
}

check_crypto() {
  case "$1" in
    orderers) [ -d "$(org_dir "$(ORDERER_ORG)")/orderers" ] || fatalln "orderer crypto missing - run './drunix-net.sh enroll'";;
    monitoring) :;;
    *) [ -d "$(org_dir "$(resolve_org "$1")")/peers" ] || fatalln "crypto for $1 missing - run './drunix-net.sh enroll'";;
  esac
}

for t in "${targets[@]}"; do
  read -r project file < <(compose_for "$t")
  case "$action" in
    up)
      check_crypto "$t"
      [ "$t" = monitoring ] && ensure_secret grafana-admin
      infoln "starting $t"
      docker compose -p "$project" -f "$file" up -d 2>&1 | grep -vE "Container .* (Creating|Created|Starting|Running|Waiting)$" || true
      ;;
    down)
      infoln "stopping $t (volumes are kept)"
      docker compose -p "$project" -f "$file" down 2>&1 | grep -vE "Container .* (Stopping|Stopped|Removing|Removed)$|Network" || true
      ;;
    status)
      infoln "$t"
      docker compose -p "$project" -f "$file" ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
      ;;
    *) fatalln "usage: nodes up|down|status [orderers|monitoring|<org>...]";;
  esac
done
