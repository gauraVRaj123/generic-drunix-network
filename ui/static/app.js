"use strict";
/* Drunix Network Console - talks to ui/server.py (same origin). No secrets ever pass through here. */

// ---------------------------------------------------------------- session + api
let CSRF = "";
let ME = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: { "X-CSRF": CSRF, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (res.status === 401 && path !== "/api/login") { showLogin(data.error && ME ? "Your session expired - sign in again." : ""); throw new Error("login required"); }
  if (!res.ok) { const err = new Error(data.error || `request failed (${res.status})`); err.code = data.code; throw err; }
  return data;
}

// ---------------------------------------------------------------- tiny DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const $ = (s) => document.querySelector(s);
const field = (label, input, hint) => h("label", {}, label, input, hint ? h("span", { class: "hint" }, hint) : null);
const sel = (opts, value, onchange) => {
  const s = h("select", {}, ...opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h("option", { value: v }, l); }));
  if (value != null && [...s.options].some((o) => o.value === value)) s.value = value;
  if (onchange) s.addEventListener("change", onchange);
  return s;
};
const badge = (text, kind = "") => h("span", { class: "badge " + kind }, text);
const empty = (title, text, ...extra) => h("div", { class: "empty" }, h("b", {}, title), text, ...extra);

// non-secret UI preferences (last channel, chaincode name...)
const pref = (k, d = "") => { try { return localStorage.getItem("drunix." + k) ?? d; } catch (_) { return d; } };
const setPref = (k, v) => { try { localStorage.setItem("drunix." + k, v); } catch (_) { /* ignore */ } };

function toast(msg, kind) {
  const t = h("div", { class: "toast " + (kind === true ? "bad" : kind || "") }, msg);
  $("#toasts").append(t); setTimeout(() => t.remove(), 4500);
}

function confirmDialog(title, msg, { label = "Confirm", danger = false, body = null, enable = null } = {}) {
  const d = $("#dlg"), slot = $("#dlg-body"), ok = $("#dlg-ok");
  $("#dlg-title").textContent = title; $("#dlg-msg").textContent = msg;
  slot.textContent = ""; if (body) slot.append(body);
  ok.textContent = label; ok.className = "primary" + (danger ? " danger" : "");
  const check = () => { ok.disabled = enable ? !enable() : false; };
  check(); slot.oninput = slot.onchange = check;     // "enable" lets a dialog require e.g. a typed name
  return new Promise((res) => { d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }); d.returnValue = ""; d.showModal(); });
}

// mark empty required inputs; returns true when all filled
function required(...pairs) {
  let ok = true;
  for (const [label, el] of pairs) {
    const bad = !String(el.value || "").trim();
    el.classList.toggle("invalid", bad);
    if (bad && ok) { toast(`${label} is required`, true); el.focus(); }
    if (bad) ok = false;
  }
  return ok;
}
const onEnter = (inputs, fn) => inputs.forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } }));

// ---------------------------------------------------------------- jobs + console
let current = null;   // active job id
const con = {
  out: () => $("#console-out"),
  open(cmd) { $("#console").classList.remove("collapsed"); $("#console-toggle").textContent = "Hide"; if (cmd) $("#console-cmd").textContent = "$ " + cmd; },
  state(k) { $("#console-state").className = "dot " + (k || ""); },
};
$("#console-toggle").addEventListener("click", () => {
  const c = $("#console"); c.classList.toggle("collapsed");
  $("#console-toggle").textContent = c.classList.contains("collapsed") ? "Show" : "Hide";
});
$("#console-clear").addEventListener("click", () => { con.out().textContent = ""; });
$("#console-size").addEventListener("click", () => $("#console").classList.toggle("tall"));
$("#console-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(con.out().textContent); toast("Output copied", "ok"); } catch (_) { toast("Copy not available in this browser", true); }
});

