#!/usr/bin/env python3
"""Validate network.yaml, derive the full network model and render all templates.

Outputs (under generated/):
  model.json                  derived model, consumed by the bash scripts via jq
  compose/ca-<name>.yaml      Fabric CA of each org + the orderer org
  compose/orderers.yaml       Raft ordering service
  compose/org-<name>.yaml     per-org peer group (CP/LP/VSCC + YugabyteDB + KeyDB)
  compose/monitoring.yaml     Prometheus + Grafana (when enabled)
  configtx/configtx.yaml      one profile per channel
  monitoring/...              Prometheus scrape config, Grafana datasource + starter dashboard
  peercfg/core.yaml           peer config mounted into every peer
No secrets are read or written here.
"""
import json
import re
import shutil
import sys
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).resolve().parent.parent
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,30}$")
CHANNEL_RE = re.compile(r"^[a-z][a-z0-9.-]{0,248}$")
DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
POLICIES = {"MAJORITY", "ANY", "ALL"}

DEFAULT_IMAGES = {
    "peer": "npcioss/drunix-peer:1.0.0",
    "vscc": "npcioss/drunix-vscc:1.0.0",
    "orderer": "npcioss/drunix-orderer:1.0.0",
    "ca": "hyperledger/fabric-ca:1.5.22",
    "yugabyte": "yugabytedb/yugabyte:2025.2.0.0-b131",
    "keydb": "eqalpha/keydb:latest",
    "prometheus": "prom/prometheus:latest",
    "grafana": "grafana/grafana:latest",
}
DEFAULT_BATCH = {
    "timeout": "2s",
    "max_message_count": 10,
    "absolute_max_bytes": "99 MB",
    "preferred_max_bytes": "512 KB",
}


class ConfigError(Exception):
    """Raised for any invalid network.yaml content (the web console shows the message)."""


def die(msg):
    raise ConfigError(msg)


def load(path):
    try:
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        die(f"{path} not found - run './drunix-net.sh init' first")


