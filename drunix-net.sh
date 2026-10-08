#!/usr/bin/env bash
# Drunix generic network manager. See README.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$ROOT/scripts"

usage() { cat <<'USAGE'
Usage: ./drunix-net.sh <command> [args]

Setup
  init [--force]                     wizard: asks for orgs, peers per org, channels -> network.yaml
  generate                           validate network.yaml, render compose/configtx/monitoring (generated/)
  secrets init|list|set <name>       create/inspect credentials (values are never printed)

Bring-up (each step also works on its own)
  ca up|down [org...]                Fabric CAs
  enroll [org...]                    register + enroll CA admin, org admins, peers, orderers (+TLS)
  nodes up|down|status [target...]   targets: orderers | <org> | monitoring (default: all)
  nodes reset-lp <org> <lpN>         recover a crash-looping lite peer
  up [--channels]                    generate -> secrets -> ca -> enroll -> nodes (-> channel create)
  channel create|join|list|info ...  channels (one genesis block + participation join per channel)

Identities and chaincode
  user add|list|revoke|remove ...    application users with a role attribute (revoke = CA, remove = local files)
  chaincode package|install|approve|commit|deploy|list|query|invoke ...

Multi-host
  crypto export [org...] | import <tar>...   exchange public certificates only

Operations
  status                             containers, channels
  down                               stop everything (data volumes are kept)
  destroy [--keep-volumes] [--keep-crypto] [--remove-secrets]
                                     remove the network; by default containers, volumes, crypto and artifacts, keeping secrets/
                                     (asks you to type the network name)
  volumes list|remove <name>|--all   Docker volumes of this network (refuses volumes still in use)
  secrets remove <name>|--all        delete credential files from secrets/
USAGE
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  init)      exec "$S/init.sh" "$@";;
  generate)  exec "$S/generate.sh" "$@";;
  secrets)   exec "$S/secrets.sh" "$@";;
  ca)        exec "$S/ca.sh" "$@";;
  enroll)    exec "$S/enroll-nodes.sh" "$@";;
  nodes)     exec "$S/nodes.sh" "$@";;
  channel)   exec "$S/channel.sh" "$@";;
  chaincode) exec "$S/chaincode.sh" "$@";;
  user)      exec "$S/users.sh" "$@";;
  volumes)   exec "$S/volumes.sh" "$@";;
  crypto)    exec "$S/crypto.sh" "$@";;
  up)
    "$S/generate.sh"; "$S/secrets.sh" init; "$S/ca.sh" up; "$S/enroll-nodes.sh"; "$S/nodes.sh" up
    if [ "${1:-}" = "--channels" ]; then
      . "$ROOT/lib/common.sh"; for ch in $(channel_names); do "$S/channel.sh" create "$ch"; done
    else echo "Infrastructure is up. Create channels with: ./drunix-net.sh channel create <name>"; fi
    ;;
  status)
    . "$ROOT/lib/common.sh"; need_model
    docker ps -a --filter "label=service=$(m .name)" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | cut -c1-140
    for ch in $(channel_names); do echo "-- channel $ch: $(channel_orgs "$ch" | tr '\n' ' ')"; done
    ;;
  down)
    "$S/nodes.sh" down || true
    "$S/ca.sh" down || true
    ;;
  destroy)   # destroy [--keep-volumes] [--keep-crypto] [--remove-secrets]
    . "$ROOT/lib/common.sh"; need_model
    n="$(m .name)"; keep_vol=false; keep_crypto=false; rm_secrets=false
    for a in "$@"; do
      case "$a" in
        --keep-volumes) keep_vol=true;; --keep-crypto) keep_crypto=true;; --remove-secrets) rm_secrets=true;;
        *) fatalln "unknown destroy option '$a' (use --keep-volumes, --keep-crypto, --remove-secrets)";;
      esac
    done
    infoln "network '$n' - this will remove:"
    echo "  - all its containers and the Docker network"
    [ "$keep_vol" = true ]    && echo "  (keeping Docker volumes)"                          || echo "  - Docker volumes: ledgers, state DBs, orderer data"
    [ "$keep_crypto" = true ] && echo "  (keeping crypto material and channel artifacts)" || echo "  - crypto material, channel artifacts, chaincode packages"
    [ "$rm_secrets" = true ]  && echo "  - secrets/*.pw (CA, node and user passwords)"    || echo "  (keeping secrets/)"
    read -r -p "Type the network name to confirm: " a
    [ "$a" = "$n" ] || fatalln "aborted"
    "$S/nodes.sh" down || true; "$S/ca.sh" down || true
    # anything else still labelled with this network (e.g. orderers from an older configuration) and chaincode containers
    docker ps -aq --filter "label=service=$n" | xargs -r docker rm -f >/dev/null
    docker ps -aq --filter "name=^dev-" | xargs -r docker rm -f >/dev/null
    if [ "$keep_vol" != true ]; then
      docker volume ls -q --filter "name=^${n}_" | xargs -r docker volume rm >/dev/null 2>&1 \
        || warnln "some volumes are still in use by other containers and were kept (see the Network page: Docker volumes)"
    fi
    docker network rm "$(DOCKER_NET)" >/dev/null 2>&1 || true
    [ "$keep_crypto" = true ] || rm -rf "$ROOT/organizations" "$ROOT/channel-artifacts" "$ROOT/dist"
    [ "$rm_secrets" = true ]  && rm -f -- "$SECRETS_DIR"/*.pw
    okln "destroyed network '$n'."
    ;;
  help|-h|--help) usage;;
  *) usage; exit 1;;
esac
