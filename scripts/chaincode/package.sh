#!/usr/bin/env bash
# chaincode package --name N --path DIR [--lang golang|node|java] [--version 1.0] [--no-vendor]
# Produces dist/chaincode/<name>_<version>.tar.gz. Nothing is installed or approved here.
set -euo pipefail
. "$(dirname "$0")/../../lib/common.sh"
require_cmd peer
F_lang=golang; F_version=1.0; F_no_vendor=false
parse_flags "name path lang version no_vendor" -- "$@"
: "${F_name:?--name is required}"; : "${F_path:?--path is required}"
[ -d "$F_path" ] || fatalln "chaincode path '$F_path' not found"
F_path="$(cd "$F_path" && pwd)"

if [ "$F_lang" = golang ] && [ "$F_no_vendor" != true ]; then
  # vendor once, up front, so install/approve do not have to wait for dependency downloads
  d="$F_path"; while [ "$d" != / ] && [ ! -f "$d/go.mod" ]; do d="$(dirname "$d")"; done
  if [ -f "$d/go.mod" ]; then infoln "go mod vendor in $d"; (cd "$d" && go mod vendor); fi
fi
mkdir -p "$CC_DIST"
out="$CC_DIST/${F_name}_${F_version}.tar.gz"
peer lifecycle chaincode package "$out" --path "$F_path" --lang "$F_lang" --label "${F_name}_${F_version}"
okln "packaged $out"