/** Runs a whitelisted action. Resolves to {code, lines, cmd} (null if it could not start). quiet = keep the console closed. */
async function runAction(action, params = {}, { quiet = false } = {}) {
  let started;
  try { started = await api("/api/run", { method: "POST", body: { action, params } }); } catch (e) { toast(e.message, true); return null; }
  const { job, cmd } = started;
  con.out().textContent = ""; $("#console-cmd").textContent = "$ " + cmd; con.state("busy");
  if (!quiet) con.open(cmd);
  current = job; setRun(true);
  let off = 0; const all = [];
  const out = con.out();
  let code = 1;
  for (;;) {
    let r;
    try { r = await api(`/api/jobs/${job}?offset=${off}`); } catch (e) { out.textContent += `\n${e.message}`; break; }
    if (r.lines.length) { out.textContent += r.lines.join("\n") + "\n"; off = r.next; all.push(...r.lines); out.scrollTop = out.scrollHeight; }
    if (r.done) {
      code = r.code;
      out.textContent += code === 0 ? "\n[finished OK]" : `\n[failed - exit code ${code}]`; out.scrollTop = out.scrollHeight;
      break;
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  con.state(code === 0 ? "ok" : "bad");
  if (!quiet) toast(code === 0 ? "Task finished" : "Task failed - see console", code === 0 ? "ok" : true);
  else if (code !== 0) con.open();
  current = null; setRun(false);
  await refreshStatus();
  if (PAGES[page].live) render();
  return { code, lines: all, cmd };
}

function setRun(on) {
  const p = $("#runstate"); p.textContent = on ? "task running" : "idle"; p.className = "pill " + (on ? "busy" : "idle");
  document.querySelectorAll("[data-action]").forEach((b) => { b.disabled = on; });
}

/** Button that runs one action and is disabled while any task runs. */
function actionBtn(text, action, params, cls = "", confirmMsg) {
  return h("button", {
    class: cls, "data-action": action,
    onclick: async () => {
      if (confirmMsg && !(await confirmDialog(text, confirmMsg, { danger: cls.includes("danger"), label: text }))) return;
      runAction(action, typeof params === "function" ? params() : params);
    },
  }, text);
}
/** Button with a custom async handler, disabled while a task runs. */
const taskBtn = (text, fn, cls = "") => h("button", { class: cls, "data-action": "x", onclick: fn }, text);

// ---------------------------------------------------------------- state
let STATE = { status: null, users: {}, chaincodes: [] };
async function refreshStatus() { try { STATE.status = await api("/api/status"); } catch (_) { /* keep old */ } }
async function loadUsers() { try { STATE.users = (await api("/api/users")).users; } catch (_) { STATE.users = {}; } return STATE.users; }
async function loadChaincodes() { try { STATE.chaincodes = (await api("/api/chaincodes")).chaincodes; } catch (_) { STATE.chaincodes = []; } return STATE.chaincodes; }

const model = () => STATE.status?.model;
const orgsOf = () => (model()?.orgs || []).map((o) => o.name);
const channelsOf = () => model()?.channels || [];

// "RegulatoryAuthority|sa1" style options for acting-user pickers
function userOptions(users, { onlyRole } = {}) {
  const opts = [];
  for (const [org, list] of Object.entries(users)) for (const u of list) {
    if (onlyRole && u.role !== onlyRole) continue;
    opts.push([`${org}|${u.admin ? "" : u.name}`, `${u.name}${u.admin ? " (org admin)" : ""} · ${org}${u.role ? " · role: " + u.role : ""}`]);
  }
  return opts;
}
const splitUser = (v) => { const [org, user] = (v || "|").split("|"); return { org, user }; };

// ---------------------------------------------------------------- result rendering (query / invoke)
const LOGLINE = /^\d{4}-\d{2}-\d{2} /;
function hintFor(text) {
  if (/no 'role' attribute|access denied|requires role|not a super admin/i.test(text)) return "The chosen user's certificate lacks the required role. Pick a user with role superadmin (Users page).";
  if (/ENDORSEMENT_POLICY_FAILURE/.test(text)) return "Not enough organizations endorsed the transaction. Make sure peers of every channel org are running (Dashboard).";
  if (/already exists/i.test(text)) return "That ID or email is already in use.";
  if (/connection refused|context deadline|transport/i.test(text)) return "A peer is not reachable. Check the Dashboard; a crashed lite peer can be recovered under Network → Recover a lite peer.";
  if (/no enrolled user/i.test(text)) return "That user is not enrolled in the organization used for the call.";
  if (/not found|does not exist|no such/i.test(text)) return "The record or chaincode was not found. Check the chaincode is committed on this channel.";
  return "";
}
function parseOutput(res) {
  const text = res.lines.join("\n");
  const body = res.lines.filter((l) => !LOGLINE.test(l) && l.trim());
  let json; let raw = "";
  for (let i = body.length - 1; i >= 0; i--) { const l = body[i].trim(); if (/^[[{"]/.test(l)) { try { json = JSON.parse(l); raw = l; break; } catch (_) { /* not json */ } } }
  const tx = text.match(/txid \[(\w+)\] committed with status \((\w+)\)/);
  const errs = res.lines.filter((l) => /^Error:|^ERR /.test(l)).map((l) => l.replace(/^ERR /, ""));
  return { text, body, json, raw, tx, errs };
}
function dataTable(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const fmt = (v) => (v && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", {}, c)))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...cols.map((c) => h("td", {}, c === "status" ? badge(fmt(r[c]), r[c] === "ACTIVE" ? "ok" : "warn") : fmt(r[c]))))))));
}
function renderResult(box, kind, res) {
  box.textContent = "";
  if (!res) return;
  const p = parseOutput(res);
  if (kind === "invoke") {
    if (p.tx && p.tx[2] === "VALID") box.append(h("div", { class: "ok-box" }, "✓ Transaction committed (VALID). ", h("span", { class: "muted" }, "txid " + p.tx[1].slice(0, 16) + "…")));
    else {
      const msg = (p.errs[0] || (p.tx ? "Transaction was rejected: " + p.tx[2] : "Transaction failed")).replace(/^Error: /, "");
      box.append(h("div", { class: "err" }, msg), p.errs.length || p.tx ? null : h("pre", { class: "json" }, p.body.slice(-8).join("\n")));
      const hint = hintFor(p.text); if (hint) box.append(h("div", { class: "note" }, hint));
    }
    return;
  }
  if (res.code !== 0) {
    box.append(h("div", { class: "err" }, (p.errs[0] || p.body.slice(-3).join("\n") || "Query failed").replace(/^Error: /, "")));
    const hint = hintFor(p.text); if (hint) box.append(h("div", { class: "note" }, hint));
    return;
  }
  if (Array.isArray(p.json) && !p.json.length) { box.append(empty("No records", "The query succeeded and returned an empty list.")); return; }
  if (Array.isArray(p.json) && p.json.every((r) => r && typeof r === "object")) box.append(dataTable(p.json));
  else if (p.json && typeof p.json === "object") box.append(dataTable([p.json]));
  box.append(h("details", { class: "mt" }, h("summary", { class: "muted" }, "Raw output"),
    h("pre", { class: "json" }, p.json !== undefined ? JSON.stringify(p.json, null, 2) : p.body.join("\n"))));
}
function call(kind, { channel, name, fn, args, user, org }, opts) {
  return runAction(kind === "query" ? "cc_query" : "cc_invoke", { channel, name, fn, args: JSON.stringify(args || []), user: user || "", org: org || "" }, opts);
}

// ---------------------------------------------------------------- pages
const PAGES = {
  dashboard: { title: "Dashboard", icon: "◎", sub: "Where your network stands and what to do next.", render: pageDashboard, live: true },
  configure: { title: "Configure", icon: "⚙", sub: "Describe organizations, peers and channels. Saved to network.yaml.", render: pageConfigure },
  network: { title: "Network", icon: "⛓", sub: "Start, stop and recover the nodes.", render: pageNetwork },
  channels: { title: "Channels", icon: "⇄", sub: "Create channels and join peers.", render: pageChannels, live: true },
  users: { title: "Users", icon: "☺", sub: "Enroll application users and set the role their certificate carries.", render: pageUsers },
  chaincode: { title: "Chaincode", icon: "▤", sub: "Deploy contracts, then query and invoke them.", render: pageChaincode },
  superadmin: { title: "Super Admins", icon: "★", sub: "Create and manage Super Admin records on the ledger.", render: pageSuperAdmin },
  monitoring: { title: "Monitoring", icon: "∿", sub: "Prometheus and Grafana: is every component up, and how is it doing?", render: pageMonitoring, live: true },
  activity: { title: "Activity", icon: "☰", sub: "Tasks run in this session.", render: pageActivity, live: true },
};
let page = "dashboard", pageTimer = null;
const pageFromHash = () => { const m = location.hash.match(/^#\/(\w+)/); return m && PAGES[m[1]] ? m[1] : "dashboard"; };
function go(p) { page = p; history.replaceState(null, "", "#/" + p); render(); }
window.addEventListener("hashchange", () => { const p = pageFromHash(); if (p !== page) { page = p; render(); } });

function render() {
  clearInterval(pageTimer);
  const menu = $("#menu"); menu.textContent = "";
  for (const [k, v] of Object.entries(PAGES)) menu.append(h("button", { class: k === page ? "active" : "", "aria-current": k === page ? "page" : null, onclick: () => go(k) }, h("span", { class: "ic" }, v.icon), v.title));
  $("#title").textContent = PAGES[page].title; $("#subtitle").textContent = PAGES[page].sub;
  document.title = PAGES[page].title + " · Drunix";
  const m = model();
  $("#netname").textContent = m ? `${m.name} · ${m.mode}` : "no network generated yet";
  const view = $("#view"); view.textContent = "";
  Promise.resolve(PAGES[page].render(view)).then(() => setRun(!!current || !!STATE.status?.running))
    .catch((e) => view.append(h("div", { class: "err" }, e.message)));
}

// ---- dashboard
function pageDashboard(view) {
  const s = STATE.status, m = s.model, cs = s.containers || [];
  const has = (re) => cs.some((c) => re.test(c.name) && c.state === "running");
  const orgs = m?.orgs || [];
  const steps = [
    { t: "Describe the network", d: "Organizations, peers per org, channels", done: s.has_config, goto: ["configure", "Open"] },
    { t: "Generate files", d: "Validates the config, renders compose + configtx", done: !!m, btn: actionBtn("Generate", "generate") },
    { t: "Create secrets", d: `${s.secrets.length} credential file(s) in secrets/ (values never shown)`, done: s.secrets.length > 0, btn: actionBtn("Create", "secrets_init") },
    { t: "Start CAs", d: "One Fabric CA per organization + the orderer org", done: has(/^ca\./), btn: actionBtn("Start", "ca_up") },
    { t: "Enroll identities", d: "Admins, peers, orderers incl. TLS certificates", done: orgs.length > 0 && (s.enrolled || []).length === orgs.length, btn: actionBtn("Enroll", "enroll") },
    { t: "Start nodes", d: "Orderers, peers, YugabyteDB, KeyDB, monitoring", done: has(/^(cp|lp|vs)\d/), btn: actionBtn("Start", "nodes_up") },
    { t: "Create channels", d: "Genesis block, orderer join, peer join", done: !!m && m.channels.length > 0 && m.channels.every((c) => (s.channel_blocks || []).includes(c.name)), goto: ["channels", "Open"] },
    { t: "Deploy chaincode", d: "Package, install, approve, commit", done: false, goto: ["chaincode", "Open"] },
    { t: "Create a Super Admin", d: "Enroll a role=superadmin user, then add the record", done: false, goto: ["superadmin", "Open"] },
  ];
  const next = steps.findIndex((x) => !x.done);

  // summary
  const running = cs.filter((c) => c.state === "running").length, bad = cs.filter((c) => c.state !== "running" || c.health === "unhealthy").length;
  const stat = (n, l) => h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, l));
  view.append(h("div", { class: "stats" }, stat(orgs.length, "organizations"), stat(m?.channels.length || 0, "channels"),
    stat(`${running}/${cs.length}`, "containers running"), stat(running === 0 ? "—" : bad, running === 0 ? "stopped" : bad ? "need attention" : "problems")));

  const anyData = s.secrets.length > 0 || (s.enrolled || []).length > 0 || (s.channel_blocks || []).length > 0;
  if (!m) view.append(h("div", { class: "note" }, "Nothing generated yet. Use Configure to describe the network, then follow the steps below."));
  else if (running === 0 && !anyData) view.append(h("div", { class: "note info" }, h("b", {}, "Fresh start. "), `Network “${m.name}” has no containers, secrets or crypto material right now. Work through the steps below, or run them all at once.`));
  else if (running === 0) view.append(h("div", { class: "note" }, h("b", {}, "Network stopped. "), `Network “${m.name}” has no running containers; its data volumes and credentials are kept. `,
    actionBtn("Start network", "up", {}, "primary sm")));
  const list = h("div", { class: "steps" });
  steps.forEach((st, i) => list.append(h("div", { class: "step" + (st.done ? " done" : i === next ? " next" : "") },
    h("div", { class: "n" }, st.done ? "✓" : String(i + 1)), h("div", { class: "grow" }, h("b", {}, st.t), h("p", {}, st.d)),
    st.btn || (st.goto ? h("button", { onclick: () => go(st.goto[0]) }, st.goto[1]) : null))));
  const stepsCard = h("div", { class: "card" }, h("div", { class: "head" }, h("div", {}, h("h2", {}, "Guided setup"),
    h("p", { class: "muted" }, next < 0 ? "Everything is set up." : `Next: ${steps[next].t}`)), h("span", { class: "spacer" }),
    actionBtn("Run steps 2–6 in one go", "up", {}, "primary")), list);

  const rows = [...cs].sort((a, b) => (a.state === "running" && a.health !== "unhealthy") - (b.state === "running" && b.health !== "unhealthy") || a.name.localeCompare(b.name));
  const t = h("table", {}, h("thead", {}, h("tr", {}, ...["Container", "State", "Health"].map((x) => h("th", {}, x)))),
    h("tbody", {}, ...rows.map((c) => h("tr", {}, h("td", {}, c.name, h("small", {}, c.image)), h("td", {}, badge(c.state, c.state === "running" ? "ok" : "bad")),
      h("td", {}, c.health ? badge(c.health, c.health === "healthy" ? "ok" : c.health === "starting" ? "warn" : "bad") : "")))));
  const ctrCard = h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Containers"), h("span", { class: "spacer" }), h("span", { class: "muted" }, "auto-refresh 8s"),
    h("button", { class: "sm", onclick: async () => { await refreshStatus(); render(); } }, "Refresh")),
    cs.length ? h("div", { class: "table-wrap" }, t) : empty("Nothing is running yet", "Follow the guided setup."));
  view.append(h("div", { class: "two" }, stepsCard, ctrCard));
  pageTimer = setInterval(async () => { if (!current) { await refreshStatus(); if (page === "dashboard") render(); } }, 8000);
}

// ---- configure (edits network.yaml)
async function pageConfigure(view) {
  const { config, from_example } = await api("/api/config");
  const cfg = config; cfg.network ||= {}; cfg.orderer ||= {}; cfg.organizations ||= []; cfg.channels ||= []; cfg.monitoring ||= {};
  const err = h("div", { class: "err", style: "display:none" });
  if (from_example) view.append(h("div", { class: "note info" }, "No network.yaml yet - this is the example. Change it and press Save."));

  const bind = (obj, key, type) => (e) => { const v = e.target.value; obj[key] = type === "int" ? parseInt(v, 10) || 0 : v; };
  const inp = (obj, key, type = "text", extra = {}) => h("input", { type: type === "int" ? "number" : "text", value: obj[key] ?? "", min: type === "int" ? 1 : null, oninput: bind(obj, key, type), ...extra });

  const net = h("div", { class: "grid cols2" },
    field("Network name", inp(cfg.network, "name")), field("Base domain", inp(cfg.network, "domain")),
    field("Mode", sel(["single-host", "multi-host"], cfg.network.mode, (e) => { cfg.network.mode = e.target.value; })),
    field("Orderer organization", inp(cfg.orderer, "org_name")),
    field("Orderers", sel([["1", "1"], ["3", "3 (recommended)"], ["5", "5"]], String(cfg.orderer.count), (e) => { cfg.orderer.count = parseInt(e.target.value, 10); }), "Raft needs 1, 3 or 5"),
    field("Orderer addresses", h("input", { value: (cfg.orderer.hosts || []).join(", "), placeholder: "multi-host only, comma separated", oninput: (e) => { cfg.orderer.hosts = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); } })));
  view.append(h("div", { class: "card" }, h("h2", {}, "Network"), h("div", { class: "mt" }, net)));

  const orgBody = h("tbody");
  // channel membership is stored by organization name: keep it in sync when an organization is renamed or removed
  const memberName = (x) => (typeof x === "string" ? x : x.name);
  const renameInChannels = (from, to) => {
    if (!from || from === to) return;
    cfg.channels.forEach((c) => (c.organizations || []).forEach((x, i) => { if (memberName(x) === from) { if (typeof x === "string") c.organizations[i] = to; else x.name = to; } }));
  };
  const dropFromChannels = (name) => cfg.channels.forEach((c) => { c.organizations = (c.organizations || []).filter((x) => memberName(x) !== name); });
  const pruneChannels = () => { const known = cfg.organizations.map((o) => o.name).filter(Boolean); cfg.channels.forEach((c) => { c.organizations = (c.organizations || []).filter((x) => known.includes(memberName(x))); }); };
  const nameInput = (o) => h("input", { type: "text", value: o.name ?? "", placeholder: "OrgName", autocomplete: "off",
    oninput: (e) => { const old = o.name; o.name = e.target.value.trim(); renameInChannels(old, o.name); drawChannels(); } });
  const drawOrgs = () => {
    orgBody.textContent = "";
    cfg.organizations.forEach((o, i) => {
      o.peers ||= { committing: 1, lite: 1, vscc: 1 };
      orgBody.append(h("tr", {}, h("td", {}, nameInput(o)), h("td", {}, inp(o, "host")),
        ...["committing", "lite", "vscc"].map((k) => h("td", {}, inp(o.peers, k, "int", { max: 9, onchange: () => drawChannels() }))),
        h("td", {}, h("button", { class: "danger sm", onclick: () => { dropFromChannels(o.name); cfg.organizations.splice(i, 1); drawOrgs(); drawChannels(); } }, "Remove"))));
    });
    if (!cfg.organizations.length) orgBody.append(h("tr", {}, h("td", { colspan: 6 }, empty("No organizations", "Add at least one."))));
  };
  view.append(h("div", { class: "card" }, h("h2", {}, "Organizations"),
    h("p", { class: "muted" }, "Scale each role per organization. Add lite peers for heavy transaction load; keep VSCC ≥ committing peers."),
    h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Organization", "Host / IP", "Committing (CP)", "Lite (LP)", "VSCC", ""].map((x) => h("th", {}, x)))), orgBody)),
    h("div", { class: "row mt" }, h("button", { onclick: () => { cfg.organizations.push({ name: "", host: "localhost", peers: { committing: 1, lite: 1, vscc: 1 } }); drawOrgs(); drawChannels(); } }, "+ Add organization"))));
  drawOrgs();

  const chBox = h("div");
  const drawChannels = () => {
    chBox.textContent = "";
    cfg.channels.forEach((c, i) => {
      c.organizations ||= []; c.batch ||= {};
      const names = cfg.organizations.map((o) => o.name).filter(Boolean);
      const unnamed = cfg.organizations.length - names.length;
      const idx = (n) => c.organizations.findIndex((x) => (typeof x === "string" ? x : x.name) === n);
      const members = h("div", { class: "members" });
      names.forEach((n) => {
        const k = idx(n), entry = k >= 0 ? c.organizations[k] : null, org = cfg.organizations.find((o) => o.name === n);
        if (entry && typeof entry === "object") for (const key of ["committing", "lite"]) if (entry[key] > org.peers[key]) entry[key] = Math.max(1, org.peers[key] || 1);   // the org now has fewer peers
        const subIn = (key, max) => h("input", { type: "number", min: 1, max, title: `${key} peers joined`, value: entry && typeof entry === "object" ? entry[key] ?? max : max,
          onchange: (e) => { const cur = c.organizations[idx(n)]; const o = typeof cur === "object" ? cur : { name: n }; o[key] = parseInt(e.target.value, 10) || 1; c.organizations[idx(n)] = o; } });
        members.append(h("div", { class: "member" }, h("label", { class: "check" }, h("input", { type: "checkbox", checked: k >= 0,
          onchange: (e) => { if (e.target.checked) c.organizations.push(n); else c.organizations.splice(idx(n), 1); drawChannels(); } }), n),
          k >= 0 ? h("span", { class: "muted" }, "CP", subIn("committing", org.peers.committing), "LP", subIn("lite", org.peers.lite)) : null));
      });
      chBox.append(h("div", { class: "channel-card" }, h("div", { class: "grid cols2" },
        field("Channel name", inp(c, "name"), "lowercase letters, digits, - ."),
        field("Endorsement policy", sel(["MAJORITY", "ANY", "ALL"], c.endorsement_policy || "MAJORITY", (e) => { c.endorsement_policy = e.target.value; })),
        field("Batch timeout", inp(c.batch, "timeout")), field("Max messages per block", inp(c.batch, "max_message_count", "int"))),
        h("p", { class: "muted", style: "margin:10px 0 6px" }, "Member organizations (and how many of their CP / LP peers join this channel):"), members,
        unnamed ? h("p", { class: "muted", style: "margin:6px 0 0" }, `${unnamed} organization${unnamed > 1 ? "s have" : " has"} no name yet - name ${unnamed > 1 ? "them" : "it"} above to add ${unnamed > 1 ? "them" : "it"} to this channel.`) : null,
        !names.length ? h("p", { class: "muted", style: "margin:6px 0 0" }, "Add organizations above first.") : null,
        h("div", { class: "row mt" }, h("button", { class: "danger sm", onclick: () => { cfg.channels.splice(i, 1); drawChannels(); } }, "Remove channel"))));
    });
    if (!cfg.channels.length) chBox.append(empty("No channels", "Add one below."));
  };
  view.append(h("div", { class: "card" }, h("h2", {}, "Channels"), h("div", { class: "mt" }, chBox),
    h("button", { onclick: () => { cfg.channels.push({ name: "", organizations: [], endorsement_policy: "MAJORITY", batch: { timeout: "2s", max_message_count: 10 } }); drawChannels(); } }, "+ Add channel")));
  drawChannels();

  view.append(h("div", { class: "card" }, h("h2", {}, "Monitoring"), h("div", { class: "mt" },
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: cfg.monitoring.enabled !== false, onchange: (e) => { cfg.monitoring.enabled = e.target.checked; } }), "Prometheus + Grafana"))));

  const save = async (then) => {
    err.style.display = "none"; pruneChannels();
    try { await api("/api/config", { method: "PUT", body: cfg }); STATE.status.has_config = true; if (then) then(); else toast("Saved network.yaml", "ok"); }
    catch (e) { err.textContent = e.message; err.style.display = "block"; err.scrollIntoView({ block: "center" }); }
  };
  view.append(err, h("div", { class: "row" }, h("button", { class: "primary", onclick: () => save() }, "Save"),
    taskBtn("Save & generate", () => save(() => runAction("generate")))));
}

// ---- network
async function pageNetwork(view) {
  const m = model();
  if (!m) return view.append(h("div", { class: "note" }, "Generate the network first (Configure → Save & generate)."));
  const picked = new Set();
  const chips = h("div", { class: "chips" });
  const names = ["orderers", ...m.orgs.map((o) => o.name), ...(m.monitoring.enabled ? ["monitoring"] : [])];
  names.forEach((n) => chips.append(h("button", { class: "chip", "aria-pressed": "false", onclick: (e) => { picked.has(n) ? picked.delete(n) : picked.add(n); e.target.classList.toggle("on", picked.has(n)); e.target.setAttribute("aria-pressed", picked.has(n)); } }, n)));
  const selTargets = () => [...picked];
  const orgOnly = () => selTargets().filter((x) => x !== "orderers" && x !== "monitoring").concat(picked.has("orderers") ? [m.orderer_org.name] : []);

  view.append(h("div", { class: "card" }, h("h2", {}, "Targets"),
    h("p", { class: "muted" }, "Leave everything unselected to act on the whole network. In multi-host mode select only what runs on this machine."), chips));
  view.append(h("div", { class: "card" }, h("h2", {}, "Bring up"),
    h("div", { class: "row mt" }, actionBtn("1 · Create secrets", "secrets_init"), actionBtn("2 · Start CAs", "ca_up", () => ({ targets: orgOnly() })),
      actionBtn("3 · Enroll identities", "enroll", () => ({ targets: orgOnly() })), actionBtn("4 · Start nodes", "nodes_up", () => ({ targets: selTargets() }), "primary")),
    h("div", { class: "row center mt" }, h("label", { class: "check" }, h("input", { type: "checkbox", id: "up-ch" }), "also create channels"),
      actionBtn("All steps (generate → … → nodes)", "up", () => ({ channels: $("#up-ch").checked })))));
  view.append(h("div", { class: "card" }, h("h2", {}, "Operate"),
    h("div", { class: "row mt" }, actionBtn("Status", "nodes_status", () => ({ targets: selTargets() })),
      actionBtn("Stop nodes", "nodes_down", () => ({ targets: selTargets() }), "", "Stop the selected nodes? Data volumes are kept."),
      actionBtn("Stop CAs", "ca_down", () => ({ targets: orgOnly() })),
      actionBtn("Stop everything", "down", {}, "", "Stop all containers? Data volumes are kept."), actionBtn("Export public certs", "crypto_export", {}))));

  const orgSel = sel(m.orgs.map((o) => o.name)), lpSel = sel([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ["lp" + n, "lp" + n]));
  view.append(h("div", { class: "card" }, h("h2", {}, "Recover a lite peer"),
    h("p", { class: "muted" }, "Use when a lite peer keeps restarting (\"no such block number … in index\"). It drops that peer's ledger volume and re-joins its channels; reinstall chaincode afterwards."),
    h("div", { class: "row mt" }, field("Organization", orgSel), field("Lite peer", lpSel), actionBtn("Reset lite peer", "reset_lp", () => ({ org: orgSel.value, lp: lpSel.value }), "danger", "Drop this lite peer's ledger volume and re-join it?"))));

  // ---- cleanup: Docker volumes + secrets
  const volBox = h("div"), secBox = h("div");
  const drawVolumes = async () => {
    volBox.textContent = "";
    let vols = [];
    try { vols = (await api("/api/volumes")).volumes; } catch (e) { return volBox.append(h("div", { class: "err" }, e.message)); }
    if (!vols.length) return volBox.append(empty("No volumes", "Nothing to clean up."));
    const unused = vols.filter((v) => !v.used_by.length).map((v) => v.name);
    const rm = async (names, what) => {
      if (!(await confirmDialog("Remove volume data", `Permanently delete ${what}? Ledger, state-database and orderer data in it is lost.`, { label: "Delete", danger: true }))) return;
      await runAction("volumes_remove", { names }); await drawVolumes();
    };
    volBox.append(h("div", { class: "table-wrap scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Volume", "Used by", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...vols.map((v) => h("tr", {}, h("td", {}, v.name),
        h("td", {}, v.used_by.length ? h("span", {}, badge("in use", "warn"), " ", h("span", { class: "muted" }, v.used_by.join(", "))) : badge("unused", "ok")),
        h("td", {}, v.used_by.length ? h("button", { class: "sm", disabled: true, title: "Stop its container first" }, "Remove") : taskBtn("Remove", () => rm([v.name], v.name), "danger sm"))))))),
      h("div", { class: "row mt" }, unused.length ? taskBtn(`Remove all unused (${unused.length})`, () => rm(unused, `${unused.length} unused volume(s)`), "danger") : null));
    setRun(!!current);
  };
  view.append(h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Docker volumes"), h("span", { class: "spacer" }), h("button", { onclick: drawVolumes }, "Refresh")),
    h("p", { class: "muted" }, "Persistent data of this network (ledgers, YugabyteDB, KeyDB, orderers, CAs). A volume that a container still uses cannot be removed - stop the nodes first."), volBox));
  drawVolumes();

  const drawSecrets = () => {
    secBox.textContent = "";
    const names = STATE.status?.secrets || [];
    if (!names.length) return secBox.append(empty("No secrets", "Create them with “Create secrets” above."));
    const rmS = async (list, what) => {
      if (!(await confirmDialog("Remove secrets", `Delete ${what}? Values are never shown, so they cannot be recovered - create new ones with “Create secrets” (identities already enrolled keep their certificates).`, { label: "Delete", danger: true }))) return;
      await runAction("secrets_remove", { names: list }); drawSecrets();
    };
    secBox.append(h("div", { class: "table-wrap scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Secret (value hidden)"), h("th", {}, ""))),
      h("tbody", {}, ...names.map((n) => h("tr", {}, h("td", {}, n), h("td", {}, taskBtn("Remove", () => rmS([n], n), "danger sm"))))))),
      h("div", { class: "row mt" }, taskBtn(`Remove all (${names.length})`, () => rmS(names, `all ${names.length} secrets`), "danger")));
    setRun(!!current);
  };
  view.append(h("div", { class: "card" }, h("h2", {}, "Secrets"),
    h("p", { class: "muted" }, "Credential files in secrets/ (CA, node, admin and user passwords). Console sign-in accounts are stored separately and are never touched here."), secBox));
  drawSecrets();

  const destroy = async () => {
    let nVols = 0; try { nVols = (await api("/api/volumes")).volumes.length; } catch (_) { /* shown as 0 */ }
    const nSecrets = (STATE.status?.secrets || []).length;
    const opt = (checked, title, detail) => { const cb = h("input", { type: "checkbox", checked }); return [cb, h("label", { class: "check opt" }, cb, h("span", {}, h("b", {}, title), h("small", { class: "muted" }, detail)))]; };
    const [cVol, rVol] = opt(true, `Docker volumes (${nVols})`, "Peer ledgers, state databases, orderer data. This cannot be undone.");
    const [cCrypto, rCrypto] = opt(true, "Crypto material and channel artifacts", "Certificates, keys, genesis blocks and chaincode packages.");
    const [cSec, rSec] = opt(false, `Secrets (${nSecrets} file${nSecrets === 1 ? "" : "s"})`, "CA, node and user passwords in secrets/. Leave unticked if you will recreate the same network.");
    const typed = h("input", { placeholder: m.name, autocomplete: "off" });
    const body = h("div", { class: "opts" }, h("p", { class: "muted" }, "Always removed: all containers of this network and its Docker network. Also remove:"),
      rVol, rCrypto, rSec, field(`Type "${m.name}" to confirm`, typed));
    if (!(await confirmDialog(`Destroy network “${m.name}”`, "Choose what to delete together with the network.", { label: "Destroy network", danger: true, body, enable: () => typed.value === m.name }))) return;
    const r = await runAction("destroy", { confirm: typed.value, volumes: cVol.checked, crypto: cCrypto.checked, secrets: cSec.checked });
    if (r) render();
  };
  view.append(h("div", { class: "card" }, h("h2", {}, "Danger zone"),
    h("p", { class: "muted" }, "Removes this network's containers. You choose whether its Docker volumes, crypto material and secrets are deleted too."),
    h("div", { class: "row mt" }, taskBtn("Destroy network…", destroy, "danger"))));
}

