import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openDb, type Db } from "./db.js";
import { BASE, ensureIndexed, ensureReady, evictionLog, flushIdle, isIndexed, isIndexing, jobStatus, listBranches, waitFor, BUDGET_BYTES, IDLE_TTL_MS } from "./branches.js";
import { persistTouches, touchRef, usedBytes } from "./evict.js";
import { formatCards, searchSymbols } from "./search.js";
import { getSymbol } from "./symbol.js";
import { diffSymbols } from "./diff.js";
import { changeSummary, formatDiffSymbols, formatSummary } from "./summary.js";
import { coverageGap, formatGap, type GapKind } from "./gap.js";
import { covConfigFromEnv, ingestJsReport } from "./coverage.js";
import { handleAuth, loginEnabled, loginTarget, verifySession } from "./auth.js";
import { capacity } from "./branches.js";
import { snapshotInWorker } from "./indexPool.js";
import { snapshotEnabled } from "./snapshot.js";
import { compareDescription, formatDescriptionCheck, formatImpact, impactTests } from "./impact.js";

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
    repos.set(name, { name, dir, db: openDb(file), file });
  }
  if (!repos.size) { console.error("REPOS (name=path[,name=path]) or REPO_DIR is required"); process.exit(1); }
}
const defaultRepo = [...repos.keys()][0];
const cov = covConfigFromEnv();

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const SAFE_ID = /^[\w.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;

interface Session { repo: string; branches: Record<string, string> }

function buildServer(session: Session): McpServer {
  const srv = new McpServer({ name: "crm-index", version: "0.2.0" });

  const pick = (name?: string): Repo | string => {
    const r = repos.get(name ?? session.repo);
    return r ?? `unknown repo "${name}". Available: ${[...repos.keys()].join(", ")}`;
  };
  const active = (r: Repo, b?: string) => b ?? session.branches[r.name] ?? BASE;
  const repoArg = z.string().optional().describe(`Repository (default "${defaultRepo}"; available: ${[...repos.keys()].join(", ")})`);
  const guard = (fn: () => Promise<ReturnType<typeof text>>) => fn().catch((e: Error) => text(`error: ${e.message.split("\n")[0]}`, true));

  srv.registerTool("get_code_context", {
    description: "Search the CRM codebase (Java + JS) by natural language or identifiers. Returns ranked symbol CARDS (id, signature, path:lines), not code bodies. Pick the relevant ids, then call get_symbol(id) for the body. Searches the session's active branch unless `branch` is given.",
    inputSchema: {
      query: z.string().describe("Keywords or identifiers, e.g. 'validate api name custom field'"),
      limit: z.number().int().min(1).max(30).optional().describe("Max cards (default 8)"),
      path: z.string().optional().describe("Only paths containing this substring, e.g. 'CRMClient/mixins'"),
      branch: z.string().optional(), repo: repoArg,
    },
  }, async ({ query, limit, path, branch, repo }) => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = active(r, branch);
    if (!isIndexed(r.db, b)) return text(`Branch "${b}" is not indexed yet in ${r.name}. Call switch_branch("${b}") first.`, true);
    touchRef(r.db, b);
    const { cards, mode } = searchSymbols(r.db, b, query, limit ?? 8, path);
    if (!cards.length) return text(`No symbols matched on ${r.name}:${b}. Try fewer or different keywords.`);
    return text(`repo=${r.name} branch=${b} match=${mode} results=${cards.length}${isIndexing(r.dir, b) ? "\nWARNING: this branch is still being indexed; results may be incomplete. Check index_status." : ""}\n${formatCards(cards)}`);
  });

  srv.registerTool("get_symbol", {
    description: "Full source of one symbol by id from get_code_context (with line numbers). For a class/interface/enum it returns a member outline instead; search a member for its body.",
    inputSchema: { id: z.string(), max_lines: z.number().int().min(10).max(2000).optional(), branch: z.string().optional(), repo: repoArg },
  }, async ({ id, max_lines, branch, repo }) => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const x = getSymbol(r.db, r.dir, id, active(r, branch), max_lines ?? 150);
    return text(x.text, !x.ok);
  });

  srv.registerTool("list_branches", {
    description: "List repository branches (newest first), optionally filtered by substring. The repo has ~18k branches, so always filter. Shows which are already indexed.",
    inputSchema: { contains: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), repo: repoArg },
  }, async ({ contains, limit, repo }) => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const x = listBranches(r.db, r.dir, contains ?? "", limit ?? 25);
    const lines = x.branches.map((b) => `${b.indexed ? "*" : " "} ${b.name}${b.date ? `  (${b.date})` : ""}`);
    return text(`${x.matched}/${x.total} branches match${x.matched > x.branches.length ? `, showing ${x.branches.length}` : ""}  (* = indexed)\n${lines.join("\n")}`);
  });

  srv.registerTool("switch_branch", {
    description: "Make a branch the active one for this session (per repo), fetching and indexing it if needed. Only changed files are parsed; unchanged blobs are shared with master. May take a few seconds on first use.",
    inputSchema: { branch: z.string(), repo: repoArg },
  }, async ({ branch, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    if (isIndexed(r.db, branch) && !isIndexing(r.dir, branch)) { session.branches[r.name] = branch; session.repo = r.name; return text(`active ${r.name} branch = ${branch} (already indexed)`); }
    const job = ensureIndexed(r.db, r.dir, branch);
    const done = await waitFor(job, WAIT_MS);
    if (done && job.state === "error") return text(`Could not index "${branch}": ${job.error}`, true);
    session.branches[r.name] = branch; session.repo = r.name;
    if (!done) return text(`Indexing "${branch}" is still running (${Math.round((Date.now() - job.startedAt) / 1000)}s so far). It is now your active branch; call index_status, then retry searches.`);
    const x = job.report!;
    return text(`active ${r.name} branch = ${branch}. indexed in ${(x.ms / 1000).toFixed(1)}s: ${x.files} files, ${x.newBlobs} new blobs parsed, ${x.reusedBlobs} reused, +${x.symbols} symbols.`);
  }));

  srv.registerTool("reindex", {
    description: "Fetch the latest commits for a branch (default: the active one) and update its index. Use after someone pushes.",
    inputSchema: { branch: z.string().optional(), repo: repoArg },
  }, async ({ branch, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = active(r, branch);
    const job = ensureIndexed(r.db, r.dir, b, { refresh: true });
    const done = await waitFor(job, WAIT_MS);
    if (!done) return text(`Reindex of "${b}" is running; check index_status.`);
    if (job.state === "error") return text(`Reindex failed: ${job.error}`, true);
    const x = job.report!;
    return text(`${r.name}:${b} up to date: ${x.newBlobs} new blobs parsed, ${x.reusedBlobs} reused, +${x.symbols} symbols, ${(x.ms / 1000).toFixed(1)}s.`);
  }));

  srv.registerTool("index_status", {
    description: "Index health per repo: which branches are indexed, symbol counts, running jobs, and this session's active branches.",
    inputSchema: {},
  }, async () => {
    const out: string[] = [`session repo: ${session.repo}`];
    for (const r of repos.values()) {
      const refs = r.db.prepare("SELECT ref, COUNT(*) files FROM v_manifest WHERE ref NOT LIKE 'commit:%' GROUP BY ref ORDER BY ref").all() as { ref: string; files: number }[];
      const n = (r.db.prepare("SELECT COUNT(*) c FROM symbols").get() as { c: number }).c;
      out.push(`[${r.name}] active branch: ${session.branches[r.name] ?? BASE}  symbols: ${n}  db: ${(statSync(r.file).size / 1048576).toFixed(0)} MiB`);
      for (const x of refs.slice(0, 30)) out.push(`  ${x.ref}  ${x.files} files`);
    }
    const js = jobStatus().filter((j) => j.state !== "done");
    out.push(js.length ? `jobs: ${js.map((j) => `${j.ref}=${j.state}${j.error ? `(${j.error})` : ""}`).join(", ")}` : "jobs: none");
    out.push(`idle flush after ${IDLE_TTL_MS / 3600_000} h; index budget: ${BUDGET_BYTES / 1048576} MiB; eviction log: ${evictionLog.slice(-5).join(" | ") || "none"}`);
    out.push(`coverage sources: jacoco=${cov.jacocoBase ? "configured" : "not configured"} js=${cov.jsBase || cov.fixtureDir ? "configured" : "not configured"}`);
    return text(out.join("\n"));
  });

  // ---------- diff ----------
  const range = {
    base: z.string().optional().describe(`Base branch (default ${BASE}); the diff is merge-base(base, head)..head`),
    head: z.string().optional().describe("Head branch (default: active branch)"),
    repo: repoArg,
  };

  srv.registerTool("diff_symbols", {
    description: "Ground-truth list of CHANGED symbols (methods/functions/classes) between base and head, derived from git diff hunks mapped onto the symbol index: added / modified / removed / class_level (fields, constants, imports). Use this instead of asking the developer what changed.",
    inputSchema: range,
  }, async ({ base, head, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = base ?? BASE, h = active(r, head);
    await ensureReady(r.db, r.dir, b); await ensureReady(r.db, r.dir, h);
    return text(formatDiffSymbols(diffSymbols(r.db, r.dir, b, h), 80));
  }));






  return srv;
}

