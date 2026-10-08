#!/usr/bin/env bash
# user add|list|revoke|remove - application identities (separate from node enrollment).
#   user add --org X --name alice [--role issuer] [--type client|admin] [--attr dept=ops ...] [--generate]
# The password is asked for with hidden input (or generated with --generate) and stored in
# secrets/user-<org>-<name>.pw (mode 600). It is never printed. The certificate carries the
# chaincode "role" attribute (:ecert) so chaincode can check it with cid.GetAttributeValue.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd fabric-ca-client jq openssl; need_model
action="${1:-}"; shift || true

case "$action" in
  add)
    F_type=client; F_role=""; F_generate=false; F_attr=""
    # --attr may repeat: collect manually before the generic parser sees the rest
    rest=(); attrs=()
    while [ $# -gt 0 ]; do
      if [ "$1" = "--attr" ]; then attrs+=("$2"); shift 2; else rest+=("$1"); shift; fi
    done
    parse_flags "org name role type generate" -- "${rest[@]}"
    : "${F_org:?--org is required}"; : "${F_name:?--name is required}"
    [[ "$F_name" =~ ^[A-Za-z][A-Za-z0-9_-]{1,30}$ ]] || fatalln "--name must be 2-31 chars: letters, digits, _ or -"
    [ "$F_type" = client ] || [ "$F_type" = admin ] || fatalln "--type must be client or admin"
    org="$(resolve_org "$F_org")"; low="${org,,}"; dom="$(org_domain "$org")"
    id="${F_name,,}"; sec="user-$low-$id"

    if [ ! -s "$(secret_file "$sec")" ]; then
      if [ "$F_generate" = true ]; then ensure_secret "$sec"; else prompt_secret "Password for $id@$org" "$(secret_file "$sec")"; fi
    fi
    reg_attrs=""; enr_attrs=""
    [ -n "$F_role" ] && { reg_attrs="role=${F_role}:ecert"; enr_attrs="role"; }
    for a in "${attrs[@]:-}"; do
      [ -z "$a" ] && continue; k="${a%%=*}"
      reg_attrs="${reg_attrs:+$reg_attrs,}${a}:ecert"; enr_attrs="${enr_attrs:+$enr_attrs,}${k}"
    done
    ca_register "$org" "$id" "$sec" "$F_type" "$reg_attrs" >/dev/null
    target="$(org_dir "$org")/users/${F_name}@${dom}/msp"
    [ -d "$target" ] && fatalln "$target already exists - revoke or remove it first"
    enr=(enroll -M "$target"); [ -n "$enr_attrs" ] && enr+=(--enrollment.attrs "$enr_attrs")
    with_ca_auth "$org" "$id" "$sec" "${enr[@]}" >/dev/null 2>&1 || fatalln "enrollment failed for $id"
    cp "$(org_dir "$org")/msp/config.yaml" "$target/config.yaml"
    okln "user $F_name enrolled for $org  ->  ${target#$ROOT/}"
    [ -n "$F_role" ] && echo "    role attribute: $F_role"
    ;;
  list)
    parse_flags "org" -- "$@"
    for org in $( [ -n "${F_org:-}" ] && resolve_org "$F_org" || org_names ); do
      echo "== $org"; ls -1 "$(org_dir "$org")/users" 2>/dev/null | sed 's/^/   /' || true
    done
    ;;
  revoke)
    parse_flags "org name" -- "$@"; : "${F_org:?--org}"; : "${F_name:?--name}"
    org="$(resolve_org "$F_org")"
    with_ca_auth "$org" admin "ca-${org,,}" revoke -e "${F_name,,}" --gencrl >/dev/null 2>&1 || fatalln "revoke failed"
    okln "revoked ${F_name,,} in $org (distribute the new CRL / update channel MSP to enforce it)"
    ;;
  remove)   # delete the LOCAL files of an application user (its MSP folder + stored password). Does not revoke the certificate.
    parse_flags "org name" -- "$@"; : "${F_org:?--org}"; : "${F_name:?--name}"
    [ "${F_name,,}" != admin ] || fatalln "the organization admin cannot be removed here"
    org="$(resolve_org "$F_org")"
    msp="$(user_msp "$org" "$F_name")"
    [[ "$msp" == "$(org_dir "$org")/users/"*/msp ]] || fatalln "unexpected user path: $msp"
    rm -rf -- "$(dirname "$msp")"
    rm -f -- "$(secret_file "user-${org,,}-${F_name,,}")"
    okln "removed local files of ${F_name,,} in $org (run 'user revoke' too if the certificate must stop working)"
    ;;
  *) fatalln "usage: user add|list|revoke|remove ...";;
esac