def build_model(cfg):
    net = cfg.get("network") or {}
    name = net.get("name", "drunix")
    domain = str(net.get("domain", "")).lower()
    mode = net.get("mode", "single-host")
    if not NAME_RE.match(name) and not re.match(r"^[a-z][a-z0-9-]*$", name):
        die(f"network.name '{name}' is invalid")
    if not DOMAIN_RE.match(domain):
        die(f"network.domain '{domain}' is invalid")
    if mode not in ("single-host", "multi-host"):
        die("network.mode must be single-host or multi-host")

    # ---- orderer ----
    o = cfg.get("orderer") or {}
    o_org = o.get("org_name", "NetworkAuthority")
    if not NAME_RE.match(o_org):
        die(f"orderer.org_name '{o_org}' must be alphanumeric (2-31 chars, starting with a letter)")
    o_count = int(o.get("count", 1))
    if o_count not in (1, 3, 5):
        die("orderer.count must be 1, 3 or 5 (Raft needs an odd number of consenters)")
    o_hosts = o.get("hosts") or ["localhost"]

    # ---- organisations ----
    orgs_cfg = cfg.get("organizations") or []
    if len(orgs_cfg) < 1:
        die("define at least one organization")
    seen = set()
    orgs = []
    for oi, oc in enumerate(orgs_cfg):
        oname = oc.get("name", "")
        if not NAME_RE.match(oname):
            die(f"organization name '{oname}' must be alphanumeric (2-31 chars, starting with a letter)")
        if oname.lower() in seen or oname.lower() == o_org.lower():
            die(f"duplicate organization name '{oname}'")
        seen.add(oname.lower())
        p = oc.get("peers") or {}
        n_cp = int(p.get("committing", 1))
        n_lp = int(p.get("lite", 1))
        n_vs = int(p.get("vscc", 1))
        if n_cp < 1 or n_lp < 1 or n_vs < 1:
            die(f"{oname}: committing, lite and vscc must each be >= 1")
        if max(n_cp, n_lp, n_vs) > 9:
            die(f"{oname}: at most 9 of each peer role per organization")
        low = oname.lower()
        odomain = f"{low}.{domain}"
        org = {
            "name": oname, "lower": low, "msp_id": f"{oname}MSP", "domain": odomain,
            "host": oc.get("host", "localhost"), "index": oi,
            "counts": {"committing": n_cp, "lite": n_lp, "vscc": n_vs},
            "ca": {
                "container": f"ca.{odomain}", "name": f"ca-{low}",
                "port": 40000 + oi * 10, "ops_port": 40001 + oi * 10,
                "host": oc.get("host", "localhost"),
            },
            "nodes": [],
        }
        k = 0
        pbase = 20000 + oi * 1000
        obase = 30000 + oi * 1000

        def mk(role, idx):
            nonlocal k
            n = {
                "role": role, "idx": idx, "id": f"{ {'cp':'cp','lp':'lp','vscc':'vs'}[role] }{idx}",
                "port": pbase + k * 10, "cc_port": pbase + k * 10 + 1, "ops_port": obase + k * 10,
            }
            n["host"] = f"{n['id']}.{odomain}"
            n["container"] = f"{n['id']}.{low}"
            n["data_volume"] = f"{name}_{n['id']}_{low}"
            k += 1
            return n

        cps = [mk("cp", i + 1) for i in range(n_cp)]
        lps = [mk("lp", i + 1) for i in range(n_lp)]
        vss = [mk("vscc", i + 1) for i in range(n_vs)]
        for i, n in enumerate(lps):
            n["cp"] = cps[i % n_cp]["id"]
        for i, n in enumerate(vss):
            n["cp"] = cps[i % n_cp]["id"]
        for c in cps:
            c["vscc"] = next(v["id"] for v in vss if v["cp"] == c["id"]) if any(v["cp"] == c["id"] for v in vss) \
                else vss[0]["id"]
            c["yugabyte"] = f"yugabyte-{c['id']}-{low}"
            c["keydb"] = f"keydb-{c['id']}-{low}"
            c["yb_volume"] = f"{name}_yb_{c['id']}_{low}"
            c["keydb_volume"] = f"{name}_keydb_{c['id']}_{low}"
        by_id = {c["id"]: c for c in cps}
        for n in lps + vss:
            n["yugabyte"] = by_id[n["cp"]]["yugabyte"]
            n["keydb"] = by_id[n["cp"]]["keydb"]
        org["nodes"] = cps + lps + vss
        org["warnings"] = []
        if n_vs < n_cp:
            org["warnings"].append(
                f"{oname}: fewer VSCC ({n_vs}) than committing peers ({n_cp}); a VSCC is shared by several CPs")
        orgs.append(org)
    org_by_name = {o_["name"]: o_ for o_ in orgs}

    # ---- orderers ----
    odomain = f"{o_org.lower()}.{domain}"
    orderers = []
    for i in range(o_count):
        host_ip = o_hosts[i] if i < len(o_hosts) else o_hosts[-1]
        port = 6050 + i * 10
        orderers.append({
            "idx": i + 1, "id": f"orderer{i + 1}", "host": f"orderer{i + 1}.{odomain}",
            "container": f"orderer{i + 1}.{o_org.lower()}", "port": port,
            "admin_port": port + 3, "ops_port": port + 4, "address": host_ip,
            "volume": f"{name}_orderer{i + 1}",
        })
    orderer_org = {
        "name": o_org, "lower": o_org.lower(), "msp_id": f"{o_org}MSP", "domain": odomain,
        "ca": {
            "container": f"ca.{odomain}", "name": f"ca-{o_org.lower()}",
            "port": 40000 + len(orgs) * 10, "ops_port": 40001 + len(orgs) * 10,
            "host": o_hosts[0],
        },
        "orderers": orderers,
    }

    # ---- channels ----
    chs = cfg.get("channels") or []
    if not chs:
        die("define at least one channel")
    channels, cnames = [], set()
    for ch in chs:
        cname = ch.get("name", "")
        if not CHANNEL_RE.match(cname):
            die(f"channel name '{cname}' must be lowercase letters, digits, '.' or '-'")
        if cname in cnames:
            die(f"duplicate channel '{cname}'")
        cnames.add(cname)
        members = []
        for m in ch.get("organizations") or []:
            mname = m if isinstance(m, str) else m.get("name")
            if mname not in org_by_name:
                die(f"channel '{cname}': unknown organization '{mname}'")
            org = org_by_name[mname]
            nl = org["counts"]["lite"] if isinstance(m, str) else int(m.get("lite", org["counts"]["lite"]))
            nc = org["counts"]["committing"] if isinstance(m, str) else int(
                m.get("committing", org["counts"]["committing"]))
            if not (1 <= nl <= org["counts"]["lite"]) or not (1 <= nc <= org["counts"]["committing"]):
                die(f"channel '{cname}': {mname} peer subset exceeds the org's peers")
            if mname in [x["name"] for x in members]:
                die(f"channel '{cname}': organization '{mname}' listed twice")
            members.append({"name": mname, "lite": nl, "committing": nc})
        if not members:
            die(f"channel '{cname}' needs at least one organization")
        pol = str(ch.get("endorsement_policy", "MAJORITY")).upper()
        if pol not in POLICIES:
            die(f"channel '{cname}': endorsement_policy must be one of {sorted(POLICIES)}")
        batch = {**DEFAULT_BATCH, **(ch.get("batch") or {})}
        channels.append({
            "name": cname, "profile": "Profile_" + re.sub(r"[^A-Za-z0-9]", "_", cname),
            "members": members, "policy": pol, "batch": batch,
        })

    mon = cfg.get("monitoring") or {}
    log = cfg.get("logging") or {}

    images = {**DEFAULT_IMAGES, **(cfg.get("images") or {})}
    return {
        "name": name, "domain": domain, "mode": mode, "network": f"{name}_net",
        "orgs": orgs, "orderer_org": orderer_org, "channels": channels, "images": images,
        "monitoring": {
            "enabled": bool(mon.get("enabled", True)),
            "prometheus_port": int(mon.get("prometheus_port", 9090)),
            "grafana_port": int(mon.get("grafana_port", 3000)),
        },
        "logging": {
            "level": str(log.get("level", "INFO")).upper(),
            "max_size": str(log.get("max_size", "50m")),
            "max_files": int(log.get("max_files", 5)),
        },
    }


