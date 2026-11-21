#!/usr/bin/env node
// crm-index shim: a local stdio MCP server. The AI client talks MCP to this process;
// this process calls the central index over plain HTTPS JSON (no MCP sessions cross the cloud gateway).
//   CRM_INDEX_URL    base URL of the index, e.g. https://crmindex-xxxx.development.catalystappsail.in
//   CRM_INDEX_TOKEN  optional admin key; normally you sign in with Zoho instead (browser opens on first use)
//   CRM_INDEX_REPO   optional default repo (server default otherwise)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const BASE = (process.env.CRM_INDEX_URL ?? "").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.CRM_INDEX_TOKEN ?? "";
const REPO = process.env.CRM_INDEX_REPO || undefined;
if (!BASE) {
  console.error("crm-index-shim: set CRM_INDEX_URL");
  process.exit(1);
}

// ---------- Zoho sign-in session (stored per user, readable only by them) ----------
const SESSION_DIR = join(homedir(), ".crm-index");
const SESSION_FILE = join(SESSION_DIR, `session-${new URL(BASE).host}.json`);
const loadSession = () => { try { return JSON.parse(readFileSync(SESSION_FILE, "utf8")); } catch { return null; } };
const saveSession = (s) => { mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 }); writeFileSync(SESSION_FILE, JSON.stringify(s), { mode: 0o600 }); };
const clearSession = () => { try { rmSync(SESSION_FILE); } catch {} };
const currentToken = () => loadSession()?.token || ADMIN_TOKEN;

function openBrowser(url) {
  if (process.env.CRM_INDEX_NO_BROWSER === "1") return; // tests / headless: follow the printed URL yourself
  const [cmd, args] = platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch {}
}

/** Ask the server where to sign in (an unauthenticated call returns it). Falls back to the built-in route. */
async function discoverLoginPath() {
  try {
    const r = await fetch(`${BASE}/api/whoami`, { signal: AbortSignal.timeout(15_000) });
    const d = await r.json();
    if (d?.login) return d.login;
  } catch {}
  return "/auth/login";
}

let loginInFlight = null; // one sign-in at a time; concurrent tool calls share it
let lastLoginUrl = "";

/** Opens Zoho sign-in in the browser; resolves with the session once the server redirects back to us. */
function startLogin(loginPath = "/auth/login") {
  if (loginInFlight) return loginInFlight;
  loginInFlight = new Promise((resolve, reject) => {
    const state = randomBytes(18).toString("base64url");
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      if (u.searchParams.get("state") !== state || !u.searchParams.get("token")) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Sign-in did not match this request. Run the tool again.");
        return;
      }
      const session = { token: u.searchParams.get("token"), email: u.searchParams.get("email") ?? "", at: Date.now() };
      saveSession(session);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:4em"><h2>Signed in to crm-index</h2><p>You can close this tab and go back to your AI tool.</p>');
      srv.close(); clearTimeout(timer); resolve(session);
    });
    const timer = setTimeout(() => { srv.close(); reject(new Error("sign-in timed out")); }, 5 * 60_000);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const target = /^https?:\/\//.test(loginPath) ? loginPath : `${BASE}${loginPath}`;
      lastLoginUrl = `${target}${target.includes("?") ? "&" : "?"}port=${port}&state=${state}`;
      console.error(`crm-index: sign in at ${lastLoginUrl}`);
      openBrowser(lastLoginUrl);
    });
  }).finally(() => { loginInFlight = null; });
  return loginInFlight;
}

// The active branch lives here, in the user's own process, so the server stays stateless per request.
let activeBranch = "master";

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function rawApi(method, path, body, { timeoutMs = 60_000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const tok = currentToken();
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt < retries) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      return { status: 0, data: { ok: false, error: `network: ${e.message}` } };
    }
    // the server answers 503 while it boots or re-indexes after a restart: wait and retry
    if (res.status === 503 && attempt < retries) { await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); continue; }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { ok: false, error: raw.slice(0, 200) || `http ${res.status}` }; }
    return { status: res.status, data };
  }
}

/** API call that handles "login required / session expired" by signing in with Zoho and retrying once. */
async function api(method, path, body, opts) {
  const r = await rawApi(method, path, body, opts);
  if (r.status !== 401 || !["login_required", "session_expired"].includes(r.data.error) || !r.data.login) return r;
  if (r.data.error === "session_expired") clearSession();
  const login = startLogin(r.data.login);
  // MCP clients time out tool calls (~60 s): wait a while for the user to finish signing in, else ask them to retry
  const done = await Promise.race([login.then(() => true, () => false), new Promise((res) => setTimeout(() => res(false), 45_000))]);
  if (!done) {
    return { status: 401, data: { ok: false, error: `Sign in with Zoho in the browser window that just opened${lastLoginUrl ? ` (or open ${lastLoginUrl})` : ""}, then retry.`, needsLogin: true } };
  }
  return rawApi(method, path, body, opts);
}

const errText = (r) => {
  if (r.data?.needsLogin) return `crm-index: ${r.data.error}`;
  if (r.status === 401) return "crm-index: not signed in. Run the `login` tool.";
  if (r.status === 503 || r.status === 0) return `crm-index is starting or unreachable (${r.data.error ?? r.status}). Retry in a minute.`;
  return `crm-index error ${r.status}: ${r.data.error ?? "unknown"}${r.data.hint ? ` (${r.data.hint})` : ""}`;
};

const srv = new McpServer({ name: "crm-index", version: "0.1.0" });

