#!/usr/bin/env python3
"""Local web console for drunix-network-generic (standard library only).

It never builds shell strings: every UI action maps to a fixed argv for ./drunix-net.sh,
all parameters are validated, and the child process gets no stdin (so nothing can prompt).
Secrets are never read or returned - the API only exposes names/status, and users are
created with generated passwords.

Safety model (it can start/stop containers, so treat it like a root shell on this machine):
  * binds to 127.0.0.1 only
  * login required; console accounts are managed on the host with
    `python3 ui/server.py user add|list|passwd|remove`; passwords are stored as salted scrypt hashes
  * session cookie (HttpOnly, SameSite=Strict) + per-session CSRF header on every write
  * failed-login lockout; every task is written to logs/console-audit.log
  * Host / Origin headers are checked (DNS-rebinding / cross-site protection)
  * one job at a time
"""
import argparse
import datetime
import errno
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import render  # noqa: E402  (validator shared with `generate`)

STATIC = Path(__file__).resolve().parent / "static"
CONFIG = ROOT / "network.yaml"
EXAMPLE = ROOT / "network.example.yaml"
MODEL = ROOT / "generated" / "model.json"
REPO_ROOT = ROOT.parent  # chaincode paths must stay inside the repository

NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{1,30}$")
CC_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
CHANNEL = re.compile(r"^[a-z][a-z0-9.-]{0,127}$")
ROLE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
LP_ID = re.compile(r"^lp[1-9]$")


class BadRequest(Exception):
    pass


# ---------------------------------------------------------------------------- helpers
def need(params, key, rx=None, optional=False):
    v = params.get(key)
    if v in (None, ""):
        if optional:
            return None
        raise BadRequest(f"'{key}' is required")
    v = str(v)
    if v.startswith("-"):
        raise BadRequest(f"'{key}' must not start with '-'")
    if rx is not None and not rx.match(v):
        raise BadRequest(f"'{key}' has an invalid value")
    return v


def model():
    try:
        return json.loads(MODEL.read_text())
    except Exception:
        return None


def org_param(params, key="org", optional=False):
    v = need(params, key, NAME, optional)
    if v is None:
        return None
    m = model()
    if not m:
        raise BadRequest("run 'Generate' first")
    names = [o["name"] for o in m["orgs"]] + [m["orderer_org"]["name"]]
    for n in names:
        if n.lower() == v.lower():
            return n
    raise BadRequest(f"unknown organization '{v}'")


def channel_param(params, key="channel"):
    v = need(params, key, CHANNEL)
    m = model()
    if not m or v not in [c["name"] for c in m["channels"]]:
        raise BadRequest(f"channel '{v}' is not defined (save + generate first)")
    return v


def cc_path(params):
    p = need(params, "path")
    real = (REPO_ROOT / p).resolve() if not os.path.isabs(p) else Path(p).resolve()
    try:
        real.relative_to(REPO_ROOT)
    except ValueError:
        raise BadRequest("chaincode path must be inside the repository")
    if not real.is_dir():
        raise BadRequest(f"chaincode path not found: {real}")
    return str(real)


def flag(args, name, value):
    if value not in (None, ""):
        args += [name, value]


# --------------------------------------------------------------------------- actions
# Each builder returns (argv_after_drunix-net.sh, stdin_text or None).
def A(*parts):
    return lambda p: (list(parts), None)


def targets(p):
    t = p.get("targets") or []
    out = []
    for x in t:
        x = str(x)
        out.append(x if x in ("orderers", "monitoring") else org_param({"org": x}))
    return out


def a_ca(mode):
    return lambda p: (["ca", mode] + [org_param({"org": o}) for o in (p.get("targets") or [])], None)


def a_enroll(p):
    return (["enroll"] + [org_param({"org": o}) for o in (p.get("targets") or [])], None)


def a_nodes(mode):
    return lambda p: (["nodes", mode] + targets(p), None)


def a_reset_lp(p):
    return (["nodes", "reset-lp", org_param(p), need(p, "lp", LP_ID)], None)


def a_up(p):
    return (["up"] + (["--channels"] if p.get("channels") else []), None)