def hosts_map(m):
    """name -> address for every node, used for extra_hosts in multi-host mode."""
    h = {}
    for org in m["orgs"]:
        for n in org["nodes"]:
            h[n["host"]] = org["host"]
        h[org["ca"]["container"]] = org["host"]
    for od in m["orderer_org"]["orderers"]:
        h[od["host"]] = od["address"]
    h[m["orderer_org"]["ca"]["container"]] = m["orderer_org"]["ca"]["host"]
    return h


def main():
    try:
        run()
    except ConfigError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


def run():
    cfg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "network.yaml"
    out = ROOT / "generated"
    m = build_model(load(cfg_path))
    m["extra_hosts"] = hosts_map(m) if m["mode"] == "multi-host" else {}

    # Clear old files but keep the directories: running containers bind-mount generated/peercfg.
    if out.exists():
        for f in out.rglob("*"):
            if f.is_file():
                f.unlink()
    for d in ("compose", "configtx", "monitoring", "monitoring/dashboards", "peercfg"):
        (out / d).mkdir(parents=True, exist_ok=True)

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), undefined=StrictUndefined,
                      trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)

    def render(tpl, dest, **ctx):
        (out / dest).write_text(env.get_template(tpl).render(m=m, **ctx))

    for ca_org in m["orgs"] + [m["orderer_org"]]:
        render("ca.yaml.j2", f"compose/ca-{ca_org['lower']}.yaml", cas=[ca_org])
    render("orderers.yaml.j2", "compose/orderers.yaml")
    for org in m["orgs"]:
        render("org.yaml.j2", f"compose/org-{org['lower']}.yaml", org=org)
    render("configtx.yaml.j2", "configtx/configtx.yaml")
    if m["monitoring"]["enabled"]:
        render("monitoring.yaml.j2", "compose/monitoring.yaml")
        render("prometheus.yml.j2", "monitoring/prometheus.yml")
        render("grafana-datasource.yml.j2", "monitoring/grafana-datasource.yml")
        # static Grafana provisioning (copied as-is: the dashboard JSON contains {{ }} legend templates)
        shutil.copy(ROOT / "templates/monitoring/grafana-dashboards.yml", out / "monitoring/grafana-dashboards.yml")
        shutil.copy(ROOT / "templates/monitoring/drunix-overview.json", out / "monitoring/dashboards/drunix-overview.json")
    shutil.copy(ROOT / "templates/peercfg/core.yaml", out / "peercfg/core.yaml")
    (out / "model.json").write_text(json.dumps(m, indent=2))

    for org in m["orgs"]:
        for w in org["warnings"]:
            print(f"WARNING: {w}", file=sys.stderr)
    print(f"Generated {len(m['orgs'])} org(s), {len(m['orderer_org']['orderers'])} orderer(s), "
          f"{len(m['channels'])} channel(s) into {out}")


if __name__ == "__main__":
    main()
