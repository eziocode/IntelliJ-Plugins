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

// Each stdio process can keep its own workspace even when two sessions use one credential.
const contexts = new Map();
const pendingSwitches = new Map();
let latestSwitch = 0;
let selectedRepo = REPO;
function scope(repo, branch, workspace) {
  const chosenRepo = repo ?? selectedRepo;
  const pinned = contexts.get(chosenRepo);
  if (workspace) return { repo, branch, workspace };
  if (branch !== undefined) return { repo: chosenRepo, branch };
  return { repo: chosenRepo, workspace: pinned?.workspace, branch: pinned?.workspace ? undefined : pinned?.branch };
}
const scopeSchema = { repo: z.string().optional(), branch: z.string().optional(), workspace: z.string().optional() };
const location = d => `repo=${d.repo ?? "default"} branch=${d.branch} revision=${d.revision ?? "unknown"}${d.version && !d.revision ? ` index_version=${d.version}` : ""}`;

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

// Shared keys and anonymous callers have no server-side default. A fresh shim explicitly selects master.
async function scopedApi(path, args, opts) {
  const result = await api("POST", path, args, opts);
  if (result.status === 400 && !args.branch && !args.workspace && result.data.error === "branch or workspace required for a shared credential") {
    return api("POST", path, { ...args, branch: "master" }, opts);
  }
  return result;
}
const pendingResult = r => text(`${location(r.data)} index=${r.data.state ?? r.data.status}. Check index_status and retry.`);

srv.registerTool("get_code_context", {
  description: "Search code on the selected branch. Returns ranked symbol cards with source locations.",
  inputSchema: { ...scopeSchema, query: z.string(), limit: z.number().int().min(1).max(30).optional(), path: z.string().optional() },
}, async ({ repo, branch, workspace, ...args }) => {
  const r = await scopedApi("/api/search", { ...scope(repo, branch, workspace), ...args });
  if (r.status === 202 || r.data.status === "indexing") return pendingResult(r);
  if (!r.data.ok) return text(errText(r), true);
  return text(`${location(r.data)} match=${r.data.mode} results=${r.data.cards.length}\n${r.data.text || "No symbols matched. Try fewer or different keywords."}`);
});

srv.registerTool("get_symbol", {
  description: "Read a symbol body or a class outline from the selected branch.",
  inputSchema: { ...scopeSchema, id: z.string(), max_lines: z.number().int().min(10).max(2000).optional() },
}, async ({ repo, branch, workspace, ...args }) => {
  const r = await scopedApi("/api/symbol", { ...scope(repo, branch, workspace), ...args });
  if (r.status === 202 || r.data.status === "indexing") return pendingResult(r);
  if (!r.data.ok) return text(r.data.text ?? errText(r), true);
  return text(`${location(r.data)}\n${r.data.text}`);
});

