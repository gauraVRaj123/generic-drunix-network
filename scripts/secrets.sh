#!/usr/bin/env bash
# secrets init|list|set <name>|remove <name>...|remove --all
# Generates every credential the network needs as a random value in secrets/*.pw
# (mode 600, git-ignored). Values are never printed.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd jq openssl

secret_names() {
  need_model
  local o
  for o in $(all_ca_orgs); do echo "ca-${o,,}"; done
  m '.orgs[] | .lower as $l | .nodes[] | select(.role != "vscc") | "node-\($l)-\(.id)"'
  for o in $(org_names); do echo "admin-${o,,}"; done
  m '.orderer_org.orderers[].id | "orderer-" + .'
  echo "orderer-admin"
  [ "$(m '.monitoring.enabled')" = "true" ] && echo "grafana-admin" || true
}

cmd="${1:-init}"
case "$cmd" in
  init)
    created=0
    while read -r n; do
      [ -s "$(secret_file "$n")" ] || { ensure_secret "$n"; created=$((created+1)); }
    done < <(secret_names)
    okln "secrets ready in secrets/ ($created new, others kept). Back this directory up securely; it is git-ignored."
    ;;
  list)
    while read -r n; do
      [ -s "$(secret_file "$n")" ] && echo "set      $n" || echo "MISSING  $n"
    done < <(secret_names)
    ;;
  set)   # set a specific secret interactively (hidden input)
    name="${2:?usage: secrets set <name>}"
    secret_names | grep -qx "$name" || fatalln "unknown secret '$name' (see: secrets list)"
    prompt_secret "New value for $name" "$(secret_file "$name")"
    okln "$name updated (re-run enrollment if the identity already exists in the CA)"
    ;;
  remove)  # delete credential files from secrets/ (only *.pw; console accounts are never touched)
    shift; [ $# -ge 1 ] || fatalln "usage: secrets remove <name>... | --all"
    ensure_secrets_dir
    if [ "$1" = "--all" ]; then mapfile -t names < <(cd "$SECRETS_DIR" && ls -1 ./*.pw 2>/dev/null | sed 's|^\./||; s|\.pw$||'); else names=("$@"); fi
    removed=0
    for s in "${names[@]}"; do
      [[ "$s" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || fatalln "invalid secret name '$s'"
      f="$(secret_file "$s")"
      if [ -f "$f" ]; then rm -f -- "$f"; removed=$((removed+1)); else warnln "no secret named '$s'"; fi
    done
    okln "removed $removed secret(s). Recreate them with: ./drunix-net.sh secrets init (new random values - identities already enrolled keep working only if their CA data is kept)"
    ;;
  *) fatalln "usage: secrets init|list|set <name>|remove <name>...|remove --all";;
esac