// ---- channels
function pageChannels(view) {
  const chs = channelsOf();
  if (!chs.length) return view.append(h("div", { class: "note" }, "No channels yet. Define them under Configure, then Save & generate."));
  const made = STATE.status.channel_blocks || [];
  view.append(h("div", { class: "row center", style: "justify-content:flex-end;margin-bottom:10px" }, actionBtn("List joined channels per org", "channel_list", {})));
  view.append(h("div", { class: "note info" }, "Create = genesis block → every orderer joins → every member peer joins (anchor peers are part of the block). Run it once per channel; \"Join peers\" is for newly added peers."));
  chs.forEach((c) => view.append(h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, c.name), made.includes(c.name) ? badge("created", "ok") : badge("not created", "warn"), h("span", { class: "spacer" }),
    actionBtn("Create", "channel_create", { channel: c.name }, made.includes(c.name) ? "" : "primary"), actionBtn("Join peers", "channel_join", { channel: c.name }), actionBtn("Info", "channel_info", { channel: c.name })),
    h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Member", "CP joined", "LP joined"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...c.members.map((mm) => h("tr", {}, h("td", {}, mm.name), h("td", {}, String(mm.committing)), h("td", {}, String(mm.lite))))))),
    h("p", { class: "muted mt" }, `Policy ${c.policy} · block cut ${c.batch.timeout} / ${c.batch.max_message_count} msgs`))));
}

