# drunix-network-generic

A reusable, config-driven Drunix (Hyperledger Fabric fork) network. Organizations, peers per
organization, channels and their membership are described in one file (`network.yaml`) or
entered in a wizard — no script edits when the structure changes.

```
./drunix-net.sh init          # or: cp network.example.yaml network.yaml
./drunix-net.sh up            # generate -> secrets -> CAs -> enrol identities -> start nodes
./drunix-net.sh channel create mychannel
./drunix-net.sh chaincode deploy --channel mychannel --name superadmin --path ../chaincode/superadmin
```

**New here? Read [USAGE.md](USAGE.md)** (step by step, web console and command line).
A local web console covers every task: `python3 ui/server.py`, then open the printed URL.

This folder is independent of `drunix/drunix-network/` (the fixed two-org network). Nothing here
touches it, but the Fabric binaries (`peer`, `configtxgen`, `osnadmin`, `fabric-ca-client`) are found
in `./bin`, `$DRUNIX_BIN`, or `../drunix/drunix-network/bin`.

## Requirements

Docker + Compose v2, `jq`, `openssl`, Python 3 with `pyyaml` and `jinja2`, the Fabric binaries above, and
the images listed under `images:` in `network.yaml` (peer, vscc, orderer, ccenv, fabric-ca, YugabyteDB, KeyDB).

## Layout

| Path | Purpose |
|---|---|
| `network.yaml` | **the only file you edit** (git-ignored; template: `network.example.yaml`) |
| `drunix-net.sh` | entry point |
| `scripts/` | one script per concern: `init`, `generate`, `secrets`, `ca`, `enroll-nodes`, `users`, `nodes`, `channel`, `chaincode`, `crypto` |
| `scripts/chaincode/` | lifecycle split into `package`, `install`, `approve`, `commit` |
| `ui/` | local web console (`python3 ui/server.py`): standard-library Python backend + static page, no install step |
| `templates/`, `tools/render.py` | Jinja2 templates + generator (validates the config, derives ports/hosts) |
| `generated/` | rendered compose / configtx / monitoring / `model.json` (git-ignored, safe to delete) |
| `organizations/`, `channel-artifacts/`, `secrets/`, `dist/` | crypto, genesis blocks, credentials, packages (all git-ignored) |

## Configuration (`network.yaml`)

```yaml
network:  { name: drunix, domain: example.io, mode: single-host }   # or multi-host
orderer:  { org_name: NetworkAuthority, count: 3, hosts: [10.0.0.1, 10.0.0.2, 10.0.0.3] }  # 1, 3 or 5
organizations:
  - name: OrgOne                  # any name - asked in the wizard, not hard-coded
    host: 10.0.1.1                # multi-host: where this org runs
    peers: { committing: 2, lite: 4, vscc: 2 }
channels:
  - name: sales
    organizations: [OrgOne, OrgTwo]
    endorsement_policy: MAJORITY   # MAJORITY | ANY | ALL
  - name: audit
    organizations: [{ name: OrgOne, lite: 1, committing: 1 }, OrgTwo, OrgThree]   # subset of OrgOne's peers
    endorsement_policy: ALL
    batch: { timeout: 1s, max_message_count: 50 }
```

Every channel has its own members, endorsement policy, batching and peer subset, so different channels
can have different structures. Edit the file, run `./drunix-net.sh generate`, then bring up what is new.

### Peer model

A Drunix org is a peer *group*, scaled per role:

| Role | Does | Scale for |
|---|---|---|
| `committing` (CP) | pulls blocks, commits, owns the org's YugabyteDB + KeyDB | resilience / more state-DB capacity |
| `lite` (LP) | endorses, installs chaincode, forwards commits to its CP | **heavy transaction load** — add LPs |
| `vscc` | validation service for a CP | validation throughput |

Each CP gets its own YugabyteDB and KeyDB (named volumes). LPs and VSCCs are spread round-robin over the
CPs and share that CP's databases. Keep `vscc >= committing`; the generator warns otherwise.
Naming: `cp1.<org>.<domain>`, `lp1…`, `vs1…`; ports are allocated deterministically (see `generated/model.json`).

## Typical flow

```bash
./drunix-net.sh init                  # wizard (or edit network.yaml)
./drunix-net.sh generate              # validate + render
./drunix-net.sh secrets init          # random credentials -> secrets/*.pw, never printed
./drunix-net.sh ca up
./drunix-net.sh enroll                # CA admin, org admins, peers, orderers (+TLS)
./drunix-net.sh nodes up
./drunix-net.sh channel create sales  # genesis block, orderer join, peer join, anchor peers
./drunix-net.sh user add --org OrgOne --name issuer1 --role issuer --generate
./drunix-net.sh chaincode deploy --channel sales --name superadmin --path ../chaincode/superadmin
./drunix-net.sh chaincode invoke --channel sales --name superadmin --fn CreateSuperAdmin \
    --args '["superadmin1","Ravi","ravi@example.io"]' --user issuer1
```

`./drunix-net.sh up [--channels]` runs generate → secrets → ca → enroll → nodes (→ channel create).

### Chaincode lifecycle (each step separate)

