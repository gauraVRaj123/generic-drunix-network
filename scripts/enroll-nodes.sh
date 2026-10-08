#!/usr/bin/env bash
# enroll-nodes [org...]
# Registers and enrolls the infrastructure identities of every org (CA admin, org admin,
# peers / orderers incl. TLS certificates) and builds the MSP folder layout.
# Application users are NOT handled here - see scripts/users.sh.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd fabric-ca-client jq openssl
need_model
orgs=("$@"); [ ${#orgs[@]} -eq 0 ] && mapfile -t orgs < <(all_ca_orgs)

write_node_ou() {  # write_node_ou <org>
  local org="$1" dir cert; dir="$(org_dir "$org")"
  cert="$(basename "$(ls "$dir"/msp/cacerts/*.pem | head -n1)")"
  cat > "$dir/msp/config.yaml" <<YAML
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/$cert
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/$cert
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/$cert
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/$cert
    OrganizationalUnitIdentifier: orderer
YAML
}

enroll_msp() {  # enroll_msp <org> <identity> <secret> <target-dir>
  local org="$1" id="$2" sec="$3" target="$4"
  [ -f "$target"/signcerts/cert.pem ] && return 0
  with_ca_auth "$org" "$id" "$sec" enroll -M "$target" >/dev/null 2>&1 \
    || fatalln "enrollment of $id for $org failed (is the CA up and the secret registered?)"
  cp "$(org_dir "$org")/msp/config.yaml" "$target/config.yaml"
}

enroll_tls() {  # enroll_tls <org> <identity> <secret> <target-dir> <csr-hosts>
  local org="$1" id="$2" sec="$3" target="$4" hosts="$5"
  [ -f "$target/server.key" ] && return 0
  with_ca_auth "$org" "$id" "$sec" enroll -M "$target" --enrollment.profile tls --csr.hosts "$hosts" >/dev/null 2>&1 \
    || fatalln "TLS enrollment of $id for $org failed"
  cp "$target"/tlscacerts/* "$target/ca.crt"
  cp "$target"/signcerts/*  "$target/server.crt"
  cp "$target"/keystore/*   "$target/server.key"
  chmod 600 "$target/server.key"
}

for org in "${orgs[@]}"; do
  [ "$org" = "$(ORDERER_ORG)" ] || org="$(resolve_org "$org")"
  dom="$(org_domain "$org")"; dir="$(org_dir "$org")"; low="${org,,}"
  infoln "enrolling identities of $org"
  mkdir -p "$dir" "$ORGS_DIR/fabric-ca/$low"
  [ -f "$(ca_tls_cert "$org")" ] || fatalln "CA TLS certificate for $org not found - is its CA up?"

  # 1. CA bootstrap admin -> organisation MSP (public material: cacerts, tlscacerts, config.yaml)
  if [ ! -d "$dir/msp/cacerts" ]; then
    with_ca_auth "$org" admin "ca-$low" enroll >/dev/null 2>&1 || fatalln "CA admin enrollment failed for $org"
  fi
  write_node_ou "$org"
  mkdir -p "$dir/msp/tlscacerts" "$dir/tlsca" "$dir/ca"
  cp "$(ca_tls_cert "$org")" "$dir/msp/tlscacerts/ca.crt"
  cp "$(ca_tls_cert "$org")" "$dir/tlsca/tlsca.${dom}-cert.pem"
  cp "$(ca_tls_cert "$org")" "$dir/ca/ca.${dom}-cert.pem"

  # 2. organisation admin (used by the peer CLI for channel / chaincode operations)
  if [ "$org" = "$(ORDERER_ORG)" ]; then admin_sec="orderer-admin"; else admin_sec="admin-$low"; fi
  ca_register "$org" "${low}admin" "$admin_sec" admin >/dev/null
  enroll_msp "$org" "${low}admin" "$admin_sec" "$dir/users/Admin@${dom}/msp"

  # 3. nodes
  if [ "$org" = "$(ORDERER_ORG)" ]; then
    while read -r id host addr; do
      ca_register "$org" "$id" "orderer-$id" orderer >/dev/null
      enroll_msp "$org" "$id" "orderer-$id" "$dir/orderers/$host/msp"
      enroll_tls "$org" "$id" "orderer-$id" "$dir/orderers/$host/tls" "$host,localhost,$addr"
      mkdir -p "$dir/orderers/$host/msp/tlscacerts"
      cp "$dir/tlsca/tlsca.${dom}-cert.pem" "$dir/orderers/$host/msp/tlscacerts/tlsca.${dom}-cert.pem"
    done < <(m '.orderer_org.orderers[] | "\(.id) \(.host) \(.address)"')
  else
    while read -r id host container; do
      ca_register "$org" "$id" "node-$low-$id" peer >/dev/null
      enroll_msp "$org" "$id" "node-$low-$id" "$dir/peers/$host/msp"
      enroll_tls "$org" "$id" "node-$low-$id" "$dir/peers/$host/tls" "$host,$container,localhost,$(org_field "$org" '.host')"
    done < <(m --arg o "$org" '.orgs[] | select(.name==$o) | .nodes[] | select(.role != "vscc") | "\(.id) \(.host) \(.container)"')
  fi
  okln "$org enrolled"
done
