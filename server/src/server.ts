import { createServer, type IncomingMessage } from "node:http";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { recoverStagedArtifacts } from "./indexer.js";
import { openDb, type Db } from "./db.js";
import { BASE, reconcileBranch, ensureIndexed, revision, evictionLog, flushIdle, isIndexing, jobStatus, listBranches, waitFor, BUDGET_BYTES, IDLE_TTL_MS } from "./branches.js";
import { persistTouches, touchRef } from "./evict.js";
import { formatCards, searchSymbols } from "./search.js";
import { getSymbol } from "./symbol.js";
import { diffSymbols } from "./diff.js";
import { formatDiffSymbols } from "./summary.js";
import { covConfigFromEnv } from "./coverage.js";
import { handleAuth, keysEnabled, loginEnabled, loginTarget, verifyKey, verifySession } from "./auth.js";
import { handleOAuth, resourceMetadataUrl } from "./oauth.js";
import { capacity } from "./branches.js";
import { snapshotInWorker } from "./indexPool.js";
import { snapshotEnabled } from "./snapshot.js";
import { Workspaces, RequestError, localDefaults, localSigningKey, validateBranch, type Caller, type WorkspaceArgs } from "./workspace.js";
import { brokerCall, poolEnabled, ensureGitRevision } from "./buildBroker.js";

const DATA = process.env.DATA_DIR ?? "data";
const PORT = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT ?? process.env.PORT ?? 8787);
const TOKEN = process.env.MCP_TOKEN ?? "";
const WAIT_MS = Number(process.env.SWITCH_WAIT_MS ?? 25_000);
mkdirSync(DATA, { recursive: true });

interface Repo { name: string; dir: string; db: Db; file: string }
const repos = new Map<string, Repo>();
{
  // REPOS="zohocrm=/path/mirror,core_library=/path/mirror2"  (or legacy REPO_DIR + REPO_NAME)
  const spec = process.env.REPOS ?? (process.env.REPO_DIR ? `${process.env.REPO_NAME ?? "zohocrm"}=${process.env.REPO_DIR}` : "");
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    const name = part.slice(0, i), dir = part.slice(i + 1);
    if (!/^[\w.-]+$/.test(name) || !dir) { console.error(`bad REPOS entry: ${part}`); process.exit(1); }
    const file = `${DATA}/${name}.sqlite`;
    const db = openDb(file);
    recoverStagedArtifacts(db);
    repos.set(name, { name, dir, db, file });
  }
  if (!repos.size) { console.error("REPOS (name=path[,name=path]) or REPO_DIR is required"); process.exit(1); }
}
const defaultRepo = [...repos.keys()][0];
// revoked per-person key ids live in the index DB, so a revocation survives restarts
const isKeyRevoked = (kid: string): boolean => !!repos.get(defaultRepo)!.db.prepare("SELECT 1 FROM meta WHERE k=?").get(`revoked:${kid}`);
/** Who is calling: "admin", a signed-in email, a key owner's email, or null (not allowed). */
const identify = (bearer: string): { user: string } | { error: string } | null => {
  if (TOKEN && bearer === TOKEN) return { user: "admin" };
  const k = bearer ? verifyKey(bearer, isKeyRevoked) : null;
  if (k?.claims) return { user: k.claims.email.toLowerCase() };
  if (k?.reason) return { error: k.reason };
  const v = bearer ? verifySession(bearer) : null;
  if (v?.session) return { user: v.session.email.toLowerCase() };
  if (v?.expired) return { error: "session_expired" };
  return null;
};
const authRequired = () => !!TOKEN || keysEnabled() || loginEnabled();
const cov = covConfigFromEnv();

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const contextDb = repos.get(defaultRepo)!.db;
const sharedKey = process.env.WORKSPACE_SECRET || process.env.SESSION_SECRET || process.env.KEY_SECRET || process.env.SNAPSHOT_KEY || TOKEN;
if (poolEnabled() && !sharedKey) throw new Error("distributed workspace handles need a shared signing secret");
const workspaces = new Workspaces(poolEnabled() ? {
  async get(user, repo) {
    const saved = await brokerCall<{ repo: string | null; branch: string | null }>("getContext", { user, repo });
    return saved.repo && saved.branch ? { repo: saved.repo, branch: saved.branch } : null;
  },
  async put(user, { repo, branch }) { await brokerCall("putContext", { user, repo, branch }); },
} : localDefaults(contextDb), sharedKey || localSigningKey(contextDb), defaultRepo);