def a_channel(mode):
    def f(p):
        a = ["channel", mode]
        if mode in ("create", "join", "info"):
            a.append(channel_param(p))
        if mode in ("join", "info", "list"):
            o = org_param(p, optional=True)
            if o:
                a.append(o)
        return (a, None)
    return f


def a_user_add(p):
    a = ["user", "add", "--org", org_param(p), "--name", need(p, "name", NAME), "--generate"]
    flag(a, "--role", need(p, "role", ROLE, optional=True))
    t = need(p, "type", re.compile(r"^(client|admin)$"), optional=True)
    flag(a, "--type", t)
    for attr in p.get("attrs") or []:
        if not re.match(r"^[A-Za-z][A-Za-z0-9_]{0,30}=[A-Za-z0-9_.-]{1,60}$", str(attr)):
            raise BadRequest("attributes must look like key=value")
        a += ["--attr", str(attr)]
    return (a, None)


def a_user_list(p):
    a = ["user", "list"]
    o = org_param(p, optional=True)
    if o:
        a += ["--org", o]
    return (a, None)


def a_user_revoke(p):
    return (["user", "revoke", "--org", org_param(p), "--name", need(p, "name", NAME)], None)


VOLUME_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
SECRET_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")


def names_or_all(p, rx, what):
    """-> ["--all"] or a validated list of names (never anything starting with '-')."""
    if p.get("all"):
        return ["--all"]
    names = p.get("names") or []
    if not isinstance(names, list) or not names or len(names) > 200 or not all(isinstance(x, str) and rx.match(x) for x in names):
        raise BadRequest(f"choose at least one valid {what}")
    return names


def a_volumes_remove(p):
    return (["volumes", "remove"] + names_or_all(p, VOLUME_NAME, "volume"), None)


def a_secrets_remove(p):
    return (["secrets", "remove"] + names_or_all(p, SECRET_NAME, "secret"), None)


def a_user_remove(p):
    return (["user", "remove", "--org", org_param(p), "--name", need(p, "name", NAME)], None)


def cc_common(p, a):
    flag(a, "--channel", channel_param(p))
    flag(a, "--name", need(p, "name", CC_NAME))
    flag(a, "--version", need(p, "version", VERSION, optional=True))
    return a


def a_cc_package(p):
    a = ["chaincode", "package", "--name", need(p, "name", CC_NAME), "--path", cc_path(p)]
    flag(a, "--version", need(p, "version", VERSION, optional=True))
    flag(a, "--lang", need(p, "lang", re.compile(r"^(golang|node|java)$"), optional=True))
    if p.get("no_vendor"):
        a.append("--no-vendor")
    return (a, None)


def a_cc_install(p):
    a = cc_common(p, ["chaincode", "install"])
    flag(a, "--org", org_param(p, optional=True))
    return (a, None)


def a_cc_approve(p):
    a = cc_common(p, ["chaincode", "approve"])
    flag(a, "--org", org_param(p, optional=True))
    flag(a, "--sequence", need(p, "sequence", re.compile(r"^(auto|[0-9]{1,6})$"), optional=True))
    flag(a, "--policy", need(p, "policy", re.compile(r"^[A-Za-z0-9_().,' ]{1,300}$"), optional=True))
    return (a, None)


def a_cc_commit(p):
    a = cc_common(p, ["chaincode", "commit"])
    flag(a, "--sequence", need(p, "sequence", re.compile(r"^(auto|[0-9]{1,6})$"), optional=True))
    flag(a, "--policy", need(p, "policy", re.compile(r"^[A-Za-z0-9_().,' ]{1,300}$"), optional=True))
    return (a, None)


def a_cc_deploy(p):
    a = cc_common(p, ["chaincode", "deploy"])
    flag(a, "--path", cc_path(p))
    flag(a, "--policy", need(p, "policy", re.compile(r"^[A-Za-z0-9_().,' ]{1,300}$"), optional=True))
    return (a, None)


def a_cc_list(p):
    a = ["chaincode", "list", "--channel", channel_param(p)]
    flag(a, "--org", org_param(p, optional=True))
    return (a, None)


