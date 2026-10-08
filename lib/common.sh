#!/usr/bin/env bash
# Shared helpers. Source this file; never execute it.
# Secrets are only ever handled through files and environment variables of the
# process that needs them. Nothing here prints a secret value.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$LIB_DIR/.." && pwd)"
GEN="$ROOT/generated"
MODEL="$GEN/model.json"
ORGS_DIR="$ROOT/organizations"
SECRETS_DIR="$ROOT/secrets"
ARTIFACTS="$ROOT/channel-artifacts"
CONFIG_FILE="${DRUNIX_CONFIG:-$ROOT/network.yaml}"

# Do not inherit Fabric settings from the caller's shell (stale FABRIC_CFG_PATH / CORE_PEER_* break the CLI).
unset FABRIC_CFG_PATH CORE_PEER_ADDRESS CORE_PEER_LOCALMSPID CORE_PEER_MSPCONFIGPATH CORE_PEER_TLS_ROOTCERT_FILE \
      CORE_PEER_TLS_ENABLED CORE_PEER_TLS_SERVERHOSTOVERRIDE ORDERER_CA
export FABRIC_CFG_PATH="$GEN/peercfg"

if [ -t 1 ]; then C_B=$'\e[1m'; C_R=$'\e[31m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_N=$'\e[0m'; else C_B= C_R= C_G= C_Y= C_N=; fi
infoln()    { printf '%s\n' "${C_B}==> $*${C_N}"; }
okln()      { printf '%s\n' "${C_G}OK  $*${C_N}"; }
warnln()    { printf '%s\n' "${C_Y}WARN $*${C_N}" >&2; }
errorln()   { printf '%s\n' "${C_R}ERR $*${C_N}" >&2; }
fatalln()   { errorln "$*"; exit 1; }

require_cmd() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 || fatalln "required command not found: $c"; done; }

# ---- Fabric binaries (peer, configtxgen, osnadmin, fabric-ca-client) ----------
find_bin_dir() {
  local d
  for d in "${DRUNIX_BIN:-}" "$ROOT/bin" "$ROOT/../drunix/drunix-network/bin" "$ROOT/../drunix/drunix-network/network/bin"; do
    [ -n "$d" ] && [ -x "$d/peer" ] && { (cd "$d" && pwd); return; }
  done
}
BIN_DIR="$(find_bin_dir)"
[ -n "$BIN_DIR" ] && export PATH="$BIN_DIR:$PATH"

# ---- model (generated/model.json) ---------------------------------------------
need_model() { [ -f "$MODEL" ] || fatalln "no generated model - run './drunix-net.sh generate' first"; }
# m '<jq filter>' -> raw output
m() { jq -r "$@" "$MODEL"; }
DOCKER_NET()   { m '.network'; }
ORDERER_ORG()  { m '.orderer_org.name'; }
ORDERER_DOMAIN(){ m '.orderer_org.domain'; }
org_names()    { m '.orgs[].name'; }
org_field()    { m --arg o "$1" ".orgs[] | select(.name==\$o) | $2"; }   # org_field Name .domain
channel_names(){ m '.channels[].name'; }
all_ca_orgs()  { m '[.orgs[].name] + [.orderer_org.name] | .[]'; }

resolve_org() {  # case-insensitive org lookup, prints canonical name
  local want="$1" n
  for n in $(org_names); do [ "${n,,}" = "${want,,}" ] && { echo "$n"; return; }; done
  fatalln "unknown organization '$want' (known: $(org_names | tr '\n' ' '))"
}