type Input = WorkspaceArgs & { query?: string; path?: string; limit?: number; id?: string; max_lines?: number; head?: string; base?: string; contains?: string };
const reply = <T extends object>(status: number, data: T, message: string) => ({
  status, data: { ok: status < 400, ...data }, message,
});
function legacyVersion(r: Repo, branch: string): string | null {
  if (poolEnabled() || isIndexing(r.dir, branch)) return null;
  return (r.db.prepare("SELECT v FROM meta WHERE k=?").get("indexed:" + branch) as { v: string } | undefined)?.v ?? null;
}
const available = (r: Repo, branch: string) => revision(r.db, branch) ?? legacyVersion(r, branch);
const location = (r: Repo, branch: string, sha: string | null, version?: string | null) =>
  `repo=${r.name} branch=${branch} revision=${sha ?? (version ? "unknown" : "pending")}${version && !sha ? ` index_version=${version}` : ""}`;
function repoByName(name: string) {
  const r = repos.get(name);
  if (!r) throw new RequestError(404, `unknown repo "${name}". Available: ${[...repos.keys()].join(", ")}`);
  return r;
}
function waiting(r: Repo, branch: string, job: ReturnType<typeof ensureIndexed>, workspace?: string) {
  const state = job.state;
  const data = { repo: r.name, branch, revision: revision(r.db, branch), workspace, state, status: "indexing", progress: job.progress ?? null };
  if (state === "error") throw new RequestError(503, `Could not index "${branch}": ${job.error}`);
  return reply(202, data, `${location(r, branch, data.revision)} index=${state}; check index_status and retry.${workspace ? `\nworkspace=${workspace}` : ""}`);
}
async function select(caller: Caller, args: WorkspaceArgs): Promise<{ r: Repo; branch: string }> {
  const ctx = await workspaces.select(caller, args);
  return { r: repoByName(ctx.repo), branch: ctx.branch! };
}

async function switchBranch(caller: Caller, args: Input, refresh: boolean) {
  if (!refresh) validateBranch(args.branch);
  const { r, branch } = await select(caller, args);
  const workspace = refresh ? args.workspace : await workspaces.activate(caller, { repo: r.name, branch });
  const restoring = refresh ? undefined : await reconcileBranch(r.db,r.dir,branch);
  if (restoring) return waiting(r,branch,restoring,workspace);
  let sha = revision(r.db, branch);
  const version = sha ?? legacyVersion(r, branch);
  if (refresh || !version || isIndexing(r.dir, branch)) {
    const job = ensureIndexed(r.db, r.dir, branch, { refresh });
    if (poolEnabled() || !await waitFor(job, WAIT_MS)) return waiting(r, branch, job, workspace);
    if (job.state === "error") throw new RequestError(503, `Could not index "${branch}": ${job.error}`);
    sha = revision(r.db, branch);
    if (!sha) throw new RequestError(409, "indexed revision unavailable; retry switch_branch");
    return reply(200, { repo: r.name, status: "indexed", branch, revision: sha, workspace, report: job.report },
      `${location(r, branch, sha)} indexed${workspace ? `\nworkspace=${workspace}` : ""}`);
  }
  touchRef(r.db, branch);
  return reply(200, { repo: r.name, status: "indexed", branch, revision: sha, version, workspace },
    `${location(r, branch, sha, version)} indexed${workspace ? `\nworkspace=${workspace}` : ""}`);
}

async function readBranch(caller: Caller, args: Input, symbol: boolean) {
  const { r, branch } = await select(caller, args);
  const restoring = await reconcileBranch(r.db, r.dir, branch);
  if (restoring) return waiting(r, branch, restoring);
  // Read manifest, symbols and revision at the same committed SQLite snapshot.
  const result = r.db.transaction(() => {
    const sha = revision(r.db, branch);
    const version = sha ?? legacyVersion(r, branch);
    if (!version) return null;
    touchRef(r.db, branch);
    const meta = { repo: r.name, branch, revision: sha, version };
    if (symbol) {
      const x = getSymbol(r.db, r.dir, args.id ?? "", branch, Number(args.max_lines ?? 150));
      return reply(x.ok ? 200 : 404, { ...meta, text: x.text }, `${location(r, branch, sha, version)}\n${x.text}`);
    }
    const { cards, mode } = searchSymbols(r.db, branch, args.query ?? "", Number(args.limit ?? 8), args.path);
    const body = formatCards(cards);
    return reply(200, { ...meta, cards, mode, text: body, indexing: isIndexing(r.dir, branch) },
      `${location(r, branch, sha, version)} match=${mode} results=${cards.length}\n${body || "No symbols matched. Try fewer or different keywords."}`);
  })();
  if (result) return result;
  if (poolEnabled()) return waiting(r, branch, ensureIndexed(r.db, r.dir, branch));
  throw new RequestError(409, `branch "${branch}" has no published revision. Call switch_branch("${branch}") first.`);
}