def a_cc_call(mode):
    def f(p):
        args = p.get("args") or []
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                raise BadRequest("args must be a JSON array of strings")
        if not isinstance(args, list) or not all(isinstance(x, (str, int, float)) for x in args) or len(json.dumps(args)) > 8000:
            raise BadRequest("args must be a JSON array of strings")
        a = ["chaincode", mode, "--channel", channel_param(p), "--name", need(p, "name", CC_NAME),
             "--fn", need(p, "fn", re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,63}$")),
             "--args", json.dumps([str(x) for x in args])]
        flag(a, "--org", org_param(p, optional=True))
        flag(a, "--user", need(p, "user", NAME, optional=True))
        return (a, None)
    return f


def a_destroy(p):
    m = model()
    if not m or p.get("confirm") != m["name"]:
        raise BadRequest("type the network name to confirm")
    flags = []
    if p.get("volumes") is False:
        flags.append("--keep-volumes")
    if p.get("crypto") is False:
        flags.append("--keep-crypto")
    if p.get("secrets") is True:
        flags.append("--remove-secrets")
    return (["destroy"] + flags, m["name"] + "\n")


ACTIONS = {
    "generate": A("generate"), "secrets_init": A("secrets", "init"), "secrets_list": A("secrets", "list"),
    "ca_up": a_ca("up"), "ca_down": a_ca("down"), "enroll": a_enroll,
    "nodes_up": a_nodes("up"), "nodes_down": a_nodes("down"), "nodes_status": a_nodes("status"),
    "reset_lp": a_reset_lp, "up": a_up, "down": A("down"), "destroy": a_destroy,
    "channel_create": a_channel("create"), "channel_join": a_channel("join"),
    "channel_list": a_channel("list"), "channel_info": a_channel("info"),
    "user_add": a_user_add, "user_list": a_user_list, "user_revoke": a_user_revoke, "user_remove": a_user_remove,
    "volumes_remove": a_volumes_remove, "secrets_remove": a_secrets_remove,
    "cc_package": a_cc_package, "cc_install": a_cc_install, "cc_approve": a_cc_approve,
    "cc_commit": a_cc_commit, "cc_deploy": a_cc_deploy, "cc_list": a_cc_list,
    "cc_query": a_cc_call("query"), "cc_invoke": a_cc_call("invoke"),
    "crypto_export": lambda p: (["crypto", "export"], None),
}

# ------------------------------------------------------------------------------ accounts + sessions
USERS_FILE = ROOT / "secrets" / "console-users.json"
AUDIT_FILE = ROOT / "logs" / "console-audit.log"
ROLE = "portal"                   # every console account is a portal account (full control)
IDLE_TTL, MAX_TTL = 30 * 60, 12 * 3600
SESSIONS = {}
SESS_LOCK = threading.Lock()
FAILS = {}                        # username -> [count, locked_until]
MAX_FAILS, LOCK_SECS = 5, 120
ACCOUNT = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{2,31}$")


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_pw(pw, stored):
    try:
        _, salt, dk = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), dk)
    except Exception:  # noqa: BLE001
        return False


DUMMY_HASH = hash_pw("not-a-real-password")


def load_accounts():
    try:
        return json.loads(USERS_FILE.read_text())
    except Exception:
        return {}


def save_accounts(d):
    USERS_FILE.parent.mkdir(mode=0o700, exist_ok=True)
    tmp = USERS_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2)
    tmp.replace(USERS_FILE)
    os.chmod(USERS_FILE, 0o600)