// ---- HTTP (streamable MCP) ----
const transports = new Map<string, StreamableHTTPServerTransport>();

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

async function handleApi(path: string, req: IncomingMessage, res: import("node:http").ServerResponse, isAdmin = false): Promise<void> {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  const b = (req.method === "POST" ? ((await readJson(req)) ?? {}) : {}) as Record<string, any>;
  const get = (k: string) => q.get(k) ?? undefined;
  const pickRepo = (name?: string): Repo | null => repos.get(name ?? defaultRepo) ?? null;

  if (path === "/api/status" && req.method === "GET") {
    const out = [];
    for (const r of repos.values()) {
      const refs = r.db.prepare("SELECT ref, COUNT(*) files FROM v_manifest WHERE ref NOT LIKE 'commit:%' GROUP BY ref ORDER BY ref").all();
      out.push({ repo: r.name, symbols: (r.db.prepare("SELECT COUNT(*) c FROM symbols").get() as { c: number }).c, refs, budgetMiB: BUDGET_BYTES / 1048576 });
    }
    const rd = (f: string) => { try { return readFileSync(f, "utf8").slice(0, 600); } catch { return null; } };
    const mirrors = [...repos.values()].map((r) => ({ repo: r.name, dir: r.dir, objects: existsSync(`${r.dir}/objects`) }));
    return json(res, 200, { ok: true, capacity: capacity(), repos: out, mirrors, cloneStatus: rd("/tmp/crm-index/mirror.status"), cloneErr: rd("/tmp/crm-index/clone.err"), jobs: jobStatus().filter((j) => j.state !== "done") });
  }

  if (path === "/api/branches" && req.method === "GET") {
    const r = pickRepo(get("repo")); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    const x = listBranches(r.db, r.dir, get("contains") ?? "", Number(get("limit") ?? 25));
    return json(res, 200, { ok: true, total: x.total, matched: x.matched, branches: x.branches });
  }

  if (path === "/api/search" && req.method === "POST") {
    const r = pickRepo(b.repo); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    const branch = b.branch ?? BASE;
    if (!isIndexed(r.db, branch)) return json(res, 409, { ok: false, error: `branch "${branch}" not indexed`, hint: "POST /api/switch first" });
    touchRef(r.db, branch);
    const { cards, mode } = searchSymbols(r.db, branch, String(b.query ?? ""), Math.min(Number(b.limit ?? 8), 30), b.path);
    return json(res, 200, { ok: true, repo: r.name, branch, mode, cards, text: formatCards(cards), indexing: isIndexing(r.dir, branch) });
  }

  if (path === "/api/symbol" && req.method === "POST") {
    const r = pickRepo(b.repo); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    const x = getSymbol(r.db, r.dir, String(b.id ?? ""), b.branch ?? BASE, Math.min(Number(b.max_lines ?? 150), 2000));
    return json(res, x.ok ? 200 : 404, { ok: x.ok, text: x.text });
  }

  if (path === "/api/switch" && req.method === "POST") {
    const r = pickRepo(b.repo); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    const branch = String(b.branch ?? "");
    if (!branch) return json(res, 400, { ok: false, error: "branch required" });
    if (isIndexed(r.db, branch) && !isIndexing(r.dir, branch)) return json(res, 200, { ok: true, status: "indexed", branch });
    const job = ensureIndexed(r.db, r.dir, branch);
    const done = await waitFor(job, WAIT_MS);
    if (done && job.state === "error") return json(res, 500, { ok: false, error: job.error });
    if (!done) return json(res, 202, { ok: true, status: "indexing", branch, progress: job.progress ?? null });
    return json(res, 200, { ok: true, status: "indexed", branch, report: job.report });
  }

  if (path === "/api/diff" && req.method === "POST") {
    const r = pickRepo(b.repo); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    const base = b.base ?? BASE, head = b.head;
    if (!head) return json(res, 400, { ok: false, error: "head required" });
    await ensureReady(r.db, r.dir, base); await ensureReady(r.db, r.dir, head);
    const d = diffSymbols(r.db, r.dir, base, head);
    return json(res, 200, { ok: true, base, head, symbols: d.symbols, files: d.files.map((f) => f.path), text: formatDiffSymbols(d, Number(b.limit ?? 200)) });
  }

  if (path === "/api/admin/snapshot" && req.method === "POST") {
    if (!isAdmin) return json(res, 403, { ok: false, error: "admin only" });
    if (!snapshotEnabled()) return json(res, 503, { ok: false, error: "SNAPSHOT_URL/SNAPSHOT_KEY not configured" });
    const r = pickRepo(b.repo); if (!r) return json(res, 404, { ok: false, error: "unknown repo" });
    if (!isIndexed(r.db, BASE)) return json(res, 409, { ok: false, error: "master not indexed yet" });
    try { return json(res, 200, { snapshot: await snapshotInWorker(r.db, r.name) }); } catch (e) { return json(res, 500, { ok: false, error: (e as Error).message }); }
  }

  return json(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
}

const http = createServer(async (req, res) => {
  try {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    const path = req.url?.split("?")[0] ?? "";
    if (path.startsWith("/auth/")) { await handleAuth(path, req, res); return; }
    if (path.startsWith("/api/")) {
      // admin key (MCP_TOKEN) or a Zoho sign-in session minted by /auth/callback
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      let user = "";
      if (TOKEN && bearer === TOKEN) user = "admin";
      else {
        const v = bearer ? verifySession(bearer) : null;
        if (v?.session) user = v.session.email;
        else if (TOKEN || loginEnabled()) {
          json(res, 401, { ok: false, error: v?.expired ? "session_expired" : "login_required", login: loginEnabled() ? loginTarget() : null });
          return;
        }
      }
      if (path === "/api/whoami") { json(res, 200, { ok: true, user: user || "anonymous" }); return; }
      if (user && user !== "admin") console.error(`[api] ${user} ${req.method} ${path}`);
      await handleApi(path, req, res, user === "admin");
      return;
    }
    if (req.url?.split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end("unauthorized"); return; }
    // Default (MCP_STATEFUL=1 to disable): no sessions. Every request is self-contained and answered as plain JSON, which avoids the
    // session path that the AppSail gateway mishandles (duplicate empty 400s on /mcp).
    if (process.env.MCP_STATEFUL !== "1") {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
      const srv = buildServer({ repo: defaultRepo, branches: {} });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); srv.close(); });
      await srv.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await readJson(req) : undefined;
    let t = sid ? transports.get(sid) : undefined;
    if (!t) {
      if (sid || req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first" }, id: null }));
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, transport); },
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await buildServer({ repo: defaultRepo, branches: {} }).connect(transport);
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
  for (const r of repos.values()) if (!isIndexed(r.db, BASE)) { console.error(`${r.name}: master not indexed, starting initial index`); ensureIndexed(r.db, r.dir, BASE, { fetch: false }); }
  // persist LRU clock every 30 s (request path only touches memory)
  setInterval(() => { for (const r of repos.values()) persistTouches(r.db); }, 30_000).unref();
  // idle flush: every SWEEP_MIN minutes drop branches unused for IDLE_TTL_HOURS (default 48 h); master is always kept
  const sweepMs = Number(process.env.SWEEP_MIN ?? 60) * 60_000;
  setInterval(() => { for (const r of repos.values()) { const d = flushIdle(r.db, r.dir); if (d.length) console.error(`${r.name}: flushed idle ${d.join(", ")}`); } }, sweepMs).unref();
  console.error(`idle flush: branches unused for ${IDLE_TTL_MS / 3600_000} h are dropped, sweep every ${sweepMs / 60_000} min`);
  // mirror may still be cloning at boot: retry master indexing until it exists (no-op once master is indexed)
  setInterval(() => {
    for (const r of repos.values()) {
      if (!isIndexed(r.db, BASE) && existsSync(`${r.dir}/objects`) && !isIndexing(r.dir, BASE)) {
        console.error(`${r.name}: mirror present, indexing master`);
        ensureIndexed(r.db, r.dir, BASE, { fetch: false });
      }
    }
  }, 30_000).unref();
  // After a snapshot restore the index is usable at once but stale: once the mirror exists, refresh master from git once.
  let refreshedAfterBoot = false;
  setInterval(() => {
    if (refreshedAfterBoot) return;
    for (const r of repos.values()) {
      if (isIndexed(r.db, BASE) && existsSync(`${r.dir}/objects`) && !isIndexing(r.dir, BASE)) {
        refreshedAfterBoot = true;
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
        if (!isIndexed(r.db, BASE) || isIndexing(r.dir, BASE)) continue;
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
  for (const r of repos.values()) for (const b of preload) if (!isIndexed(r.db, b)) { console.error(`${r.name}: preloading ${b}`); ensureIndexed(r.db, r.dir, b); }
});