srv.registerTool("get_code_context", {
  description: "Search the CRM codebase (Java + JS) by natural language or identifiers. Returns ranked symbol CARDS (id, signature, path:lines), not bodies. Pick ids, then call get_symbol(id). Uses the active branch unless `branch` is given.",
  inputSchema: {
    query: z.string().describe("Keywords or identifiers, e.g. 'validate api name custom field'"),
    limit: z.number().int().min(1).max(30).optional().describe("Max cards (default 8)"),
    path: z.string().optional().describe("Only paths containing this substring"),
    branch: z.string().optional(),
  },
}, async ({ query, limit, path, branch }) => {
  const b = branch ?? activeBranch;
  const r = await api("POST", "/api/search", { query, limit, path, branch: b, repo: REPO });
  if (r.status === 409) return text(`Branch "${b}" is not indexed yet. Call switch_branch("${b}") first.`, true);
  if (!r.data.ok) return text(errText(r), true);
  if (!r.data.cards.length) return text(`No symbols matched on ${b}. Try fewer or different keywords.`);
  return text(`branch=${b} match=${r.data.mode} results=${r.data.cards.length}${r.data.indexing ? "\nWARNING: branch still indexing; results may be incomplete." : ""}\n${r.data.text}`);
});

srv.registerTool("get_symbol", {
  description: "Full source of one symbol by id from get_code_context, with line numbers. Classes return a member outline.",
  inputSchema: { id: z.string(), max_lines: z.number().int().min(10).max(2000).optional(), branch: z.string().optional() },
}, async ({ id, max_lines, branch }) => {
  const r = await api("POST", "/api/symbol", { id, max_lines, branch: branch ?? activeBranch, repo: REPO });
  if (!r.data.ok) return text(r.data.text ?? errText(r), true);
  return text(r.data.text);
});

srv.registerTool("list_branches", {
  description: "List repository branches (newest first), filtered by substring. The repo has ~18k branches, so always filter. * = indexed.",
  inputSchema: { contains: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
}, async ({ contains, limit }) => {
  const qs = new URLSearchParams({ contains: contains ?? "", limit: String(limit ?? 25), ...(REPO ? { repo: REPO } : {}) });
  const r = await api("GET", `/api/branches?${qs}`);
  if (!r.data.ok) return text(errText(r), true);
  const lines = r.data.branches.map((x) => `${x.indexed ? "*" : " "} ${x.name}${x.date ? `  (${x.date})` : ""}`);
  return text(`${r.data.matched}/${r.data.total} branches match (* = indexed)\n${lines.join("\n")}`);
});

srv.registerTool("switch_branch", {
  description: "Make a branch active for this session, indexing it on the server if needed (only changed files are parsed). First use of a branch may take a while.",
  inputSchema: { branch: z.string() },
}, async ({ branch }) => {
  // the server waits up to ~25 s per call
  // MCP clients time out tool calls (often ~60 s), so stop polling after ~45 s and report progress instead
  const deadline = Date.now() + 45_000;
  for (;;) {
    const r = await api("POST", "/api/switch", { branch, repo: REPO }, { timeoutMs: 40_000 });
    if (r.status === 200 && r.data.ok) { activeBranch = branch; return text(`active branch = ${branch} (${r.data.status})`); }
    if (r.status === 202) {
      if (Date.now() > deadline) { activeBranch = branch; return text(`"${branch}" is still indexing; it is now active. Searches may be incomplete for a few minutes.`); }
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    return text(errText(r), true);
  }
});

srv.registerTool("diff_symbols", {
  description: "Changed methods/functions/classes between two branches (merge-base diff): added / modified / removed / class_level.",
  inputSchema: { head: z.string().optional().describe("Head branch (default: active branch)"), base: z.string().optional().describe("Base branch (default master)") },
}, async ({ head, base }) => {
  const r = await api("POST", "/api/diff", { base: base ?? "master", head: head ?? activeBranch, repo: REPO }, { timeoutMs: 120_000 });
  if (!r.data.ok) return text(errText(r), true);
  return text(r.data.text);
});

srv.registerTool("login", {
  description: "Sign in to crm-index with your Zoho account (opens a browser). Use when tools say you are not signed in, or to switch accounts.",
  inputSchema: {},
}, async () => {
  clearSession();
  const login = startLogin(await discoverLoginPath());
  const done = await Promise.race([login.then(() => true, () => false), new Promise((res) => setTimeout(() => res(false), 50_000))]);
  if (!done) return text(`Finish signing in in the browser${lastLoginUrl ? ` (${lastLoginUrl})` : ""}, then run any crm-index tool.`);
  return text(`Signed in as ${loadSession()?.email ?? "?"}.`);
});

srv.registerTool("index_status", {
  description: "Index health: indexed branches, symbol counts, running jobs, and this session's active branch.",
  inputSchema: {},
}, async () => {
  const r = await api("GET", "/api/status");
  if (!r.data.ok) return text(errText(r), true);
  const who = await rawApi("GET", "/api/whoami");
  const lines = [`signed in as: ${who.data?.user ?? "?"}`, `active branch (this session): ${activeBranch}`];
  for (const x of r.data.repos) lines.push(`[${x.repo}] symbols=${x.symbols} refs: ${x.refs.map((f) => `${f.ref}(${f.files})`).join(", ") || "none"}`);
  if (r.data.jobs?.length) lines.push(`jobs: ${r.data.jobs.map((j) => `${j.ref}=${j.state}${j.error ? `(${j.error.slice(0, 80)})` : ""}`).join(", ")}`);
  return text(lines.join("\n"));
});

await srv.connect(new StdioServerTransport());