async function readDiff(caller: Caller, args: Input) {
  const { r, branch: head } = await select(caller, { ...args, branch: args.head ?? args.branch });
  const base = validateBranch(args.base ?? BASE);
  for (const branch of new Set([base, head])) {
    const restoring = await reconcileBranch(r.db, r.dir, branch);
    if (restoring) return waiting(r, branch, restoring);
    if (revision(r.db, branch)) continue;
    const job = ensureIndexed(r.db, r.dir, branch);
    if (poolEnabled() || !await waitFor(job, WAIT_MS)) return waiting(r, branch, job);
    if (job.state === "error") throw new RequestError(503, `Could not index "${branch}": ${job.error}`);
  }
  const refs = { base: revision(r.db, base), head: revision(r.db, head) };
  if (!refs.base || !refs.head) throw new RequestError(409, "diff revisions unavailable; retry");
  const revisions = { base: refs.base, head: refs.head };
  let d: ReturnType<typeof diffSymbols>;
  if (poolEnabled()) {
    await Promise.all([...new Set([revisions.base, revisions.head])].map(sha=>ensureGitRevision(r.dir,sha)));
    d = await new Promise<ReturnType<typeof diffSymbols>>((resolve,reject) => {
      const worker = new Worker(new URL("./diffWorker.ts", import.meta.url), {
        workerData: {dbFile:r.file,dir:r.dir,base,head,revisions}, execArgv:["--import","tsx"]
      });
      worker.once("message",msg=>msg.changed ? reject(new RequestError(409,"index revisions changed; retry diff")) : resolve(msg.diff));
      worker.once("error",reject);
      worker.once("exit",code=>reject(new Error("diff worker exited with code " + code)));
    });
  } else {
    d = r.db.transaction(() => {
      if (revision(r.db,base) !== revisions.base || revision(r.db,head) !== revisions.head)
        throw new RequestError(409,"index revisions changed; retry diff");
      return diffSymbols(r.db,r.dir,base,head,revisions);
    })();
  }
  touchRef(r.db, base);
  touchRef(r.db, head);
  const body = formatDiffSymbols(d, Number(args.limit ?? 200));
  return reply(200, { repo: r.name, base, head, branch: head, revision: revisions.head, baseRevision: revisions.base, headRevision: revisions.head,
    symbols: d.symbols, files: d.files.map(f => f.path), text: body },
    `repo=${r.name} base=${base}@${revisions.base} head=${head}@${revisions.head}\n${body}`);
}

async function branches(caller: Caller, args: Input) {
  const ctx = await workspaces.select(caller, args, false);
  const r = repoByName(ctx.repo);
  const x = listBranches(r.db, r.dir, args.contains ?? "", Number(args.limit ?? 25));
  const lines = x.branches.map(b => `${b.indexed ? "*" : " "} ${b.name}${b.date ? `  (${b.date})` : ""}`);
  return reply(200, { repo: r.name, ...x }, `${x.matched}/${x.total} branches match (* = indexed)\n${lines.join("\n")}`);
}