// ---- users
async function pageUsers(view) {
  const m = model();
  if (!m) return view.append(h("div", { class: "note" }, "Generate the network first."));
  const org = sel(orgsOf(), pref("user.org")), name = h("input", { placeholder: "e.g. alice", autocomplete: "off" });
  const role = h("input", { placeholder: "e.g. issuer, superadmin", list: "roles", autocomplete: "off" });
  const type = sel(["client", "admin"]), attrs = h("input", { placeholder: "optional: dept=ops, region=in" });
  const parseAttrs = () => attrs.value.split(",").map((x) => x.trim()).filter(Boolean);
  const submit = async () => {
    if (!required(["User name", name])) return;
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,30}$/.test(name.value)) { name.classList.add("invalid"); return toast("Name: 2–31 letters, digits, - or _, starting with a letter", true); }
    setPref("user.org", org.value);
    const r = await runAction("user_add", { org: org.value, name: name.value.trim(), role: role.value.trim(), type: type.value, attrs: parseAttrs() });
    if (r && r.code === 0) { name.value = ""; await drawUsers(); }
  };
  const roleChips = h("div", { class: "chips" }, ...["superadmin", "issuer", "approver", "verifier", "auditor"].map((r) => h("button", { class: "chip", type: "button", onclick: () => { role.value = r; role.focus(); } }, r)));
  view.append(h("div", { class: "card" }, h("h2", {}, "Add application user"),
    h("p", { class: "muted" }, "A random password is generated and stored in secrets/ (never shown). The certificate carries the role attribute that chaincode checks."),
    h("div", { class: "grid cols2 mt" }, field("Organization", org), field("User name", name), field("Role attribute", role, "pick a suggestion or type your own"), field("Type", type), field("Extra attributes", attrs)),
    h("datalist", { id: "roles" }, ...["superadmin", "issuer", "approver", "verifier", "auditor"].map((r) => h("option", { value: r }))),
    h("div", { class: "mt" }, roleChips), h("div", { class: "row mt" }, taskBtn("Enroll user", submit, "primary"))));
  onEnter([name, role, attrs], submit);

  const list = h("div");
  const drawUsers = async () => {
    list.textContent = "";
    const users = await loadUsers();
    const rows = Object.entries(users).flatMap(([o, us]) => us.map((u) => ({ o, ...u })));
    if (!rows.length) return list.append(empty("No users yet", "Enroll one above, or create the network identities first."));
    list.append(h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["User", "Organization", "Role attribute", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...rows.map((u) => h("tr", {}, h("td", {}, u.name, u.admin ? " " : "", u.admin ? badge("org admin", "info") : null), h("td", {}, u.o),
        h("td", {}, u.role ? badge(u.role, u.role === "superadmin" ? "ok" : "info") : h("span", { class: "muted" }, "-")),
        h("td", {}, u.admin ? null : h("div", { class: "row" },
          actionBtn("Revoke", "user_revoke", { org: u.o, name: u.name }, "danger sm", `Revoke the certificate of ${u.name} (${u.o}) at the CA?`),
          taskBtn("Remove", async () => {
            if (!(await confirmDialog("Remove user", `Delete the local files and stored password of ${u.name} (${u.o})? Revoke the certificate too if it must stop working.`, { label: "Remove", danger: true }))) return;
            const r = await runAction("user_remove", { org: u.o, name: u.name }); if (r?.code === 0) await drawUsers();
          }, "danger sm")))))))));
    setRun(!!current);
  };
  view.append(h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Enrolled users"), h("span", { class: "spacer" }), h("button", { onclick: drawUsers }, "Refresh")),
    h("p", { class: "muted" }, "Revoke tells the CA the certificate is no longer valid. Remove deletes the user's local files and stored password."), list));
  await drawUsers();
}

