import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openDb, type Db } from "./db.js";
import { BASE, ensureIndexed, isIndexed, isIndexing, jobStatus, listBranches, waitFor } from "./branches.js";
import { formatCards, searchSymbols } from "./search.js";
import { getSymbol } from "./symbol.js";

const REPO = process.env.REPO_DIR ?? "";
const DATA = process.env.DATA_DIR ?? "data";
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.MCP_TOKEN ?? "";
const WAIT_MS = Number(process.env.SWITCH_WAIT_MS ?? 25_000);
if (!REPO) { console.error("REPO_DIR (path to the git mirror) is required"); process.exit(1); }
mkdirSync(DATA, { recursive: true });
const dbFile = `${DATA}/index.sqlite`;
const db: Db = openDb(dbFile);

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

interface Session { branch: string }

function buildServer(session: Session): McpServer {
  const srv = new McpServer({ name: "crm-index", version: "0.1.0" });

  const resolveBranch = (b?: string) => b ?? session.branch;
  const notReady = (b: string) => `Branch "${b}" is not indexed yet. Call switch_branch("${b}") first${b === BASE ? " (master is still warming up; check index_status)" : ""}.`;

  srv.registerTool("get_code_context", {
    description: "Search the CRM codebase (Java + JS) by natural language or identifiers. Returns ranked symbol CARDS (id, signature, path:lines), not code bodies. Pick the relevant ids, then call get_symbol(id) for the body. Searches the session's active branch unless `branch` is given.",
    inputSchema: {
      query: z.string().describe("Keywords or identifiers, e.g. 'validate api name custom field'"),
      limit: z.number().int().min(1).max(30).optional().describe("Max cards (default 8)"),
      path: z.string().optional().describe("Only paths containing this substring, e.g. 'CRMClient/mixins'"),
      branch: z.string().optional(),
    },
  }, async ({ query, limit, path, branch }) => {
    const b = resolveBranch(branch);
    if (!isIndexed(db, b)) return text(notReady(b), true);
    const { cards, mode } = searchSymbols(db, b, query, limit ?? 8, path);
    if (!cards.length) return text(`No symbols matched on ${b}. Try fewer or different keywords.`);
    return text(`branch=${b} match=${mode} results=${cards.length}${isIndexing(b) ? "\nWARNING: this branch is still being indexed; results may be incomplete. Check index_status." : ""}\n${formatCards(cards)}`);
  });

  srv.registerTool("get_symbol", {
    description: "Full source of one symbol by id from get_code_context (with line numbers). For a class/interface/enum it returns a member outline instead; search a member for its body.",
    inputSchema: { id: z.string(), max_lines: z.number().int().min(10).max(2000).optional(), branch: z.string().optional() },
  }, async ({ id, max_lines, branch }) => {
    const r = getSymbol(db, REPO, id, resolveBranch(branch), max_lines ?? 150);
    return text(r.text, !r.ok);
  });

  srv.registerTool("list_branches", {
    description: "List repository branches (newest first), optionally filtered by substring. The repo has ~18k branches, so always filter. Shows which are already indexed.",
    inputSchema: { contains: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ contains, limit }) => {
    const r = listBranches(db, REPO, contains ?? "", limit ?? 25);
    const lines = r.branches.map((b) => `${b.indexed ? "*" : " "} ${b.name}${b.date ? `  (${b.date})` : ""}`);
    return text(`${r.matched}/${r.total} branches match${r.matched > r.branches.length ? `, showing ${r.branches.length}` : ""}  (* = indexed)\n${lines.join("\n")}`);
  });

  srv.registerTool("switch_branch", {
    description: "Make a branch the active one for this session, fetching and indexing it if needed (only its changed files are re-embedded/parsed; unchanged blobs are shared with master). May take a few seconds on first use.",
    inputSchema: { branch: z.string() },
  }, async ({ branch }) => {
    if (isIndexed(db, branch)) { session.branch = branch; return text(`active branch = ${branch} (already indexed)`); }
    const job = ensureIndexed(db, REPO, branch);
    const done = await waitFor(job, WAIT_MS);
    if (done && job.state === "error") return text(`Could not index "${branch}": ${job.error}`, true);
    if (!done) { session.branch = branch; return text(`Indexing "${branch}" is still running (started ${Math.round((Date.now() - job.startedAt) / 1000)}s ago). It is now your active branch; call index_status, then retry searches.`); }
    session.branch = branch;
    const r = job.report!;
    return text(`active branch = ${branch}. indexed in ${(r.ms / 1000).toFixed(1)}s: ${r.files} files, ${r.newBlobs} new blobs parsed, ${r.reusedBlobs} reused, +${r.symbols} symbols.`);
  });

  srv.registerTool("reindex", {
    description: "Fetch the latest commits for a branch (default: the active one) and update its index. Use after someone pushes.",
    inputSchema: { branch: z.string().optional() },
  }, async ({ branch }) => {
    const b = resolveBranch(branch);
    const job = ensureIndexed(db, REPO, b, { refresh: true });
    const done = await waitFor(job, WAIT_MS);
    if (!done) return text(`Reindex of "${b}" is running; check index_status.`);
    if (job.state === "error") return text(`Reindex failed: ${job.error}`, true);
    const r = job.report!;
    return text(`${b} up to date: ${r.newBlobs} new blobs parsed, ${r.reusedBlobs} reused, +${r.symbols} symbols, ${(r.ms / 1000).toFixed(1)}s.`);
  });

  srv.registerTool("index_status", {
    description: "Index health: which branches are indexed, symbol counts, running jobs, and this session's active branch.",
    inputSchema: {},
  }, async () => {
    const refs = db.prepare("SELECT ref, COUNT(*) files FROM manifest GROUP BY ref ORDER BY ref").all() as { ref: string; files: number }[];
    const n = (db.prepare("SELECT COUNT(*) c FROM symbols").get() as { c: number }).c;
    const when = (r: string) => (db.prepare("SELECT v FROM meta WHERE k=?").get(`indexed:${r}`) as { v: string } | undefined)?.v ?? "?";
    const js = jobStatus().filter((j) => j.state !== "done");
    return text([
      `active branch: ${session.branch}`,
      `symbols: ${n}, db: ${(statSync(dbFile).size / 1048576).toFixed(0)} MiB`,
      `indexed refs (${refs.length}):`,
      ...refs.slice(0, 40).map((r) => `  ${r.ref}  ${r.files} files  indexed ${when(r.ref)}`),
      js.length ? `jobs: ${js.map((j) => `${j.ref}=${j.state}${j.error ? `(${j.error})` : ""}`).join(", ")}` : "jobs: none",
    ].join("\n"));
  });

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
      await buildServer({ branch: BASE }).connect(transport);
      t = transport;
    }
    await t.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("internal error");
  }
});

http.listen(PORT, () => {
  console.error(`crm-index MCP on :${PORT}/mcp  repo=${REPO}  data=${DATA}`);
  if (!isIndexed(db, BASE)) { console.error("master not indexed: starting initial index"); ensureIndexed(db, REPO, BASE, { fetch: false }); }
});
