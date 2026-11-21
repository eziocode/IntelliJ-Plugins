import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, existsSync } from "node:fs";
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
import { compareDescription, formatDescriptionCheck, formatImpact, impactTests } from "./impact.js";

const DATA = process.env.DATA_DIR ?? "data";
const PORT = Number(process.env.PORT ?? 8787);
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

  // ---------- QA tools ----------
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

  srv.registerTool("change_summary", {
    description: "Structured facts about a branch change: commits (sha+subject), files by status/type, modules touched, symbol counts, added/removed public Java API, tests touched, largest changes. Cross-check the developer's check-in description against this.",
    inputSchema: range,
  }, async ({ base, head, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = base ?? BASE, h = active(r, head);
    await ensureReady(r.db, r.dir, b); await ensureReady(r.db, r.dir, h);
    return text(formatSummary(changeSummary(r.db, r.dir, b, h)));
  }));

  srv.registerTool("compare_description", {
    description: "Heuristically compare a developer's check-in description with the actual diff: identifiers named but absent from the diff, and modules changed but never mentioned. Heuristic only; verify flagged items by hand.",
    inputSchema: { description: z.string().min(5), ...range },
  }, async ({ description, base, head, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = base ?? BASE, h = active(r, head);
    await ensureReady(r.db, r.dir, b); await ensureReady(r.db, r.dir, h);
    return text(formatDescriptionCheck(compareDescription(diffSymbols(r.db, r.dir, b, h), description)));
  }));

  srv.registerTool("ingest_coverage", {
    description: "Register/refresh a coverage report. kind=js pulls the JS coverage API (needs server-side credentials) and stores missed ranges with branch+commit. kind=jacoco records the report's branch/commit so coverage_gap can gate on it (Java line data is fetched lazily per file).",
    inputSchema: { kind: z.enum(["js", "jacoco"]), report: z.string().regex(SAFE_ID), branch: z.string().optional(), commit: z.string().regex(SHA).optional(), refresh: z.boolean().optional(), repo: repoArg },
  }, async ({ kind, report, branch, commit, refresh, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    if (kind === "js") {
      const m = await ingestJsReport(r.db, cov, report, refresh ?? false);
      return text(`js report ${report}: branch=${m.branch ?? "?"} commit=${m.commit?.slice(0, 10) ?? "?"} build=${m.build ?? "?"} missed-case ranges=${m.total}`);
    }
    r.db.prepare("INSERT OR REPLACE INTO cov_report VALUES (?,?,?,?,?,?)").run(report, "jacoco", branch ?? null, commit ?? null, new Date().toISOString(), "{}");
    return text(`jacoco report ${report} registered: branch=${branch ?? "?"} commit=${commit?.slice(0, 10) ?? "none (pass commit for the commit gate)"}`);
  }));

  srv.registerTool("coverage_gap", {
    description: "Which CHANGED lines/methods no test executed, per a coverage report. Computes changed lines from git (not from the developer), maps them onto the report, and gates on the report's commit: files that differ between the report's commit and head are flagged unverifiable. Set at_report_commit=true to evaluate exactly at the report's commit. Cross-checks the JS tool's own missed list.",
    inputSchema: { kind: z.enum(["js", "jacoco"]), report: z.string().regex(SAFE_ID), report_commit: z.string().regex(SHA).optional(), at_report_commit: z.boolean().optional(), ...range },
  }, async ({ kind, report, report_commit, at_report_commit, base, head, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = base ?? BASE, h = active(r, head);
    await ensureReady(r.db, r.dir, h);
    const res = await coverageGap(r.db, r.dir, cov, { base: b, head: h, kind: kind as GapKind, report, reportCommit: report_commit, atReportCommit: at_report_commit });
    return text(formatGap(res));
  }));

  srv.registerTool("impact_tests", {
    description: "Likely-affected tests for a change. METHOD: lexical identifier match between changed symbols and test files in this repo, plus QA scenario text from previously ingested coverage reports on overlapping lines. There is NO per-test coverage, so this is a guess and says so; if the repo has no tests, QA automation lives elsewhere.",
    inputSchema: range,
  }, async ({ base, head, repo }) => guard(async () => {
    const r = pick(repo); if (typeof r === "string") return text(r, true);
    const b = base ?? BASE, h = active(r, head);
    await ensureReady(r.db, r.dir, b); await ensureReady(r.db, r.dir, h);
    return text(formatImpact(await impactTests(r.db, r.dir, b, h)));
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

const http = createServer(async (req, res) => {
  try {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    if (req.url?.split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end("unauthorized"); return; }
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
  // PRELOAD_REFS=refs... (comma-separated branch names) are indexed in the background at boot, e.g. the team's default branches
  const preload = (process.env.PRELOAD_REFS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const r of repos.values()) for (const b of preload) if (!isIndexed(r.db, b)) { console.error(`${r.name}: preloading ${b}`); ensureIndexed(r.db, r.dir, b); }
});