async function status(caller: Caller, args: Input) {
  const ctx = await workspaces.select(caller, args, false);
  const r = repoByName(ctx.repo);
  const active = { repo: ctx.repo, branch: ctx.branch ?? null, revision: ctx.branch ? revision(r.db, ctx.branch) : null, version: ctx.branch ? available(r, ctx.branch) : null };
  const details = [...repos.values()].map(repo => {
    const refs = repo.db.prepare("SELECT ref, COUNT(*) files FROM v_manifest WHERE ref NOT LIKE 'commit:%' AND ref NOT GLOB ':stage:*' GROUP BY ref ORDER BY ref").all() as {ref:string;files:number}[];
    return { repo: repo.name, symbols: (repo.db.prepare("SELECT COUNT(*) c FROM symbols").get() as { c: number }).c,
      refs: refs.map(x => ({ ...x, revision: revision(repo.db, x.ref), version: available(repo, x.ref) })), budgetMiB: BUDGET_BYTES / 1048576 };
  });
  // A poll may land on a fresh replica. Attach to the same immutable build and hydrate this replica.
  if (poolEnabled() && ctx.branch && !active.revision && !jobStatus().some(j => j.repo === r.name && j.ref === ctx.branch)) {
    ensureIndexed(r.db, r.dir, ctx.branch);
  }
  const jobs = jobStatus().filter(j => j.state !== "done");
  const mirrors = [...repos.values()].map(repo => ({ repo: repo.name, dir: repo.dir, objects: existsSync(`${repo.dir}/objects`) }));
  const rd = (f: string) => { try { return readFileSync(f, "utf8").slice(0, 600); } catch { return null; } };
  const lines = [`repo=${active.repo} branch=${active.branch ?? "(unspecified)"} revision=${active.revision ?? "(unavailable)"}${active.version && !active.revision ? ` index_version=${active.version}` : ""}`];
  for (const repo of details) lines.push(`[${repo.repo}] ${repo.symbols} symbols; refs: ${repo.refs.slice(0, 30).map(x => `${x.ref}@${x.revision ?? "unknown"} (${x.files})`).join(", ")}`);
  lines.push(`jobs: ${jobs.map(j => `${j.repo}:${j.ref}=${j.phase ?? j.state}${j.error ? ` (${j.error})` : ""}`).join(", ") || "none"}`);
  lines.push(`idle flush after ${IDLE_TTL_MS / 3600_000} h; index budget: ${BUDGET_BYTES / 1048576} MiB; eviction log: ${evictionLog.slice(-5).join(" | ") || "none"}`);
  lines.push(`coverage sources: jacoco=${cov.jacocoBase ? "configured" : "not configured"} js=${cov.jsBase || cov.fixtureDir ? "configured" : "not configured"}`);
  return reply(200, { active, capacity: capacity(), repos: details, mirrors, cloneStatus: rd("/tmp/crm-index/mirror.status"), cloneErr: rd("/tmp/crm-index/clone.err"), jobs }, lines.join("\n"));
}

