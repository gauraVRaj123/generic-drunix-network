#!/usr/bin/env bash
# Validate network.yaml and render compose/configtx/monitoring files into generated/.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
require_cmd python3 jq
python3 -c 'import yaml, jinja2' 2>/dev/null || fatalln "python3 modules missing: pip install pyyaml jinja2"
[ -f "$CONFIG_FILE" ] || fatalln "$CONFIG_FILE not found - run './drunix-net.sh init'"
python3 "$ROOT/tools/render.py" "$CONFIG_FILE"
