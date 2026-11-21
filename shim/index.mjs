#!/usr/bin/env node
// crm-index shim: a local stdio MCP server. The AI client talks MCP to this process;
// this process calls the central index over plain HTTPS JSON (no MCP sessions cross the cloud gateway).
//   CRM_INDEX_URL    base URL of the index, e.g. https://crmindex-xxxx.development.catalystappsail.in
//   CRM_INDEX_TOKEN  bearer token for the index API
//   CRM_INDEX_REPO   optional default repo (server default otherwise)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.CRM_INDEX_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.CRM_INDEX_TOKEN ?? "";
const REPO = process.env.CRM_INDEX_REPO || undefined;
if (!BASE || !TOKEN) {
  console.error("crm-index-shim: set CRM_INDEX_URL and CRM_INDEX_TOKEN");
  process.exit(1);
}

// The active branch lives here, in the user's own process, so the server stays stateless per request.
let activeBranch = "master";

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function api(method, path, body, { timeoutMs = 60_000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
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

const errText = (r) => {
  if (r.status === 401) return "crm-index: unauthorized. Check CRM_INDEX_TOKEN.";
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

srv.registerTool("index_status", {
  description: "Index health: indexed branches, symbol counts, running jobs, and this session's active branch.",
  inputSchema: {},
}, async () => {
  const r = await api("GET", "/api/status");
  if (!r.data.ok) return text(errText(r), true);
  const lines = [`active branch (this session): ${activeBranch}`];
  for (const x of r.data.repos) lines.push(`[${x.repo}] symbols=${x.symbols} refs: ${x.refs.map((f) => `${f.ref}(${f.files})`).join(", ") || "none"}`);
  if (r.data.jobs?.length) lines.push(`jobs: ${r.data.jobs.map((j) => `${j.ref}=${j.state}${j.error ? `(${j.error.slice(0, 80)})` : ""}`).join(", ")}`);
  return text(lines.join("\n"));
});

await srv.connect(new StdioServerTransport());