const scope = { repo: z.string().optional(), workspace: z.string().max(8192).optional().describe("Owner-bound handle returned by switch_branch") };
const branchScope = { ...scope, branch: z.string().optional() };
const schemas = {
  search: z.object({ ...branchScope, query: z.string(), limit: z.coerce.number().int().min(1).max(30).optional(), path: z.string().optional() }),
  symbol: z.object({ ...branchScope, id: z.string(), max_lines: z.coerce.number().int().min(1).max(2000).optional() }),
  switch: z.object({ ...scope, branch: z.string() }),
  reindex: z.object(branchScope),
  diff: z.object({ ...branchScope, base: z.string().optional(), head: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }),
  status: z.object(branchScope),
  branches: z.object({ ...scope, contains: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
};
type Action = keyof typeof schemas;
async function execute(action: Action, caller: Caller, args: Input) {
  switch (action) {
    case "search": return readBranch(caller, args, false);
    case "symbol": return readBranch(caller, args, true);
    case "switch": return switchBranch(caller, args, false);
    case "reindex": return switchBranch(caller, args, true);
    case "diff": return readDiff(caller, args);
    case "status": return status(caller, args);
    case "branches": return branches(caller, args);
  }
}
function buildServer(caller: Caller): McpServer {
  const srv = new McpServer({ name: "crm-index", version: "0.2.0" });
  const tools: [Action, string, string][] = [
    ["search", "get_code_context", "Search Java and JS symbols on the selected branch. Returns ranked cards with IDs and the indexed revision."],
    ["symbol", "get_symbol", "Read source or a class outline by symbol ID on the selected branch."],
    ["branches", "list_branches", "List repository branches newest first, optionally filtering by name. Indexed branches are marked."],
    ["switch", "switch_branch", "Select a repository branch and return a reusable workspace handle. A pending index can be polled with index_status."],
    ["reindex", "reindex", "Fetch and index the latest revision of the selected branch."],
    ["status", "index_status", "Show selected workspace, actual indexed revisions, and job progress."],
    ["diff", "diff_symbols", "List changed methods, functions, and classes between indexed base and head using a merge-base diff."],
  ];
  for (const [action, name, description] of tools) {
    srv.registerTool(name, { description, inputSchema: schemas[action].shape }, async (args: Input) => {
      try {
        const result = await execute(action, caller, args);
        return { ...text(result.message, result.status >= 400), structuredContent: result.data };
      } catch (e) { return text((e as Error).message.split("\n")[0], true); }
    });
  }
  return srv;
}

// ---- HTTP (streamable MCP) ----
const transports = new Map<string, { transport: StreamableHTTPServerTransport; user: string }>();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

// ---------- plain JSON API (for a local MCP shim; avoids the /mcp session path) ----------
const json = (res: import("node:http").ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
};

async function handleApi(path: string, req: IncomingMessage, res: import("node:http").ServerResponse, user: string): Promise<void> {
  const q = Object.fromEntries(new URL(req.url ?? "/", "http://x").searchParams);
  const b = (req.method === "POST" ? ((await readJson(req)) ?? {}) : {}) as Record<string, unknown>;
  const route = path.slice("/api/".length);
  if (Object.hasOwn(schemas, route)) {
    const action = route as Action;
    const readable = action !== "switch" && action !== "reindex";
    if (req.method !== "POST" && !(req.method === "GET" && readable)) return json(res, 405, { ok: false, error: "method not allowed" });
    const args = schemas[action].safeParse({ ...q, ...b });
    if (!args.success) return json(res, 400, { ok: false, error: args.error.issues.map(i => i.path.join(".") + " " + i.message).join(", ") });
    try {
      const result = await execute(action, { user }, args.data);
      // Older clients treat a successful read as complete. Keep their retryable conflict response.
      if (result.status === 202 && (action === "search" || action === "symbol" || action === "diff")) {
        return json(res, 409, { ...result.data, ok: false, error: result.message, hint: "Check index_status and retry" });
      }
      return json(res, result.status, result.data);
    } catch (e) { return json(res, e instanceof RequestError ? e.status : 503, { ok: false, error: (e as Error).message.split("\n")[0] }); }
  }
  const isAdmin = user === "admin";
  if (path === "/api/admin/snapshot" && req.method === "POST") {
    if (!isAdmin) return json(res, 403, { ok: false, error: "admin only" });
    if (!snapshotEnabled()) return json(res, 503, { ok: false, error: "SNAPSHOT_URL/SNAPSHOT_KEY not configured" });
    const r = repos.get(typeof b.repo === "string" ? b.repo : defaultRepo); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    if (!available(r, BASE)) return json(res, 409, { ok: false, error: "master not indexed yet" });
    try { return json(res, 200, { snapshot: await snapshotInWorker(r.db, r.name) }); } catch (e) { return json(res, 500, { ok: false, error: (e as Error).message }); }
  }

  if (path === "/api/admin/revoke" && req.method === "POST") {
    if (!isAdmin) return json(res, 403, { ok: false, error: "admin only" });
    const kid = String(b.kid ?? "");
    if (!/^[0-9a-f]{16}$/.test(kid)) return json(res, 400, { ok: false, error: "kid must be 16 hex chars" });
    repos.get(defaultRepo)!.db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)").run(`revoked:${kid}`, String(Date.now()));
    return json(res, 200, { ok: true, revoked: kid });
  }
  return json(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
}

const http = createServer(async (req, res) => {
  try {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    const path = req.url?.split("?")[0] ?? "";
    if (path.startsWith("/auth/")) { await handleAuth(path, req, res); return; }
    if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) { if (await handleOAuth(path, req, res)) return; }
    if (path.startsWith("/api/")) {
      // admin key (MCP_TOKEN) or a Zoho sign-in session minted by /auth/callback
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      let user = "";
      const who = identify(bearer);
      if (who && "user" in who) user = who.user;
      else if (authRequired()) {
        const reason = who && "error" in who ? who.error : "login_required";
        json(res, 401, { ok: false, error: reason, login: loginEnabled() ? loginTarget() : null, keys: keysEnabled() ? "send your personal key as Bearer" : null });
        return;
      }
      if (path === "/api/whoami") { json(res, 200, { ok: true, user: user || "anonymous" }); return; }
      if (user && user !== "admin") console.error(`[api] ${user} ${req.method} ${path}`);
      await handleApi(path, req, res, user);
      return;
    }
    if (req.url?.split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
    const mcpWho = identify((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (authRequired() && !(mcpWho && "user" in mcpWho)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}"` }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: send a personal key as Bearer" }, id: null }));
      return;
    }
    const user = mcpWho && "user" in mcpWho ? mcpWho.user : "";
    // Default (MCP_STATEFUL=1 to disable): no sessions. Every request is self-contained and answered as plain JSON, which avoids the
    // session path that the AppSail gateway mishandles (duplicate empty 400s on /mcp).
    if (process.env.MCP_STATEFUL !== "1") {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
      const srv = buildServer({ user });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); srv.close(); });
      await srv.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const entry = sid ? transports.get(sid) : undefined;
    if (entry && entry.user !== user) { json(res, 403, { ok: false, error: "session belongs to a different caller" }); return; }
    let t = entry?.transport;
    if (!t) {
      if (sid || req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first" }, id: null }));
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, { transport, user }); },
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await buildServer({ user, session: { branches: new Map() } }).connect(transport);
      t = transport;
    }
    await t.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("internal error");
  }
});