def audit(who, event, detail=""):
    try:
        AUDIT_FILE.parent.mkdir(exist_ok=True)
        with open(AUDIT_FILE, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {who} {event} {detail}\n")
        os.chmod(AUDIT_FILE, 0o600)
    except Exception:  # noqa: BLE001
        pass


def check_credentials(name, password):
    """-> (account | None, error). Same cost/answer for unknown users and wrong passwords; counts failures."""
    key = str(name).lower()
    now = time.time()
    with SESS_LOCK:
        until = FAILS.get(key, [0, 0])[1]
        if until > now:
            return None, f"too many failed attempts - try again in {int(until - now) + 1}s"
    acct = next((v for k, v in load_accounts().items() if k.lower() == key), None)
    ok = verify_pw(str(password), acct["hash"] if acct else DUMMY_HASH) and acct is not None
    if not ok or acct.get("role") != ROLE or acct.get("disabled"):
        time.sleep(0.6)
        with SESS_LOCK:
            cnt = FAILS.get(key, [0, 0])[0] + 1
            FAILS[key] = [0, now + LOCK_SECS] if cnt >= MAX_FAILS else [cnt, 0]
        audit(key, "login-failed")
        return None, "invalid username or password"
    with SESS_LOCK:
        FAILS.pop(key, None)
    return acct, ""


def try_login(name, password):
    """-> (session | None, error message)."""
    acct, err = check_credentials(name, password)
    if not acct:
        return None, err
    now = time.time()
    with SESS_LOCK:
        sid = secrets.token_urlsafe(32)
        sess = {"sid": sid, "user": acct["name"], "role": acct["role"], "csrf": secrets.token_urlsafe(24), "created": now, "last": now}
        SESSIONS[sid] = sess
    audit(sess["user"], "login")
    return sess, ""


def session_for(handler):
    ck = SimpleCookie(handler.headers.get("Cookie", ""))
    m = ck.get("drunix_sid")
    if not m:
        return None
    now = time.time()
    with SESS_LOCK:
        for sid in [k for k, v in SESSIONS.items() if now - v["last"] > IDLE_TTL or now - v["created"] > MAX_TTL]:
            SESSIONS.pop(sid, None)
        sess = SESSIONS.get(m.value)
        if not sess or sess["role"] != ROLE:
            return None
        sess["last"] = now
        return sess


def me_payload(sess):
    return {"user": sess["user"], "role": sess["role"], "csrf": sess["csrf"]}


def cli_users(argv):
    """python3 ui/server.py user add|list|passwd|remove ..."""
    ap = argparse.ArgumentParser(prog="server.py user")
    ap.add_argument("cmd", choices=["add", "list", "passwd", "remove"])
    ap.add_argument("--name")
    ap.add_argument("--generate", action="store_true", help="generate a password and print it once")
    a = ap.parse_args(argv)
    accts = load_accounts()
    if a.cmd == "list":
        for n in sorted(accts):
            print(n)
        if not accts:
            print("(no console accounts - run: python3 ui/server.py user add --name <you>)")
        return
    if not a.name or not ACCOUNT.match(a.name):
        sys.exit("--name is required (3-32 chars: letters, digits . _ -, starting with a letter)")
    if a.cmd == "remove":
        if a.name not in accts:
            sys.exit("no such account")
        del accts[a.name]
        save_accounts(accts)
        return print(f"removed {a.name}")
    if a.cmd == "add" and a.name in accts:
        sys.exit("account exists (use 'passwd' to change the password)")
    if a.cmd == "passwd" and a.name not in accts:
        sys.exit("no such account")
    if a.generate:
        pw = secrets.token_urlsafe(14)
        print(f"password for {a.name} (shown once): {pw}")
    else:
        pw = getpass.getpass("Password (min 12 chars): ")
        if pw != getpass.getpass("Repeat: "):
            sys.exit("passwords differ")
    if len(pw) < 12:
        sys.exit("password must be at least 12 characters")
    rec = accts.get(a.name, {})
    rec.update({"name": a.name, "role": ROLE, "hash": hash_pw(pw)})
    rec.setdefault("created", time.strftime("%Y-%m-%d"))
    accts[a.name] = rec
    save_accounts(accts)
    audit("cli", f"user-{a.cmd}", a.name)
    print(f"{'created' if a.cmd == 'add' else 'password updated for'} {a.name}")


# ------------------------------------------------------------------------------ jobs
JOBS = {}
JOB_LOCK = threading.Lock()
RUNNING = {"id": None}


def run_job(job, argv, stdin_text):
    try:
        proc = subprocess.Popen(
            [str(ROOT / "drunix-net.sh")] + argv, cwd=ROOT, stdin=subprocess.PIPE if stdin_text else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"})
        if stdin_text:
            proc.stdin.write(stdin_text)
            proc.stdin.close()
        for line in proc.stdout:
            job["lines"].append(ANSI.sub("", line.rstrip("\n")))
        job["code"] = proc.wait()
    except Exception as e:  # noqa: BLE001
        job["lines"].append(f"internal error: {e}")
        job["code"] = 1
    finally:
        job["done"] = True
        job["finished"] = time.time()
        with JOB_LOCK:
            RUNNING["id"] = None


def start_job(action, params, who="?"):
    builder = ACTIONS.get(action)
    if not builder:
        raise BadRequest("unknown action")
    argv, stdin_text = builder(params)
    with JOB_LOCK:
        if RUNNING["id"]:
            raise BadRequest("another task is still running")
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "action": action, "who": who, "cmd": "drunix-net.sh " + " ".join(argv), "lines": [],
               "done": False, "code": None, "started": time.time()}
        JOBS[jid] = job
        RUNNING["id"] = jid
        for old in sorted(JOBS.values(), key=lambda j: j["started"])[:-30]:
            JOBS.pop(old["id"], None)
    audit(who, "task", job["cmd"])
    threading.Thread(target=run_job, args=(job, argv, stdin_text), daemon=True).start()
    return job


# ---------------------------------------------------------------------------- status
def docker_status(name):
    try:
        out = subprocess.run(["docker", "ps", "-a", "--filter", f"label=service={name}", "--format", "{{json .}}"],
                             capture_output=True, text=True, timeout=15).stdout
        rows = [json.loads(x) for x in out.splitlines() if x.strip()]
        return [{"name": r["Names"], "status": r["Status"], "image": r["Image"], "state": r["State"],
                 "health": ("healthy" if "(healthy)" in r["Status"] else "unhealthy" if "(unhealthy)" in r["Status"]
                            else "starting" if "starting" in r["Status"] else "")} for r in rows]
    except Exception:
        return None


def list_volumes():
    """Docker volumes of this network and the containers that still use them."""
    m = model()
    if not m:
        return []
    try:
        names = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"name=^{m['name']}_"],
                               capture_output=True, text=True, timeout=15).stdout.split()
        out = []
        for v in sorted(names):
            by = subprocess.run(["docker", "ps", "-a", "--filter", f"volume={v}", "--format", "{{.Names}}"],
                                capture_output=True, text=True, timeout=15).stdout.split()
            out.append({"name": v, "used_by": by})
        return out
    except Exception:  # noqa: BLE001
        return []