```bash
chaincode package --name N --path DIR [--lang golang] [--version 1.0] [--no-vendor]
chaincode install --channel C --name N [--org X]          # lite peers only
chaincode approve --channel C --name N [--org X] [--policy EXPR] [--sequence N|auto]
chaincode commit  --channel C --name N [--policy EXPR]
```

Approve per org with `--org` (on that org's host in multi-host mode) or omit it to approve for all.
`chaincode deploy` just runs the four in order. Roles checked by chaincode come from the user's certificate
`role` attribute, set with `user add --role`.

## Web console

Create a login first: `python3 ui/server.py user add --name admin` (hidden password prompt), then `python3 ui/server.py [--port 8088]`
and open the printed URL. Pages: Dashboard (guided steps + container health), Configure (edit `network.yaml` as a form),
Network, Channels, Users, Chaincode, Super Admins, Activity.

**Access:** a login is required. Console accounts are created on the host (`python3 ui/server.py user add`). Salted scrypt password hashes in
`secrets/console-users.json`, HttpOnly SameSite session cookie + CSRF header, lockout after 5 failed logins, every task
audited in `logs/console-audit.log`.

It only calls `drunix-net.sh`: every action maps to a fixed argument list, inputs are validated (names, channel
and org must exist, chaincode path must be inside the repository, nothing starting with `-`), jobs run with no
stdin so nothing can prompt, one task at a time. It listens on `127.0.0.1` only and checks `Host`/`Origin`. It never reads or
returns secret values and creates users with generated passwords. Treat a console login like a root shell on the machine - do not
expose or proxy it.

## Security and secrets

- All CA / node / user / Grafana passwords are generated randomly into `secrets/*.pw` (dir `700`, files `600`,
  git-ignored). Nothing prints them.
- CA bootstrap passwords reach the CA containers as **docker secrets** (`/run/secrets/…`), not env vars or
  command lines. `fabric-ca-client` gets identity secrets through environment variables of that one process,
  never `argv`, so they do not appear in `ps` or logs. Shell tracing (`set -x`) is not used.
- `user add` asks for the password with hidden input (or `--generate`).
- TLS everywhere: CA, orderers (incl. the admin API with client auth), peers, VSCC. Node identities use
  NodeOUs (client / peer / admin / orderer).
- Multi-host: every host enrols its own org; private keys never leave it. Exchange only public material:
  `crypto export` on each host, `crypto import <tar>` on the others.

## Production features

| Concern | How |
|---|---|
| Persistence | named volumes for orderer WAL/ledger, peer ledgers, every YugabyteDB, KeyDB (AOF on), CAs, Prometheus, Grafana |
| Fault tolerance | `restart: unless-stopped`, healthchecks, `depends_on: service_healthy`, 3/5 Raft orderers, several CP/LP/VSCC |
| Logging | structured per-container logs, `json-file` rotation (`logging.max_size/max_files`), level via `logging.level` |
| Monitoring | Prometheus (scrapes every peer, orderer, CA operations endpoint) + Grafana with a provisioned starter dashboard (`templates/monitoring/`), ports from `monitoring:`; console **Monitoring** page shows target health |
| Networking | one docker network per deployment; in `multi-host` mode `extra_hosts` map every node name to its host |

## Known limits — read before production

- **Lite peers can crash** (known issue of this Drunix build, also in `drunix/drunix-network`): an LP may exit
  shortly after start and then loop on `no such block number … in index`. `./drunix-net.sh nodes reset-lp <org> <lpN>`
  recovers it (drops its ledger volume, rejoins; reinstall chaincode afterwards). It happened once in testing,
  right after the first chaincode launch, and did not recur after the reset.
- LPs mount the Docker socket to build chaincode (`CORE_VM_*`) — that grants root-equivalent access to the host.
  For hardened setups use chaincode-as-a-service and drop the mount.
- YugabyteDB runs with its default `yugabyte/yugabyte` credentials on the private docker network (no host port
  published). Enable DB auth and pass the secret through your orchestrator for stricter environments.
- One CA per org, no CA clustering. Back up `organizations/fabric-ca/*` and `secrets/`.
- The orderer admin API is called with an orderer's own TLS certificate; create a dedicated admin client cert
  if you need separation of duties.
- Adding an organization to an already-created channel (channel config update) is not automated. New channels,
  new peers, new users and chaincode upgrades are.
- Kubernetes manifests are not generated; the compose output is host-per-org and can be used as the basis.
- Resource limits are not set (Yugabyte needs ~1 GB per CP); add `deploy.resources` per your sizing.

## Verified

Tested on one host with the default images: CA start, enrolment of org admin / peers / orderer with TLS, 2 channels,
orderer + CP + LP + VSCC + YugabyteDB + KeyDB bring-up, channel create/join with anchor peers, chaincode
package → install → approve → commit, and invoke/query of `chaincode/superadmin` as a `role=superadmin` user.
Rendered (not started) and validated with `docker compose config`: a 3-org, 3-orderer multi-host layout with
different peer counts and per-channel peer subsets, and the monitoring stack. The web console was tested in a headless browser (all pages render) and through its API: input rejection, config
save/validate, generate, secrets, CAs, enrollment, user creation and destroy. A multi-host deployment across real
machines has **not** been run end to end. Prometheus + Grafana were run against a live 3-org / 3-orderer network: scrape targets, all dashboard queries and the provisioned dashboard were checked (`broadcast_processed_count` has no data until transactions flow).
