import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { openDb } from "../src/db.ts";
import { indexRef } from "../src/indexer.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer as createHttpServer } from "node:http";
import { localDefaults, localSigningKey, Workspaces } from "../src/workspace.ts";

const key = "fixture-session-key";
function token(email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + 300000 })).toString("base64url");
  return "s1." + body + "." + createHmac("sha256", key).update(body).digest("base64url");
}
async function listen(t, dir, repo, stateful = false) {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, REPOS: "crm=" + repo + ",lib=" + repo, DATA_DIR: dir, PORT: String(port), X_ZOHO_CATALYST_LISTEN_PORT: String(port),
      MCP_TOKEN: "fixture-admin", SESSION_SECRET: key, MCP_STATEFUL: stateful ? "1" : "0", INDEX_BUILD_POOL: "0", PRELOAD_REFS: "", SWITCH_WAIT_MS: "100" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  server.stderr.on("data", chunk => { logs += chunk; });
  const close = async () => {
    if (server.exitCode !== null || server.signalCode) return;
    const closed = once(server, "exit");
    server.kill();
    await closed;
  };
  t.after(close);
  const base = "http://127.0.0.1:" + port;
  for (let n = 0; n < 120; n++) {
    const ready = await fetch(base + "/health").then(r => r.ok, () => false);
    if (ready) return { base, close };
    if (server.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error("server did not start: " + logs);
}
function makeRepo(dir) {
  const repo = join(dir, "repository");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  const refs = {};
  for (const [branch, method] of [["master", "masterAction"], ["feature-a", "featureAlpha"], ["feature-b", "featureBeta"]]) {
    if (branch !== "master") git("checkout", "-q", "-b", branch, "master");
    writeFileSync(join(repo, "Actions.java"), `class Actions {\n  void ${method}() {}\n}\n`);
    git("add", "Actions.java");
    git("-c", "user.name=Workspace Test", "-c", "user.email=test@example.invalid", "commit", "-qm", branch);
    refs[branch] = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/" + branch, refs[branch]);
  }
  return { repo, refs, git };
}

test("workspace reads survive restart, reject foreign IDs and use the indexed diff revisions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "crm-workspace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { repo, refs, git } = makeRepo(dir);
  for (const name of ["crm", "lib"]) {
    const db = openDb(join(dir, name + ".sqlite"));
    const names = Object.keys(refs);
    for (const branch of name === "crm" ? names : names.reverse()) await indexRef(db, repo, refs[branch], undefined, branch);
    db.close();
  }
  const alice = token("alice@example.invalid"), bob = token("bob@example.invalid");
  let service = await listen(t, dir, repo);
  const api = async (route, body, bearer = alice, get = false) => {
    const url = new URL("/api/" + route, service.base);
    if (get) for (const [k,v] of Object.entries(body)) url.searchParams.set(k,v);
    const r = await fetch(url, { method: get ? "GET" : "POST", headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
      body: get ? undefined : JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  };
  const mcp = async (name, args, bearer) => {
    const r = await fetch(service.base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + bearer, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const first = await api("switch", { repo: "crm", branch: "feature-a" });
  assert.equal(first.revision, refs["feature-a"]);
  const b = await mcp("switch_branch", { branch: "feature-b" }, bob);
  assert.equal(b.structuredContent.revision, refs["feature-b"]);
  assert.equal((await api("search", { query: "featureBeta" }, bob)).branch, "feature-b");
  const search = await mcp("get_code_context", { query: "featureAlpha" }, alice);
  assert.equal(search.structuredContent.revision, refs["feature-a"]);
  const id = search.structuredContent.cards[0].id;
  assert.match((await api("symbol", { id }, alice, true)).text, /featureAlpha/);
  assert.equal((await api("symbol", { id }, bob)).status, 404);
  assert.equal((await api("symbol", { id, workspace: first.workspace }, bob)).status, 403);
  assert.equal((await api("symbol", { id, workspace: first.workspace + "x" }, alice)).status, 403);
  assert.equal((await api("search", { query: "x" }, "fixture-admin")).status, 400);
  const admin = await api("switch", { branch: "master" }, "fixture-admin");
  assert.equal((await api("status", { workspace: admin.workspace }, "fixture-admin", true)).active.revision, refs.master);
  assert.equal((await api("search", { repo: "lib", branch: "feature-a", query: "featureAlpha" })).cards[0].id, id);
  assert.match((await api("symbol", { repo: "lib", branch: "feature-a", id })).text, /featureAlpha/);

  // Older snapshots published an index timestamp before storing exact source revisions.
  const legacyDb = openDb(join(dir, "lib.sqlite"));
  legacyDb.prepare("DELETE FROM meta WHERE k=?").run("revision:feature-a");
  const legacyRow = legacyDb.prepare("SELECT v FROM meta WHERE k=?").get("indexed:feature-a");
  legacyDb.close();
  const old = await api("search", { repo: "lib", branch: "feature-a", query: "featureAlpha" });
  assert.equal(old.status, 200);
  assert.equal(old.revision, null);
  assert.equal(old.version, legacyRow.v);
  assert.equal(old.cards[0].id, id);

  git("update-ref", "refs/remotes/origin/feature-a", refs["feature-b"]);
  const diff = await api("diff", { workspace: first.workspace });
  assert.equal(diff.baseRevision, refs.master);
  assert.equal(diff.headRevision, refs["feature-a"]);
  assert(diff.symbols.some(s => s.symbol.endsWith("featureAlpha")));
  assert(!diff.symbols.some(s => s.symbol.endsWith("featureBeta")));

  await api("switch", { repo: "lib", branch: "feature-b" });
  await service.close();
  service = await listen(t, dir, repo);
  assert.equal((await api("status", {}, alice, true)).active.repo, "lib");
  assert.equal((await api("status", { repo: "crm" }, alice, true)).active.branch, "feature-a");
  assert.equal((await api("symbol", { id, workspace: first.workspace })).revision, refs["feature-a"]);
  assert.equal((await api("status", {}, bob, true)).active.branch, "feature-b");

  await service.close();
  service = await listen(t, dir, repo, true);
  const connect = async bearer => {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", service.base), {
      requestInit: { headers: { authorization: "Bearer " + bearer } },
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    t.after(() => client.close());
    return { client, transport };
  };
  const left = await connect("fixture-admin"), right = await connect("fixture-admin");
  await left.client.callTool({ name: "switch_branch", arguments: { branch: "feature-a" } });
  await right.client.callTool({ name: "switch_branch", arguments: { branch: "feature-b" } });
  for (const [c, branch] of [[left, "feature-a"], [right, "feature-b"]]) {
    const result = await c.client.callTool({ name: "index_status", arguments: {} });
    assert.equal(result.structuredContent.active.branch, branch);
  }
  const foreign = await fetch(service.base + "/mcp", { method: "POST", headers: {
    authorization: "Bearer " + alice, "mcp-session-id": left.transport.sessionId, "content-type": "application/json",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }) });
  assert.equal(foreign.status, 403);

});

test("shared stateful sessions have private choices; local signer and defaults survive reopening", async t => {
  const dir = mkdtempSync(join(tmpdir(), "crm-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "contexts.sqlite");
  let db = openDb(path);
  let ws = new Workspaces(localDefaults(db), localSigningKey(db), "crm");
  const left = { user: "admin", session: { branches: new Map() } };
  const right = { user: "admin", session: { branches: new Map() } };
  const handle = await ws.activate(left, { repo: "crm", branch: "feature-a" });
  await ws.activate(right, { repo: "crm", branch: "feature-b" });
  assert.equal((await ws.select(left, {})).branch, "feature-a");
  assert.equal((await ws.select(right, {})).branch, "feature-b");
  db.close();
  db = openDb(path);
  ws = new Workspaces(localDefaults(db), localSigningKey(db), "crm");
  assert.equal((await ws.select({ user: "admin" }, { workspace: handle })).branch, "feature-a");
  await assert.rejects(ws.select({ user: "" }, { workspace: handle }));
  db.close();
});

test("bundled shim keeps later switch when earlier response arrives last", async t => {
  let release, started;
  const initial = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const server = createHttpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const args = JSON.parse(raw);
    if (req.url === "/api/switch" && args.branch === "first") { started(); await blocked; }
    const body = req.url === "/api/switch"
      ? { ok: true, repo: "crm", branch: args.branch, workspace: args.branch + "-handle", status: "indexing" }
      : { ok: true, repo: "crm", branch: args.workspace, revision: "c".repeat(40), mode: "and", cards: [], text: "" };
    res.writeHead(req.url === "/api/switch" ? 202 : 200, { "content-type": "application/json" }).end(JSON.stringify(body));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const tmp = mkdtempSync(join(tmpdir(), "crm-shim-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../../tools/crm-index/index.mjs", import.meta.url))],
    env: { ...process.env, HOME: tmp, CRM_INDEX_TOKEN: "fixture", CRM_INDEX_NO_BROWSER: "1", CRM_INDEX_REPO: "crm",
      CRM_INDEX_URL: "http://127.0.0.1:" + server.address().port },
  });
  const client = new Client({ name: "workspace-shim-test", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  const old = client.callTool({ name: "switch_branch", arguments: {branch: "first"} });
  await initial;
  await client.callTool({ name: "switch_branch", arguments: {branch: "second"} });
  release();
  await old;
  const selected = await client.callTool({ name: "get_code_context", arguments: { query: "marker" } });
  assert.match(selected.content[0].text, /branch=second-handle/);
});
