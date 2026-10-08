# How to use drunix-network-generic — step by step

This guide takes you from an empty machine to a running Drunix network with channels, users and deployed
chaincode. You can do every step either in the **web console** (Part A) or on the **command line** (Part B);
both run the same scripts, so you can mix them.

- [0. What you need](#0-what-you-need)
- [A. Using the web console](#a-using-the-web-console)
- [B. Using the command line](#b-using-the-command-line)
- [C. Common scenarios](#c-common-scenarios)
- [D. Multi-host deployment](#d-multi-host-deployment)
- [E. Day-2 operations](#e-day-2-operations)
- [F. Troubleshooting](#f-troubleshooting)

---

## 0. What you need

| Requirement | Check |
|---|---|
| Docker + Compose v2 | `docker compose version` |
| `jq`, `openssl` | `jq --version`, `openssl version` |
| Python 3 with `pyyaml`, `jinja2` | `python3 -c "import yaml, jinja2"` (else `pip install pyyaml jinja2`) |
| Fabric binaries `peer`, `configtxgen`, `osnadmin`, `fabric-ca-client` | found automatically in `./bin`, `$DRUNIX_BIN` or `../drunix/drunix-network/bin` |
| Images | `npcioss/drunix-peer`, `-vscc`, `-orderer`, `-ccenv`, `hyperledger/fabric-ca`, `yugabytedb/yugabyte`, `eqalpha/keydb` (plus `prom/prometheus`, `grafana/grafana` if monitoring is on). Versions are set under `images:` in `network.yaml` |

Memory: each committing peer brings its own YugabyteDB (~1 GB). Plan for that when you scale peers.

```bash
cd drunix-network-generic
```

---

## A. Using the web console

### A1. Create a console account and start it

The console needs a login. Create the first account on the host (it asks for the password, hidden, min 12 characters):

```bash
python3 ui/server.py user add --name admin          # create a console account
python3 ui/server.py                                # optional: --port 8088; picks the next port if it is busy
```

Open the URL it prints and sign in. Manage accounts with `python3 ui/server.py user list|passwd|remove --name X`
(accounts are created on the host only). Passwords are stored as salted scrypt hashes in `secrets/console-users.json`
(mode 600), never shown. After 5 wrong passwords a username is locked for 2 minutes. Sessions end after 30 minutes idle.
Everything done is logged to `logs/console-audit.log` (who, what, when).

The console also: listens on `127.0.0.1` only, checks `Host`/`Origin`, and generated credentials stay in `secrets/`.
Treat a console account like a root shell on this machine: it can start and stop containers.

### A2. Walk through the pages

| Page | What you do there |
|---|---|
| **Dashboard** | Eight-step checklist with a button per step, plus a live table of containers and their health. **"Run steps 2–6"** does generate → secrets → CAs → enroll → nodes in one go. |
| **Configure** | Describe the network (see A3), then **Save** or **Save & generate**. Validation errors appear in red under the form. |
| **Monitoring** | Is Prometheus/Grafana running, links to both, every scrape target (peers, orderers, CAs) with up/down and last scrape, and committed block height per node. Start/stop monitoring on its own. Refreshes every 10 s. |
| **Network** | Buttons for each bring-up step, stop/status, public-cert export, lite-peer recovery and (danger zone) destroy. Tick targets (orderers / an org / monitoring) to act on part of the network, e.g. only what runs on this host. |
| **Channels** | One row per channel: **Create** (genesis block → orderers join → peers join), **Join peers** (for newly added peers), **Info**. |
| **Users** | Enroll an application user with a role attribute (`issuer`, `superadmin`, …); list or revoke users. |
| **Chaincode** | **Deploy (all steps)**, or package / install / approve / commit one at a time; list committed chaincode; query and invoke. |
| **Activity** | History of tasks run in this session; re-open any output. |

The **console bar** at the bottom shows live output of the running task. Only one task runs at a time.

### A3. Describe your network (Configure page)

1. **Network** — name (prefix for docker objects), base domain, mode (`single-host` for one machine,
   `multi-host` for one server per organization), the orderer organization's name and how many Raft orderers
   (1, 3 or 5). In multi-host mode also give each orderer's address.
2. **Organizations** — add one row per organization. Name is free text (letters/digits, starts with a letter). Per org set:
   - **Committing (CP)** — commits blocks, owns that org's YugabyteDB/KeyDB. More CPs = more resilience.
   - **Lite (LP)** — endorses and runs chaincode. **Add LPs when transaction volume rises.**
   - **VSCC** — validation service. Keep it ≥ the number of CPs.
   - **Host / IP** — where the org runs (multi-host only).
3. **Channels** — add as many as you need. Each channel has its own member organizations (tick them), how many
   CP/LP peers of each member join, an endorsement policy (MAJORITY / ANY / ALL), batch timeout and max messages
   per block. Different channels can have different members and settings.
4. **Monitoring** — Prometheus + Grafana on/off.

Press **Save & generate**. The files appear in `generated/`.

### A4. Bring the network up

Dashboard → **Run steps 2–6**, or press the step buttons one by one:

1. **Create secrets** — random passwords for every CA, node and admin → `secrets/*.pw` (never displayed).
2. **Start CAs** — one Fabric CA per organization plus one for the orderer org.
3. **Enroll identities** — registers and enrolls CA admins, org admins, peers and orderers with TLS certificates.
4. **Start nodes** — orderers, then each org's YugabyteDB/KeyDB/CP/LP/VSCC, then monitoring.

Watch the Dashboard container table until everything is `running` / `healthy` (YugabyteDB can take a minute or two).

### A5. Create channels

Channels page → **Create** on each channel. When it finishes, the channel exists on every orderer and all member
peers have joined it.

### A6. Create users

Users page → pick the organization, a user name and the **role attribute** your chaincode checks (for example
`superadmin`). **Enroll user**. The certificate is stored under
`organizations/peerOrganizations/<org>.<domain>/users/<Name>@<org>.<domain>/msp`.

### A7. Deploy chaincode

Chaincode page → channel, **chaincode in repository** (name and path fill in for you), then **Deploy (all steps)**.
Then use **Query / invoke**: pick a function (the `superadmin` and `domain` contracts list their functions and show one
field per argument; "Custom function…" takes a raw JSON array) and the user to act as (from A6). The result is shown as a
table under the buttons; the console keeps the raw output.

**Super Admins page** is a shortcut for the `superadmin` chaincode: (1) enrol a `role=superadmin` user, (2) the table lists
the records on the ledger with Enable/Disable/Delete, (3) a form adds new ones.

---

## B. Using the command line

`./drunix-net.sh help` lists everything. The same flow, step by step:

### B1. Describe the network

```bash
./drunix-net.sh init               # interactive wizard -> network.yaml
# or: cp network.example.yaml network.yaml  and edit it
```

`network.yaml` fields are documented in the [README](README.md#configuration-networkyaml). Short example:

```yaml
network:  { name: drunix, domain: example.io, mode: single-host }
orderer:  { org_name: NetworkAuthority, count: 1 }
organizations:
  - { name: OrgOne, host: localhost, peers: { committing: 1, lite: 2, vscc: 1 } }
  - { name: OrgTwo, host: localhost, peers: { committing: 1, lite: 1, vscc: 1 } }
channels:
  - { name: sales, organizations: [OrgOne, OrgTwo], endorsement_policy: MAJORITY }
```

### B2. Generate, secrets, CAs, enrollment, nodes

```bash
./drunix-net.sh generate           # validates network.yaml, writes generated/
./drunix-net.sh secrets init       # random credentials -> secrets/*.pw (never printed)
./drunix-net.sh ca up
./drunix-net.sh enroll
./drunix-net.sh nodes up
./drunix-net.sh status
```

Shortcut for the five commands above: `./drunix-net.sh up` (add `--channels` to also create all channels).

### B3. Channels

```bash
./drunix-net.sh channel create sales
./drunix-net.sh channel list            # channels each org's first CP has joined
./drunix-net.sh channel info sales
```

### B4. Users

```bash
./drunix-net.sh user add --org OrgOne --name alice --role issuer --generate
./drunix-net.sh user add --org OrgOne --name root1 --role superadmin --attr dept=ops --generate
./drunix-net.sh user list --org OrgOne
./drunix-net.sh user revoke --org OrgOne --name alice
```

Without `--generate` you are asked for the password with hidden input.

### B5. Chaincode

All at once:

```bash
./drunix-net.sh chaincode deploy --channel sales --name superadmin --path ../chaincode/superadmin
```

Or each stage separately (they are separate scripts under `scripts/chaincode/`):

```bash
./drunix-net.sh chaincode package --name superadmin --path ../chaincode/superadmin --version 1.0
./drunix-net.sh chaincode install --channel sales --name superadmin --version 1.0     # lite peers
./drunix-net.sh chaincode approve --channel sales --name superadmin --version 1.0     # add --org X to approve per org
./drunix-net.sh chaincode commit  --channel sales --name superadmin --version 1.0
./drunix-net.sh chaincode list    --channel sales
```

Use it:

```bash
./drunix-net.sh chaincode invoke --channel sales --name superadmin --fn CreateSuperAdmin \
    --args '["superadmin1","Ravi Kumar","ravi@example.io"]' --user root1
./drunix-net.sh chaincode query  --channel sales --name superadmin --fn ListSuperAdmins --user root1
```

**Upgrade** a chaincode: change the code, run `package` / `install` / `approve` / `commit` again with a new
`--version` (the sequence increments automatically).

---

## C. Common scenarios

### Scale for heavier load
Raise `lite` (and `vscc` if validation is the bottleneck) for an org in `network.yaml` or on the Configure page →
**generate** → **nodes up `<org>`**. New LPs must then join channels (`channel join <name> <org>`) and get the
chaincode (`chaincode install --channel <name> --name <cc> --org <org>`).

### Add a channel with different members
Add a channel entry (or **+ Add channel**), generate, then `channel create <name>`. The orgs must already be in the
network. A channel may use only some of an org's peers: `organizations: [{ name: OrgOne, lite: 1, committing: 1 }, OrgTwo]`.

### Add a whole new organization
Add it to `network.yaml`, generate, then `ca up <org>`, `enroll <org>`, `nodes up <org>`. It can join **new**
channels immediately. Adding it to an **existing** channel needs a channel-config update, which this tool does not automate.

### Three or five orderers
Set `orderer.count` to 3 or 5 (odd numbers keep a Raft quorum). In multi-host mode give each orderer's address.

---

## D. Multi-host deployment

One server per organization (and for the orderers). Every host runs its own CA and keeps its own private keys;
only public certificates are exchanged.

1. Put the same `network.yaml` on every host with `mode: multi-host` and real addresses (not `localhost`) for
   each org and orderer. Run `./drunix-net.sh generate` on each.
2. On every host: `secrets init`, then `ca up <its org>` and `enroll <its org>`
   (the orderer host uses the orderer org name).
3. On every host: `./drunix-net.sh crypto export` → `dist/public-crypto-<org>.tar.gz`. Copy all bundles to all hosts and
   run `./drunix-net.sh crypto import dist/public-crypto-*.tar.gz` there.
4. On every host: `nodes up orderers` (orderer host) / `nodes up <its org>`.
5. On a machine that has imported everyone's public certificates: `channel create <name>`.
6. Chaincode: `install` runs against peers it can reach; each org runs `approve --org <its org>` from its own host;
   then one host runs `commit`.

Open the required ports between hosts (see `generated/model.json`: peers `20000+`, orderers `6050+`, CAs `40000+`).

---

## E. Day-2 operations

| Task | Command |
|---|---|
| Status | `./drunix-net.sh status` or the Dashboard |
| Stop everything (data kept) | `./drunix-net.sh down` |
| Start again | `./drunix-net.sh ca up && ./drunix-net.sh nodes up` |
| Recover a crash-looping lite peer | `./drunix-net.sh nodes reset-lp <org> <lpN>` then reinstall chaincode on it |
| Monitoring | Console → **Monitoring** page (status, links, live scrape-target table, block heights). Prometheus `http://localhost:9090`, Grafana `http://localhost:3000` (user `admin`, password in `secrets/grafana-admin.pw`); the dashboard **Drunix network overview** is provisioned under Dashboards → Drunix. After changing the CA template or enabling monitoring, run Generate, then Stop CAs / Start CAs so the CAs expose metrics. |
| Back up | `secrets/`, `organizations/` (esp. `fabric-ca/`), and the docker volumes `<name>_*` |
| Wipe the network | `./drunix-net.sh destroy` asks you to type the network name. By default it removes containers, volumes, crypto and artifacts and keeps `secrets/`; add `--keep-volumes`, `--keep-crypto` and/or `--remove-secrets` to choose. The console's **Destroy network…** button shows these as checkboxes. |

Never commit `secrets/`, `organizations/` or `network.yaml`; the folder's `.gitignore` already excludes them.

---

## F. Troubleshooting

| Symptom | What to do |
|---|---|
| "No console accounts yet" when starting | Create one: `python3 ui/server.py user add --name <you>` |
| "too many failed attempts" | Wait 2 minutes, or restart the console |
| `another task is still running` | Wait for the current task (console bar) to finish |
| `generate` fails with `ERROR: …` | The message names the field to fix in `network.yaml` |
| `secrets missing` | Run `secrets init` first |
| Enrollment fails | The CA must be up (`ca up`) and the secrets must be the ones the CA was started with. If you deleted `secrets/` after the CA was created, `destroy` and start over |
| YugabyteDB stays `starting` | It can take 1–2 minutes; check memory with `docker stats` |
| Lite peer keeps restarting (`no such block number … in index`) | `nodes reset-lp <org> <lpN>`, then re-run `chaincode install` for it |
| `install` fails with `EOF` / connection errors | The lite peer crashed mid-install (known Drunix issue). `nodes reset-lp`, then retry `install` |
| `access denied: … no 'role' attribute` | Use `--user <name>` of a user created with `--role …` for that call |
| Port already in use | Another stack uses the same ports; stop it or change `network.name`/org order (ports derive from org position) |
| Stale `FABRIC_CFG_PATH` / `CORE_PEER_*` in your shell | Ignored — the scripts reset them |

More background: [README.md](README.md) (design, security, known limits).
