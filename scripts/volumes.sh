#!/usr/bin/env bash
# volumes list | remove <name>... | remove --all
# Docker volumes of this network (every volume named <network.name>_*): peer ledgers, YugabyteDB, KeyDB,
# orderer data, CAs, monitoring. Removing one deletes its data for good, so a volume that a container still
# uses is refused - stop the containers first (nodes down / ca down).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd docker jq; need_model
net="$(m .name)"

list_vols() { docker volume ls -q --filter "name=^${net}_" | sort; }
used_by()   { docker ps -a --filter "volume=$1" --format '{{.Names}}' | paste -sd, -; }

case "${1:-}" in
  list)   # one line per volume: <name><TAB><containers using it, or empty>
    while read -r v; do [ -n "$v" ] && printf '%s\t%s\n' "$v" "$(used_by "$v")"; done < <(list_vols)
    ;;
  remove)
    shift; [ $# -ge 1 ] || fatalln "usage: volumes remove <name>... | --all"
    if [ "$1" = "--all" ]; then mapfile -t names < <(list_vols); else names=("$@"); fi
    removed=0; refused=0
    for v in "${names[@]}"; do
      list_vols | grep -Fxq -- "$v" || { errorln "'$v' is not a volume of network '$net'"; refused=$((refused+1)); continue; }
      by="$(used_by "$v")"
      if [ -n "$by" ]; then errorln "$v is in use by: $by (stop it first)"; refused=$((refused+1)); continue; fi
      docker volume rm "$v" >/dev/null && { okln "removed volume $v"; removed=$((removed+1)); }
    done
    infoln "$removed removed, $refused refused"
    [ "$refused" -eq 0 ] || exit 1
    ;;
  *) fatalln "usage: volumes list | remove <name>... | remove --all";;
esac