srv.registerTool("list_branches", {
  description: "List repository branches newest first. Filter by substring.",
  inputSchema: { repo: z.string().optional(), workspace: z.string().optional(), contains: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
}, async ({ repo, workspace, contains, limit }) => {
  const opts = scope(repo, undefined, workspace);
  const qs = new URLSearchParams({ contains: contains ?? "", limit: String(limit ?? 25) });
  for (const [key, value] of Object.entries(opts)) if (value !== undefined) qs.set(key, value);
  const r = await api("GET", `/api/branches?${qs}`);
  if (!r.data.ok) return text(errText(r), true);
  const lines = r.data.branches.map(x => `${x.indexed ? "*" : " "} ${x.name}${x.date ? `  (${x.date})` : ""}`);
  return text(`${r.data.matched}/${r.data.total} branches match (* = indexed)\n${lines.join("\n")}`);
});

srv.registerTool("switch_branch", {
  description: "Select a branch for this workspace. Returns immediately when a distributed build is queued.",
  inputSchema: { repo: z.string().optional(), branch: z.string() },
}, async ({ repo, branch }) => {
  const id = ++latestSwitch;
  const target = repo ?? selectedRepo;
  pendingSwitches.set(target, id);
  const r = await api("POST", "/api/switch", { repo: target, branch }, { timeoutMs: 40_000, retries: 0 });
  if (!r.data.ok) return text(errText(r), true);
  const actualRepo = r.data.repo ?? target;
  if (pendingSwitches.get(target) === id && (pendingSwitches.get(actualRepo) ?? 0) <= id) {
    contexts.set(actualRepo, { workspace: r.data.workspace, branch });
    pendingSwitches.set(actualRepo, id);
  }
  if (id === latestSwitch) selectedRepo = actualRepo;
  return text(`${location({ ...r.data, branch })} status=${r.data.status}${r.data.workspace ? `\nworkspace=${r.data.workspace}` : ""}`);
});

srv.registerTool("reindex", {
  description: "Refresh the selected branch to its latest commit.",
  inputSchema: scopeSchema,
}, async ({ repo, branch, workspace }) => {
  const r = await scopedApi("/api/reindex", scope(repo, branch, workspace));
  if (r.status === 202 || r.data.status === "indexing") return pendingResult(r);
  return r.data.ok ? text(`${location(r.data)} indexed`) : text(errText(r), true);
});

srv.registerTool("diff_symbols", {
  description: "Changed methods, functions and classes between indexed base and head.",
  inputSchema: { ...scopeSchema, head: z.string().optional(), base: z.string().optional() },
}, async ({ repo, branch, workspace, head, base }) => {
  const opts = scope(repo, head ?? branch, workspace);
  const r = await scopedApi("/api/diff", { ...opts, head: opts.branch, base }, { timeoutMs: 120_000 });
  if (r.status === 202 || r.data.status === "indexing") return pendingResult(r);
  if (!r.data.ok) return text(errText(r), true);
  return text(`repo=${r.data.repo} base=${r.data.base}@${r.data.baseRevision} head=${r.data.head}@${r.data.headRevision}\n${r.data.text}`);
});

srv.registerTool("login", {
  description: "Sign in to crm-index with your Zoho account (opens a browser). Use when tools say you are not signed in, or to switch accounts.",
  inputSchema: {},
}, async () => {
  clearSession();
  contexts.clear(); pendingSwitches.clear(); ++latestSwitch; selectedRepo = REPO;
  const login = startLogin(await discoverLoginPath());
  const done = await Promise.race([login.then(() => true, () => false), new Promise((res) => setTimeout(() => res(false), 50_000))]);
  if (!done) return text(`Finish signing in in the browser${lastLoginUrl ? ` (${lastLoginUrl})` : ""}, then run any crm-index tool.`);
  return text(`Signed in as ${loadSession()?.email ?? "?"}.`);
});

srv.registerTool("index_status", {
  description: "Index health: indexed branches, symbol counts, running jobs, and this session's active branch.",
  inputSchema: scopeSchema,
}, async ({ repo, branch, workspace }) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(scope(repo, branch, workspace))) if (value !== undefined) qs.set(key, value);
  const r = await api("GET", `/api/status?${qs}`);
  if (!r.data.ok) return text(errText(r), true);
  const who = await rawApi("GET", "/api/whoami");
  const lines = [`signed in as: ${who.data?.user ?? "?"}`, r.data.active ? location(r.data.active) : `active branch: ${branch ?? contexts.get(repo ?? selectedRepo)?.branch ?? "master"}`];
  for (const x of r.data.repos) lines.push(`[${x.repo}] symbols=${x.symbols} refs: ${x.refs.map((f) => `${f.ref}(${f.files})`).join(", ") || "none"}`);
  if (r.data.jobs?.length) lines.push(`jobs: ${r.data.jobs.map((j) => `${j.ref}=${j.state}${j.error ? `(${j.error.slice(0, 80)})` : ""}`).join(", ")}`);
  return text(lines.join("\n"));
});

await srv.connect(new StdioServerTransport());