// ---- chaincode
const PRESETS = {
  superadmin: [
    { fn: "CreateSuperAdmin", kind: "invoke", args: ["adminID", "name", "email"], note: "The first one can be created by any user; later ones need a superadmin role." },
    { fn: "ListSuperAdmins", kind: "query", args: [] },
    { fn: "GetSuperAdmin", kind: "query", args: ["adminID"] },
    { fn: "UpdateSuperAdmin", kind: "invoke", args: ["adminID", "name", "email"] },
    { fn: "SetSuperAdminStatus", kind: "invoke", args: ["adminID", { n: "status", opts: ["ACTIVE", "DISABLED"] }] },
    { fn: "DeleteSuperAdmin", kind: "invoke", args: ["adminID"] },
    { fn: "GetSuperAdminHistory", kind: "query", args: ["adminID"] },
  ],
  domain: [
    { fn: "CreateDomain", kind: "invoke", args: ["key", "name", "description"] }, { fn: "UpdateDomain", kind: "invoke", args: ["key", "name", "description"] },
    { fn: "DeactivateDomain", kind: "invoke", args: ["key"] }, { fn: "GetDomain", kind: "query", args: ["key"] }, { fn: "ListDomains", kind: "query", args: [] },
    { fn: "InviteRegulatoryBody", kind: "invoke", args: ["userID", "name", "email", "domainKeysJSON"] }, { fn: "ActivateRegulatoryBody", kind: "invoke", args: ["userID"] },
    { fn: "MapRegulatoryBodyToDomain", kind: "invoke", args: ["userID", "domainKey"] }, { fn: "UnmapRegulatoryBodyFromDomain", kind: "invoke", args: ["userID", "domainKey"] },
    { fn: "GetRegulatoryBody", kind: "query", args: ["userID"] }, { fn: "ListRegulatoryBodies", kind: "query", args: [] },
    { fn: "SetDomainPricing", kind: "invoke", args: ["domainKey", "payloadJSON"] }, { fn: "GetDomainPricing", kind: "query", args: ["domainKey"] },
    { fn: "SetFeeConfig", kind: "invoke", args: ["domainKey", "payloadJSON"] }, { fn: "GetFeeConfig", kind: "query", args: ["domainKey"] },
  ],
};