# ---- secrets -------------------------------------------------------------------
secret_file() { echo "$SECRETS_DIR/$1.pw"; }
ensure_secrets_dir() { mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"; }
ensure_secret() {   # create a random secret if it does not exist yet (silent)
  local f; f="$(secret_file "$1")"
  [ -s "$f" ] && return 0
  ensure_secrets_dir
  ( umask 077; openssl rand -hex 24 > "$f" )
}
secret_get() {      # read a secret into stdout - only use inside $(...) assignments, never echo the result
  local f; f="$(secret_file "$1")"
  [ -s "$f" ] || fatalln "secret '$1' is missing - run './drunix-net.sh secrets init'"
  tr -d '\n' < "$f"
}
prompt_secret() {   # prompt_secret "label" outfile  (no echo, asks twice)
  local a b
  read -r -s -p "$1: " a; echo
  read -r -s -p "Repeat: " b; echo
  [ -n "$a" ] && [ "$a" = "$b" ] || fatalln "empty or mismatching input"
  ensure_secrets_dir
  ( umask 077; printf '%s' "$a" > "$2" )
}

# ---- Fabric CA client ----------------------------------------------------------
# Credentials go through FABRIC_CA_CLIENT_* environment variables of the single
# child process instead of command-line arguments, so they never show up in `ps`.
ca_port()   { org_or_orderer_field "$1" '.ca.port'; }
ca_host()   { org_or_orderer_field "$1" '.ca.host'; }
ca_name()   { org_or_orderer_field "$1" '.ca.name'; }
org_or_orderer_field() {
  local org="$1" f="$2"
  if [ "$org" = "$(ORDERER_ORG)" ]; then m ".orderer_org | $f"; else m --arg o "$org" ".orgs[] | select(.name==\$o) | $f"; fi
}
org_domain() { org_or_orderer_field "$1" '.domain'; }
org_lower()  { echo "${1,,}"; }
org_dir() {   # crypto dir of an org (peerOrganizations / ordererOrganizations)
  if [ "$1" = "$(ORDERER_ORG)" ]; then echo "$ORGS_DIR/ordererOrganizations/$(org_domain "$1")"; else echo "$ORGS_DIR/peerOrganizations/$(org_domain "$1")"; fi
}
ca_tls_cert() { echo "$ORGS_DIR/fabric-ca/${1,,}/ca-cert.pem"; }

# ca_client <org> <secret-name-of-caller> <identity-name> -- <fabric-ca-client args...>
# Usage: with_ca_auth <org> <identity> <secret> <fabric-ca-client args...>
with_ca_auth() {
  local org="$1" id="$2" sec="$3"; shift 3
  local pw; pw="$(secret_get "$sec")"
  FABRIC_CA_CLIENT_HOME="$(org_dir "$org")" \
  FABRIC_CA_CLIENT_URL="https://${id}:${pw}@$(ca_host "$org"):$(ca_port "$org")" \
  FABRIC_CA_CLIENT_TLS_CERTFILES="$(ca_tls_cert "$org")" \
  fabric-ca-client "$@" --caname "$(ca_name "$org")"
}
# register an identity; the new identity's secret travels in FABRIC_CA_CLIENT_ID_SECRET
ca_register() {  # ca_register <org> <new-id-name> <new-secret-name> <type> [attrs]
  local org="$1" id="$2" sec="$3" type="$4" attrs="${5:-}" pw
  pw="$(secret_get "$sec")"
  local args=(register --id.name "$id" --id.type "$type")
  [ -n "$attrs" ] && args+=(--id.attrs "$attrs")
  FABRIC_CA_CLIENT_ID_SECRET="$pw" \
  with_ca_auth "$org" admin "ca-$(org_lower "$org")" "${args[@]}" 2>&1 \
    | grep -v "^Password:" | sed -e 's/\(secret\|Secret\)[^ ]*/\1 [hidden]/' || true
}

wait_for_port() {  # wait_for_port host port [seconds]
  local i; for ((i=0; i<${3:-60}; i++)); do
    (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && return 0; sleep 1; done; return 1
}

# ---- peer CLI environment ------------------------------------------------------
# user_msp <org> <user>  -> msp dir of an enrolled user; the name is matched case-insensitively
user_msp() {
  local org="$1" want="$2" dom d base; dom="$(org_domain "$org")"
  for d in "$(org_dir "$org")"/users/*@"${dom}"; do
    [ -d "$d/msp" ] || continue
    base="$(basename "$d")"
    [ "${base%@*}" = "$want" ] || [ "${base%@*}" = "${want^}" ] || [ "${base,,}" = "${want,,}@${dom}" ] && { echo "$d/msp"; return; }
  done
  fatalln "no enrolled user '$want' in $org (see: ./drunix-net.sh user list --org $org)"
}
# peer_env <org> <role cp|lp> <idx>  - acts as the org admin against one peer
peer_env() {
  local org="$1" role="$2" idx="$3" dom host port addr
  dom="$(org_domain "$org")"
  read -r host port addr < <(m --arg o "$org" --arg r "$role" --argjson i "$idx" \
    '.orgs[] | select(.name==$o) | . as $org | .nodes[] | select(.role==$r and .idx==$i) | "\(.host) \(.port) \($org.host)"')
  [ -n "$host" ] || fatalln "no $role$idx in organization $org"
  export FABRIC_CFG_PATH="$GEN/peercfg"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="$(org_field "$org" '.msp_id')"
  export CORE_PEER_TLS_ROOTCERT_FILE="$(org_dir "$org")/tlsca/tlsca.${dom}-cert.pem"
  export CORE_PEER_MSPCONFIGPATH="$(user_msp "$org" "${AS_USER:-Admin}")"
  export CORE_PEER_ADDRESS="${addr}:${port}"
  PEER_HOST="$host"; PEER_ADDR="${addr}:${port}"
}
orderer_args() {  # prints the orderer connection flags for the first orderer
  local od_addr od_port od_host
  read -r od_addr od_port od_host < <(m '.orderer_org.orderers[0] | "\(.address) \(.port) \(.host)"')
  echo "-o ${od_addr}:${od_port} --ordererTLSHostnameOverride ${od_host} --tls --cafile $(org_dir "$(ORDERER_ORG)")/tlsca/tlsca.$(ORDERER_DOMAIN)-cert.pem"
}
# member peers of a channel for an org: lists "role idx" lines (committing first)
channel_peers() {  # channel_peers <channel> <org>
  m --arg c "$1" --arg o "$2" '.channels[] | select(.name==$c) | .members[] | select(.name==$o)
    | (range(1; .committing+1) | "cp \(.)"), (range(1; .lite+1) | "lp \(.)")'
}
channel_orgs() { m --arg c "$1" '.channels[] | select(.name==$c) | .members[].name'; }
channel_exists() { m --arg c "$1" '.channels[] | select(.name==$c) | .name' | grep -qx "$1"; }

# ---- chaincode helpers ---------------------------------------------------------
CC_DIST="$ROOT/dist/chaincode"
# flag parser: parse_flags "name path ..." -- "$@"  -> sets F_<name> variables (kebab -> snake)
parse_flags() {
  local allowed="$1"; shift; [ "$1" = "--" ] && shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --*) local k="${1#--}"; k="${k//-/_}"
           case " $allowed " in *" $k "*) ;; *) fatalln "unknown flag $1";; esac
           if [ $# -lt 2 ] || [[ "$2" == --* ]]; then eval "F_$k=true"; shift; else eval "F_$k=\"\$2\""; shift 2; fi;;
      *) fatalln "unexpected argument $1";;
    esac
  done
}
# committed sequence of a chaincode on a channel (0 when not committed)
committed_sequence() {  # committed_sequence <channel> <name> <org>
  peer_env "$3" cp 1
  peer lifecycle chaincode querycommitted -C "$1" --name "$2" --output json 2>/dev/null | jq -r '.sequence // 0' || echo 0
}
# --peerAddresses/--tlsRootCertFiles flags for the first committing peer of every channel org
commit_peer_flags() {
  local ch="$1" org dom host port addr
  for org in $(channel_orgs "$ch"); do
    read -r host port addr < <(m --arg o "$org" '.orgs[] | select(.name==$o) | . as $org | .nodes[] | select(.role=="cp" and .idx==1) | "\(.host) \(.port) \($org.host)"')
    echo -n "--peerAddresses ${addr}:${port} --tlsRootCertFiles $(org_dir "$org")/tlsca/tlsca.$(org_domain "$org")-cert.pem "
  done
}