http.listen(PORT, () => {
  console.error(`crm-index MCP on :${PORT}/mcp  repos=${[...repos.values()].map((r) => `${r.name}=${r.dir}`).join(",")}  data=${DATA}`);
  for (const r of repos.values()) if (!available(r, BASE)) { console.error(`${r.name}: master not indexed, starting initial index`); ensureIndexed(r.db, r.dir, BASE, { fetch: false }); }
  // persist LRU clock every 30 s (request path only touches memory)
  setInterval(() => { if (poolEnabled() && capacity().pending) return; for (const r of repos.values()) persistTouches(r.db); }, 30_000).unref();
  // idle flush: every SWEEP_MIN minutes drop branches unused for IDLE_TTL_HOURS (default 48 h); master is always kept
  const sweepMs = Number(process.env.SWEEP_MIN ?? 60) * 60_000;
  setInterval(() => { for (const r of repos.values()) { const d = flushIdle(r.db, r.dir); if (d.length) console.error(`${r.name}: flushed idle ${d.join(", ")}`); } }, sweepMs).unref();
  console.error(`idle flush: branches unused for ${IDLE_TTL_MS / 3600_000} h are dropped, sweep every ${sweepMs / 60_000} min`);
  // mirror may still be cloning at boot: retry master indexing until it exists (no-op once master is indexed)
  setInterval(() => {
    for (const r of repos.values()) {
      if (!available(r, BASE) && existsSync(`${r.dir}/objects`) && !isIndexing(r.dir, BASE)) {
        console.error(`${r.name}: mirror present, indexing master`);
        ensureIndexed(r.db, r.dir, BASE, { fetch: false });
      }
    }
  }, 30_000).unref();
  // After a snapshot restore the index is usable at once but stale: once the mirror exists, refresh master from git once.
  const refreshedAfterBoot = new Set<string>();
  setInterval(() => {
    for (const r of repos.values()) {
      if (!refreshedAfterBoot.has(r.name) && available(r, BASE) && existsSync(`${r.dir}/objects`) && !isIndexing(r.dir, BASE)) {
        refreshedAfterBoot.add(r.name);
        console.error(`${r.name}: mirror ready, refreshing master`);
        ensureIndexed(r.db, r.dir, BASE, { refresh: true });
      }
    }
  }, 30_000).unref();
  // Snapshot to Stratus when master is indexed and the last snapshot (recorded in the DB, so it survives a restore) is older than SNAPSHOT_EVERY_HOURS.
  if (snapshotEnabled()) {
    const everyMs = Number(process.env.SNAPSHOT_EVERY_HOURS ?? 12) * 3600_000;
    let snapping = false;
    setInterval(async () => {
      if (snapping) return;
      for (const r of repos.values()) {
        if (!available(r, BASE) || isIndexing(r.dir, BASE)) continue;
        const at = Number((r.db.prepare("SELECT v FROM meta WHERE k='snapshot_at'").get() as { v: string } | undefined)?.v ?? 0);
        if (Date.now() - at < everyMs) continue;
        snapping = true;
        try {
          const o = await snapshotInWorker(r.db, r.name);
          console.error(o.ok ? `${r.name}: snapshot uploaded ${Math.round((o.gzBytes ?? 0) / 1048576)} MiB gz in ${(o.ms / 1000).toFixed(1)}s` : `${r.name}: snapshot skipped: ${o.skipped}`);
        } catch (e) { console.error(`${r.name}: snapshot failed: ${(e as Error).message}`); }
        snapping = false;
      }
    }, 120_000).unref();
    console.error(`snapshots: every ${everyMs / 3600_000} h to Stratus`);
  }
  // PRELOAD_REFS=refs... (comma-separated branch names) are indexed in the background at boot, e.g. the team's default branches
  const preload = (process.env.PRELOAD_REFS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const r of repos.values()) for (const b of preload) if (!available(r, b)) { console.error(`${r.name}: preloading ${b}`); ensureIndexed(r.db, r.dir, b); }
});