async function pageChaincode(view) {
  const chs = channelsOf();
  if (!chs.length) return view.append(h("div", { class: "note" }, "Define and create a channel first."));
  const [ccs, users] = await Promise.all([loadChaincodes(), loadUsers()]);

  const ch = sel(chs.map((c) => c.name), pref("cc.channel"), (e) => setPref("cc.channel", e.target.value));
  const slug = (x) => x.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const defCC = ccs.find((c) => c.name === "superadmin") || ccs[0];
  const name = h("input", { placeholder: "superadmin", value: pref("cc.name", defCC ? slug(defCC.name) : ""), list: "cclist", oninput: (e) => { setPref("cc.name", e.target.value); const m = ccs.find((c) => slug(c.name) === e.target.value.trim()); if (m && !path.value) path.value = m.path; } });
  const path = h("input", { placeholder: "chaincode/superadmin (inside the repository)", value: pref("cc.path") || (ccs.find((c) => slug(c.name) === pref("cc.name", defCC ? slug(defCC.name) : "")) || {}).path || "" });
  const pick = sel([["", "— choose —"], ...ccs.map((c) => [c.path, c.name])], pref("cc.path"), (e) => {
    if (!e.target.value) return; path.value = e.target.value; setPref("cc.path", path.value);
    name.value = e.target.value.split("/").pop().replace(/[^a-z0-9_-]/gi, "").toLowerCase(); setPref("cc.name", name.value);
  });
  const ver = h("input", { value: "1.0" }), pol = h("input", { placeholder: "optional signature policy" }), seq = h("input", { value: "auto" });
  const common = () => ({ channel: ch.value, name: name.value.trim(), version: ver.value, policy: pol.value, sequence: seq.value });
  const needCC = () => required(["Chaincode name", name]);

  view.append(h("datalist", { id: "cclist" }, ...ccs.map((c) => h("option", { value: c.name.toLowerCase() }))));
  view.append(h("div", { class: "card" }, h("h2", {}, "Deploy chaincode"),
    h("div", { class: "grid cols2 mt" }, field("Channel", ch), field("Chaincode in repository", pick), field("Chaincode name", name, "installed under this name"), field("Path", path)),
    h("details", { class: "mt" }, h("summary", { class: "muted" }, "Advanced"), h("div", { class: "grid cols3 mt" }, field("Version", ver), field("Sequence", seq), field("Signature policy", pol))),
    h("div", { class: "row mt" }, taskBtn("Deploy (all steps)", () => { if (needCC() && required(["Path", path])) { setPref("cc.path", path.value); runAction("cc_deploy", { ...common(), path: path.value }); } }, "primary")),
    h("p", { class: "muted", style: "margin:12px 0 6px" }, "…or one step at a time:"),
    h("div", { class: "row" }, taskBtn("1 · Package", () => needCC() && required(["Path", path]) && runAction("cc_package", { name: name.value.trim(), path: path.value, version: ver.value })),
      taskBtn("2 · Install", () => needCC() && runAction("cc_install", { channel: ch.value, name: name.value.trim(), version: ver.value })),
      taskBtn("3 · Approve", () => needCC() && runAction("cc_approve", common())), taskBtn("4 · Commit", () => needCC() && runAction("cc_commit", common())),
      actionBtn("Committed list", "cc_list", () => ({ channel: ch.value })))));

  // ---- query / invoke with per-function argument fields
  const userSel = sel([["|", "org admin (no role)"], ...userOptions(users)], pref("cc.user"), (e) => setPref("cc.user", e.target.value));
  const fnSel = h("select");
  const argsBox = h("div", { class: "grid cols2 mt" }), noteBox = h("div"), result = h("div", { class: "mt" });
  let argInputs = [], spec = null;
  const customFn = h("input", { placeholder: "FunctionName" }), customArgs = h("input", { value: "[]", placeholder: '["id1","Name","a@b.io"]' });
  const drawFns = () => {
    const key = name.value.trim().toLowerCase();
    const list = (PRESETS[key] || []);
    fnSel.textContent = "";
    list.forEach((p) => fnSel.append(h("option", { value: p.fn }, `${p.fn}  (${p.kind})`)));
    fnSel.append(h("option", { value: "" }, "Custom function…"));
    drawArgs();
  };
  const drawArgs = () => {
    const list = (PRESETS[name.value.trim().toLowerCase()] || []);
    spec = list.find((p) => p.fn === fnSel.value) || null;
    argsBox.textContent = ""; noteBox.textContent = ""; argInputs = [];
    if (spec) {
      spec.args.forEach((a) => { const o = typeof a === "string" ? { n: a } : a;
        const i = o.opts ? sel(o.opts) : h("input", { placeholder: o.n, autocomplete: "off" }); argInputs.push(i); argsBox.append(field(o.n, i)); });
      if (spec.note) noteBox.append(h("p", { class: "muted" }, spec.note));
    } else argsBox.append(field("Function", customFn), field("Arguments (JSON array)", customArgs));
  };
  fnSel.addEventListener("change", drawArgs); name.addEventListener("input", drawFns);
  const run = async (kind) => {
    if (!needCC()) return;
    let fn, args;
    if (spec) { fn = spec.fn; args = argInputs.map((i) => i.value); if (spec.args.some((a, k) => typeof a === "string" && !args[k].trim())) return required(...argInputs.map((i, k) => [typeof spec.args[k] === "string" ? spec.args[k] : spec.args[k].n, i])); }
    else { if (!required(["Function", customFn])) return; fn = customFn.value.trim(); try { args = JSON.parse(customArgs.value || "[]"); if (!Array.isArray(args)) throw 0; } catch (_) { customArgs.classList.add("invalid"); return toast("Arguments must be a JSON array, e.g. [\"a\",\"b\"]", true); } }
    const { org, user } = splitUser(userSel.value);
    renderResult(result, kind, null);
    const res = await call(kind, { channel: ch.value, name: name.value.trim(), fn, args, user, org }, { quiet: true });
    renderResult(result, kind, res);
  };
  const btns = h("div", { class: "row mt" });
  const drawBtns = () => { btns.textContent = ""; const k = spec?.kind; if (!k || k === "query") btns.append(taskBtn("Query", () => run("query"), k === "query" ? "primary" : "")); if (!k || k === "invoke") btns.append(taskBtn("Invoke", () => run("invoke"), "primary")); };
  fnSel.addEventListener("change", drawBtns); name.addEventListener("input", drawBtns);
  view.append(h("div", { class: "card" }, h("h2", {}, "Query / invoke"),
    h("p", { class: "muted" }, "Query reads the ledger; invoke writes a transaction (endorsed by every channel organization). Results appear below - the console shows the raw output."),
    h("div", { class: "grid cols2 mt" }, field("Function", fnSel), field("Act as user", userSel, "role comes from this user's certificate")),
    argsBox, noteBox, btns, result));
  drawFns(); drawBtns();
}