def _http_json(url, timeout=3):
    import urllib.request
    with urllib.request.urlopen(url, timeout=timeout) as r:  # only ever 127.0.0.1:<port from the generated model>
        return json.loads(r.read().decode())


def monitoring_state():
    """Prometheus/Grafana status, live scrape targets and a few key metrics (read-only)."""
    m = model()
    if not m:
        return {"model": False}
    mon, net = m["monitoring"], m["name"]
    out = {"model": True, "enabled": mon["enabled"], "prometheus_port": mon["prometheus_port"], "grafana_port": mon["grafana_port"],
           "prometheus": False, "grafana": False, "targets": [], "block_height": []}
    if not mon["enabled"]:
        return out
    try:
        names = subprocess.run(["docker", "ps", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=15).stdout.split()
        out["prometheus"] = f"{net}-prometheus" in names
        out["grafana"] = f"{net}-grafana" in names
    except Exception:  # noqa: BLE001
        pass
    base = f"http://127.0.0.1:{int(mon['prometheus_port'])}"
    if out["prometheus"]:
        try:
            now = datetime.datetime.now(datetime.timezone.utc)
            for t in _http_json(base + "/api/v1/targets")["data"]["activeTargets"]:
                lab = t.get("labels", {})
                age = None
                mt = re.match(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$", t.get("lastScrape", ""))
                if mt:   # Prometheus sends RFC3339 with nanoseconds and a UTC offset
                    try:
                        age = max(0, int((now - datetime.datetime.fromisoformat(mt.group(1) + ("+00:00" if mt.group(2) == "Z" else mt.group(2)))).total_seconds()))
                    except ValueError:
                        age = None
                out["targets"].append({"job": lab.get("job", ""), "instance": lab.get("instance", ""), "org": lab.get("org", ""),
                                       "health": t.get("health", "unknown"), "age": age, "error": (t.get("lastError") or "")[:160]})
            out["targets"].sort(key=lambda x: (x["health"] == "up", x["job"], x["instance"]))
            import urllib.parse
            q = urllib.parse.quote("ledger_blockchain_height")
            for r in _http_json(f"{base}/api/v1/query?query={q}")["data"]["result"]:
                out["block_height"].append({"instance": r["metric"].get("instance", ""), "channel": r["metric"].get("channel", ""), "height": r["value"][1]})
        except Exception as e:  # noqa: BLE001
            out["error"] = f"Prometheus is running but did not answer: {e}"
    return out


def secret_status():
    d = ROOT / "secrets"
    return sorted(f.stem for f in d.glob("*.pw")) if d.is_dir() else []


def list_users():
    """Enrolled application users per org (names + role attribute read from the public cert)."""
    m = model()
    out = {}
    for o in (m["orgs"] if m else []):
        base = ROOT / "organizations" / "peerOrganizations" / o["domain"] / "users"
        rows = []
        for d in sorted(base.glob("*@" + o["domain"])) if base.is_dir() else []:
            certs = sorted((d / "msp" / "signcerts").glob("*.pem"))
            if not certs:
                continue
            role = ""
            try:
                txt = subprocess.run(["openssl", "x509", "-in", str(certs[0]), "-noout", "-text"],
                                     capture_output=True, text=True, timeout=10).stdout
                mt = re.search(r'1\.2\.3\.4\.5\.6\.7\.8\.1:\s*\n\s*(\{.*\})', txt)
                if mt:
                    role = json.loads(mt.group(1)).get("attrs", {}).get("role", "")
            except Exception:  # noqa: BLE001
                pass
            name = d.name.split("@")[0]
            rows.append({"name": name, "role": role, "admin": name.lower() == "admin"})
        out[o["name"]] = rows
    return out


def list_chaincodes():
    base = REPO_ROOT / "chaincode"
    if not base.is_dir():
        return []
    return [{"name": d.name, "path": f"chaincode/{d.name}"} for d in sorted(base.iterdir())
            if d.is_dir() and (d / "main.go").exists()]


def channel_blocks():
    d = ROOT / "channel-artifacts"
    return sorted(f.stem for f in d.glob("*.block")) if d.is_dir() else []


def enrolled_orgs():
    m = model()
    if not m:
        return []
    return [o["name"] for o in m["orgs"]
            if (ROOT / "organizations" / "peerOrganizations" / o["domain"] / "users").is_dir()
            and any((ROOT / "organizations" / "peerOrganizations" / o["domain"] / "users").glob("Admin@*/msp/signcerts/*.pem"))]


def load_config():
    src = CONFIG if CONFIG.exists() else EXAMPLE
    cfg = yaml.safe_load(src.read_text()) or {}
    return {"config": cfg, "from_example": src == EXAMPLE}


def save_config(cfg):
    if not isinstance(cfg, dict):
        raise BadRequest("config must be an object")
    try:
        render.build_model(cfg)  # same validation as `generate`
    except render.ConfigError as e:
        raise BadRequest(str(e))
    tmp = CONFIG.with_suffix(".yaml.tmp")
    tmp.write_text("# Saved from the web console. Edit freely, then Generate.\n" + yaml.safe_dump(cfg, sort_keys=False))
    tmp.replace(CONFIG)


# ---------------------------------------------------------------------------- server
class Handler(BaseHTTPRequestHandler):
    server_version = "drunix-console"
    port = 0

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'")
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        origin = self.headers.get("Origin")
        return not origin or origin in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    def _auth(self):
        return session_for(self)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise BadRequest("body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def _guard(self):
        if not self._host_ok():
            self._send(403, {"error": "bad host/origin"})
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        path = self.path.split("?")[0]
        if path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        if not path.startswith("/api/"):
            f = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}.get(path)
            if not f:
                return self._send(404, {"error": "not found"})
            ctype = {"html": "text/html", "js": "text/javascript", "css": "text/css"}[f.rsplit(".", 1)[1]]
            return self._send(200, (STATIC / f).read_bytes(), ctype + "; charset=utf-8")
        sess = self._auth()
        if not sess:
            return self._send(401, {"error": "login required"})
        try:
            if path == "/api/me":
                return self._send(200, me_payload(sess))
            if path == "/api/volumes":
                return self._send(200, {"volumes": list_volumes()})
            if path == "/api/monitoring":
                return self._send(200, monitoring_state())
            if path == "/api/config":
                return self._send(200, load_config())
            if path == "/api/model":
                return self._send(200, {"model": model()})
            if path == "/api/status":
                m = model()
                return self._send(200, {"containers": docker_status(m["name"]) if m else [], "model": m,
                                        "secrets": secret_status(), "running": RUNNING["id"],
                                        "has_config": CONFIG.exists(), "enrolled": enrolled_orgs(),
                                        "channel_blocks": channel_blocks()})
            if path == "/api/users":
                return self._send(200, {"users": list_users()})
            if path == "/api/chaincodes":
                return self._send(200, {"chaincodes": list_chaincodes()})
            m = re.match(r"^/api/jobs/([0-9a-f]{12})$", path)
            if m:
                job = JOBS.get(m.group(1))
                if not job:
                    return self._send(404, {"error": "unknown job"})
                off = int((self.path.split("offset=")[1] if "offset=" in self.path else "0").split("&")[0] or 0)
                return self._send(200, {"id": job["id"], "action": job["action"], "cmd": job["cmd"],
                                        "lines": job["lines"][off:], "next": len(job["lines"]),
                                        "done": job["done"], "code": job["code"]})
            if path == "/api/jobs":
                return self._send(200, {"jobs": [{"id": j["id"], "cmd": j["cmd"], "done": j["done"], "code": j["code"]}
                                                 for j in sorted(JOBS.values(), key=lambda j: -j["started"])]})
            return self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    def do_PUT(self):
        self._write()

    def do_POST(self):
        self._write()

    def _write(self):
        if not self._guard():
            return
        if self.path == "/api/login" and self.command == "POST":
            try:
                b = self._body()
                sess, err = try_login(b.get("username", ""), b.get("password", ""))
            except (ValueError, KeyError):
                return self._send(400, {"error": "bad request"})
            if not sess:
                return self._send(401, {"error": err})
            data = json.dumps(me_payload(sess)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Set-Cookie", f"drunix_sid={sess['sid']}; HttpOnly; SameSite=Strict; Path=/; Max-Age={MAX_TTL}")
            self.end_headers()
            self.wfile.write(data)
            return
        sess = self._auth()
        if not sess:
            return self._send(401, {"error": "login required"})
        if not hmac.compare_digest(self.headers.get("X-CSRF", ""), sess["csrf"]):
            return self._send(403, {"error": "bad CSRF token - reload the page"})
        if self.path == "/api/logout" and self.command == "POST":
            with SESS_LOCK:
                SESSIONS.pop(sess["sid"], None)
            audit(sess["user"], "logout")
            return self._send(200, {"ok": True})
        try:
            body = self._body()
            if self.path == "/api/config" and self.command == "PUT":
                save_config(body)
                audit(sess["user"], "config-saved")
                return self._send(200, {"ok": True})
            if self.path == "/api/run" and self.command == "POST":
                job = start_job(body.get("action", ""), body.get("params") or {}, sess["user"])
                return self._send(200, {"job": job["id"], "cmd": job["cmd"]})
            return self._send(404, {"error": "not found"})
        except BadRequest as e:
            return self._send(400, {"error": str(e)})
        except (ValueError, KeyError) as e:
            return self._send(400, {"error": f"bad request: {e}"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "user":
        return cli_users(sys.argv[2:])
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8088)
    args = ap.parse_args()
    if not load_accounts():
        sys.exit("No console accounts yet. Create the first console account:\n  python3 ui/server.py user add --name <you>")
    srv = None
    for port in range(args.port, args.port + 20):
        Handler.port = port
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError as e:
            if e.errno != errno.EADDRINUSE:
                raise
            print(f"port {port} is in use (another console still running?) - trying {port + 1}", file=sys.stderr)
    if srv is None:
        sys.exit(f"no free port in {args.port}-{args.port + 19}; stop the old console or pass --port")
    args.port = Handler.port
    print(f"Drunix network console\n  open: http://127.0.0.1:{args.port}/\n"
          "  (local only; sign in with a console account; Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
