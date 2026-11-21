// AppSail entry. Listens on the public port immediately and reports its own state, so a failed boot is
// visible over HTTP (GET /health shows the stage and error) even when platform logs are not.
// Stage 1: unpack deps.tgz. Stage 2: start the MCP server on an internal port and proxy to it.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PUBLIC = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT ?? process.env.PORT ?? 9000);
const INTERNAL = PUBLIC + 1000;
const state = { stage: "starting", error: null, tail: [] };
const note = (line) => { state.tail.push(String(line).slice(0, 300)); if (state.tail.length > 60) state.tail.shift(); console.log(line); };

function proxy(req, res) {
  if (state.stage !== "running") {
    if (req.url?.startsWith("/health")) {
      res.writeHead(503, { "content-type": "application/json" });
      const rd = (f) => { try { return readFileSync(f, "utf8").slice(0, 600); } catch { return null; } };
      res.end(JSON.stringify({ stage: state.stage, error: state.error, tail: state.tail, mirror: rd("/tmp/crm-index/mirror.status"), gitErr: rd("/tmp/crm-index/clone.err") }, null, 1));
    } else res.writeHead(503).end(`starting: ${state.stage}`);
    return;
  }
  const up = http.request({ host: "127.0.0.1", port: INTERNAL, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502).end(`upstream: ${e.message}`); });
  req.pipe(up);
}
http.createServer(proxy).listen(PUBLIC, () => note(`[bootstrap] listening on ${PUBLIC}`));

// stage 1: dependencies
if (!existsSync("node_modules/tsx") && existsSync("deps.tgz")) {
  state.stage = "unpacking";
  const r = spawnSync("tar", ["xzf", "deps.tgz"], { encoding: "utf8" });
  note(`[deps] tar status=${r.status} ${r.error ? r.error.message : ""} ${(r.stderr || "").slice(0, 200)}`);
  if (r.status !== 0) { state.stage = "failed"; state.error = `unpack failed: ${r.error?.message ?? r.stderr}`; }
}
if (state.stage !== "failed") {
  // stage 2: the MCP server (its own env: PORT=internal)
  state.stage = "server-starting";
  const env = { ...process.env, PORT: String(INTERNAL), X_ZOHO_CATALYST_LISTEN_PORT: String(INTERNAL), DATA_DIR: process.env.DATA_DIR ?? "/tmp/crm-index/data", REPO_NAME: process.env.REPO_NAME ?? "zohocrm" };
  env.MIRROR_DIR = process.env.MIRROR_DIR ?? "/tmp/crm-index/mirror/zohocrm.git";
  env.REPOS = process.env.REPOS ?? `zohocrm=${env.MIRROR_DIR}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach(note));
  child.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach(note));
  child.on("exit", (code) => { state.stage = "failed"; state.error = `server exited with code ${code}`; note(`[server] exit ${code}`); });
  const ready = setInterval(async () => {
    try { const r = await fetch(`http://127.0.0.1:${INTERNAL}/health`); if (r.ok) { state.stage = "running"; clearInterval(ready); note("[bootstrap] server ready"); } } catch {}
  }, 1000);
}