// ---- super admins
async function pageSuperAdmin(view) {
  const chs = channelsOf();
  if (!chs.length) return view.append(h("div", { class: "note" }, "Define and create a channel first."));
  const users = await loadUsers();
  const saOpts = userOptions(users, { onlyRole: "superadmin" });
  const ch = sel(chs.map((c) => c.name), pref("cc.channel"), (e) => setPref("cc.channel", e.target.value));
  const cc = h("input", { value: pref("sa.cc", "superadmin"), oninput: (e) => setPref("sa.cc", e.target.value) });
  const actAs = sel(saOpts.length ? saOpts : [["|", "no superadmin user yet"]], pref("sa.user"), (e) => setPref("sa.user", e.target.value));
  const ctx = () => { const { org, user } = splitUser(actAs.value); return { channel: ch.value, name: cc.value.trim() || "superadmin", user, org }; };

  // step 1: role user
  const orgPick = sel(orgsOf(), pref("user.org")), uname = h("input", { value: "sa1", autocomplete: "off" });
  const enrollBtn = taskBtn(saOpts.length ? "Enroll another" : "Enroll superadmin user", async () => {
    if (!required(["User name", uname])) return;
    const r = await runAction("user_add", { org: orgPick.value, name: uname.value.trim(), role: "superadmin", type: "client", attrs: [] });
    if (r?.code === 0) { setPref("sa.user", `${orgPick.value}|${uname.value.trim()}`); render(); }
  }, saOpts.length ? "" : "primary");
  view.append(h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "1 · A user with the superadmin role"), saOpts.length ? badge("ready", "ok") : badge("missing", "warn")),
    h("p", { class: "muted" }, "Chaincode checks the role attribute in the caller's certificate. A random password is created and stored in secrets/ (never shown)."),
    h("div", { class: "row mt" }, field("Organization", orgPick), field("User name", uname), enrollBtn)));

  // step 2: records
  const listBox = h("div"), result = h("div"), msg = h("div");
  const loadList = async (quiet = true) => {
    if (!saOpts.length) { listBox.textContent = ""; return listBox.append(empty("Enroll a superadmin user first", "Records can only be listed with a superadmin role.")); }
    listBox.textContent = ""; listBox.append(h("p", { class: "muted" }, "Loading…"));
    const res = await call("query", { ...ctx(), fn: "ListSuperAdmins", args: [] }, { quiet });
    listBox.textContent = "";
    if (!res) return listBox.append(h("div", { class: "err" }, "Could not start the query (another task may be running)."));
    const p = parseOutput(res);
    if (res.code !== 0) { renderResult(listBox, "query", res); return; }
    const rows = Array.isArray(p.json) ? p.json : [];
    if (!rows.length) return listBox.append(empty("No Super Admins yet", "Create the first one below."));
    listBox.append(h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["ID", "Name", "Email", "Status", "Created", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...rows.map((r) => h("tr", {}, h("td", {}, r.adminId), h("td", {}, r.name), h("td", {}, r.email), h("td", {}, badge(r.status, r.status === "ACTIVE" ? "ok" : "warn")),
        h("td", { class: "muted" }, (r.createdAt || "").slice(0, 10)),
        h("td", {}, h("div", { class: "row" },
          taskBtn(r.status === "ACTIVE" ? "Disable" : "Enable", () => change("SetSuperAdminStatus", [r.adminId, r.status === "ACTIVE" ? "DISABLED" : "ACTIVE"], `${r.adminId} updated`), "sm"),
          taskBtn("Delete", async () => { if (await confirmDialog("Delete Super Admin", `Delete ${r.adminId} (${r.email})? The last Super Admin cannot be deleted.`, { label: "Delete", danger: true })) change("DeleteSuperAdmin", [r.adminId], `${r.adminId} deleted`); }, "danger sm")))))))));
    setRun(!!current);
  };
  async function change(fn, args, okMsg) {
    msg.textContent = "";
    const res = await call("invoke", { ...ctx(), fn, args }, { quiet: true });
    const p = res && parseOutput(res);
    if (p && p.tx && p.tx[2] === "VALID") { toast(okMsg, "ok"); await loadList(); }
    else renderResult(msg, "invoke", res);
    return res;
  }
  view.append(h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "2 · Super Admin records on the ledger"), h("span", { class: "spacer" }), taskBtn("Refresh", () => loadList())),
    h("div", { class: "grid cols3 mt" }, field("Channel", ch), field("Chaincode", cc), field("Act as", actAs)), h("div", { class: "mt" }, listBox), msg));

  // create form
  const id = h("input", { placeholder: "superadmin1", autocomplete: "off" }), nm = h("input", { placeholder: "Full name" }), em = h("input", { type: "email", placeholder: "name@example.com" });
  const create = async () => {
    if (!required(["Admin ID", id], ["Name", nm], ["Email", em])) return;
    if (!/^\S+@\S+\.\S+$/.test(em.value)) { em.classList.add("invalid"); return toast("Enter a valid email", true); }
    result.textContent = "";
    const res = await call("invoke", { ...ctx(), fn: "CreateSuperAdmin", args: [id.value.trim(), nm.value.trim(), em.value.trim()] }, { quiet: true });
    const p = res && parseOutput(res);
    if (p && p.tx && p.tx[2] === "VALID") { toast("Super Admin created", "ok"); id.value = nm.value = em.value = ""; await loadList(); } else renderResult(result, "invoke", res);
  };
  view.append(h("div", { class: "card" }, h("h2", {}, "Add a Super Admin"),
    h("p", { class: "muted" }, "ID and email must be unique. The first record can be created without the role; after that only a superadmin user can add more."),
    h("div", { class: "grid cols3 mt" }, field("Admin ID", id), field("Name", nm), field("Email", em)),
    h("div", { class: "row mt" }, taskBtn("Create Super Admin", create, "primary")), h("div", { class: "mt" }, result)));
  onEnter([id, nm, em], create);

  setRun(!!current);
  if (!STATE.status?.running && !current && saOpts.length) await loadList();
  else if (!saOpts.length) await loadList();
}

// ---- monitoring (Prometheus + Grafana)
async function pageMonitoring(view) {
  const m = model();
  if (!m) return view.append(h("div", { class: "note" }, "Generate the network first (Configure → Save & generate)."));
  const st = await api("/api/monitoring");
  if (!st.enabled) return view.append(h("div", { class: "note" }, "Monitoring is switched off for this network. Turn on “Prometheus + Grafana” under Configure, then Save & generate and start the monitoring containers.",
    " ", h("button", { class: "sm", onclick: () => go("configure") }, "Open Configure")));
  const link = (port, text) => h("a", { class: "btn", href: `http://${location.hostname}:${port}`, target: "_blank", rel: "noopener noreferrer" }, text);
  const state = (up) => up ? badge("running", "ok") : badge("stopped", "bad");

  view.append(h("div", { class: "two" },
    h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Prometheus"), state(st.prometheus), h("span", { class: "spacer" }), st.prometheus ? link(st.prometheus_port, "Open") : null),
      h("p", { class: "muted" }, `Collects metrics from every peer, orderer and CA every 15 seconds and keeps 30 days. Port ${st.prometheus_port}. “Status → Targets” there shows the same table as below.`)),
    h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Grafana"), state(st.grafana), h("span", { class: "spacer" }), st.grafana ? link(st.grafana_port, "Open") : null),
      h("p", { class: "muted" }, `Graphs on port ${st.grafana_port}. Sign in as `, h("b", {}, "admin"), "; the password is in ", h("code", {}, "secrets/grafana-admin.pw"), " on the host (the console never shows secrets). Open Dashboards → Drunix → “Drunix network overview”."))));
  view.append(h("div", { class: "row", style: "margin-bottom:16px" },
    actionBtn("Start monitoring", "nodes_up", { targets: ["monitoring"] }, st.prometheus && st.grafana ? "" : "primary"),
    actionBtn("Stop monitoring", "nodes_down", { targets: ["monitoring"] }, "", "Stop Prometheus and Grafana? Collected metrics and dashboards are kept."),
    h("button", { onclick: () => render() }, "Refresh"), h("span", { class: "muted" }, "updates every 10s")));

  // scrape targets
  const t = st.targets || [];
  const up = t.filter((x) => x.health === "up").length, down = t.length - up;
  const rows = t.map((x) => h("tr", {}, h("td", {}, x.job), h("td", {}, x.instance), h("td", {}, x.org || h("span", { class: "muted" }, "-")),
    h("td", {}, badge(x.health, x.health === "up" ? "ok" : "bad")), h("td", { class: "muted" }, x.age == null ? "-" : `${x.age}s ago`), h("td", { class: "muted" }, x.error || "")));
  view.append(h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Scrape targets"), t.length ? badge(`${up} up`, "ok") : null, down ? badge(`${down} down`, "bad") : null),
    st.error ? h("div", { class: "err" }, st.error) : null,
    !st.prometheus ? empty("Prometheus is not running", "Press Start monitoring, or start the nodes.")
      : !t.length ? empty("No targets yet", "Prometheus has no scrape targets - regenerate the files and restart monitoring.")
      : h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Job", "Instance", "Org", "Health", "Last scrape", "Error"].map((x) => h("th", {}, x)))), h("tbody", {}, ...rows))),
    down && st.prometheus ? h("p", { class: "muted mt" }, "“down” usually means that component is not running - check the Dashboard container list, then start it from the Network page.") : null));

  // block height
  const bh = st.block_height || [];
  view.append(h("div", { class: "card" }, h("h2", {}, "Block height"),
    h("p", { class: "muted" }, "Committed blocks per node and channel (peers and orderers). Nodes of one channel should show the same number."),
    bh.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Node", "Channel", "Height"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...bh.map((x) => h("tr", {}, h("td", {}, x.instance), h("td", {}, x.channel), h("td", {}, x.height))))))
      : empty("No data yet", st.prometheus ? "No node is reporting a block height (nodes stopped, or no channel created yet)." : "Start monitoring and the peers.")));
  pageTimer = setInterval(() => { if (page === "monitoring" && !current) render(); }, 10000);
}

// ---- activity
async function pageActivity(view) {
  const { jobs } = await api("/api/jobs");
  if (!jobs.length) return view.append(empty("No tasks yet", "Anything you run from this console is listed here."));
  const t = h("table", {}, h("thead", {}, h("tr", {}, ...["Command", "Result", ""].map((x) => h("th", {}, x)))),
    h("tbody", {}, ...jobs.map((j) => h("tr", {}, h("td", {}, h("code", {}, "$ " + j.cmd)), h("td", {}, badge(!j.done ? "running" : j.code === 0 ? "ok" : "failed", !j.done ? "warn" : j.code === 0 ? "ok" : "bad")),
      h("td", {}, h("button", { class: "sm", onclick: async () => {
        con.open(j.cmd); const out = con.out(); out.textContent = "";
        const r = await api(`/api/jobs/${j.id}?offset=0`); out.textContent = r.lines.join("\n"); out.scrollTop = out.scrollHeight;
      } }, "Show output"))))));
  view.append(h("div", { class: "card" }, h("div", { class: "table-wrap" }, t)));
  pageTimer = setInterval(async () => { if (page === "activity" && jobs.some((j) => !j.done)) render(); }, 3000);
}

// ---------------------------------------------------------------- login + boot
function showLogin(msg) {
  ME = null; CSRF = ""; current = null; clearInterval(pageTimer);
  document.body.classList.add("locked");
  const user = h("input", { autocomplete: "username", autofocus: true, placeholder: "username" });
  const pass = h("input", { type: "password", autocomplete: "current-password", placeholder: "password" });
  const err = h("div", { class: "err", style: msg ? "" : "display:none" }, msg || "");
  const btn = h("button", { class: "primary", type: "submit" }, "Sign in");
  const form = h("form", { class: "login-card", onsubmit: async (e) => {
    e.preventDefault(); err.style.display = "none"; btn.disabled = true;
    try {
      const r = await api("/api/login", { method: "POST", body: { username: user.value.trim(), password: pass.value } });
      pass.value = ""; CSRF = r.csrf; ME = r; document.body.classList.remove("locked"); await start();
    } catch (ex) { err.textContent = ex.message; err.style.display = "block"; pass.value = ""; pass.focus(); }
    btn.disabled = false;
  } }, h("div", { class: "brand" }, h("span", { class: "logo" }, "D"), h("div", {}, h("b", {}, "Drunix"), h("small", {}, "Network Console"))),
    h("h2", { style: "margin-top:16px" }, "Sign in"),
    h("p", { class: "muted" }, "Sign in with a console account to manage the network."),
    err, field("Username", user), field("Password", pass), btn,
    h("p", { class: "muted", style: "margin-top:12px" }, "No account? On the host run: python3 ui/server.py user add --name <you>"));
  const v = $("#view"); v.textContent = ""; v.append(h("div", { class: "login-wrap" }, form));
  $("#title").textContent = ""; $("#subtitle").textContent = ""; $("#menu").textContent = "";
}

async function start() {
  STATE.status = await api("/api/status");
  $("#whoami").textContent = ME.user;
  page = pageFromHash(); history.replaceState(null, "", "#/" + page);
  render();
}

$("#logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: {} }); } catch (_) { /* already gone */ }
  showLogin();
});

(async function boot() {
  try { ME = await api("/api/me"); CSRF = ME.csrf; } catch (_) { return showLogin(); }
  try { await start(); } catch (e) { $("#view").append(h("div", { class: "err" }, e.message)); }
})();
