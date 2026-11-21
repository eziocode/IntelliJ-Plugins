import type { Db } from "./db.js";
import { git } from "./git.js";
import { gitRefOf } from "./diff.js";
import { enforceBudget, persistTouches, sweepIdle, touchRef } from "./evict.js";
import { pruneRemoteRef } from "./git.js";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { brokerCall, poolEnabled } from "./buildBroker.js";
import { execFileSync } from "node:child_process";
import { indexInWorker } from "./indexPool.js";

/** Index size budget (MiB of used SQLite pages). Least-recently-used branches are dropped beyond it. */
export const BUDGET_BYTES = Number(process.env.INDEX_BUDGET_MB ?? 500) * 1048576;
/** Also delete the mirror blobs of dropped branches (git gc). Off by default: gc is slow on a big mirror. */
export const PRUNE_MIRROR = process.env.PRUNE_MIRROR === "1";
export const evictionLog: string[] = [];
/** Branches idle longer than this are flushed (default 48 h). Base branch is never flushed. */
export const IDLE_TTL_MS = Number(process.env.IDLE_TTL_HOURS ?? 48) * 3600_000;

/** Flush idle branches (and their mirror refs when PRUNE_MIRROR=1). Called on a timer by the server. */
export function flushIdle(db: Db, repo: string, now = Date.now()): string[] {
  if (poolEnabled() && pending > 0) return [];
  const dropped = sweepIdle(db, IDLE_TTL_MS, protectedBranches(db, repo), BASE, now);
  for (const d of dropped) {
    let note = `flushed idle ${d}`;
    if (PRUNE_MIRROR && !d.startsWith("commit:")) { const r = pruneRemoteRef(repo, d); if (r.removed) note += ` (mirror pruned ${r.gcMs}ms)`; }
    evictionLog.push(note);
  }
  return dropped;
}
import { indexRef, type IndexReport } from "./indexer.js";

export const BASE = "master";

export interface BranchInfo { name: string; date: string; indexed: boolean }

const remoteBranches = new Map<string, { at: number; names: Map<string, string> }>();

/** Branch names + last commit date. Remote listing is cached; local refs are the fallback. */
export function listBranches(db: Db, repo: string, contains = "", limit = 25, useRemote = process.env.REMOTE_LIST === "1"): { total: number; matched: number; branches: BranchInfo[] } {
  let all: { name: string; date: string }[];
  if (useRemote) {
    let lsRemoteCache = remoteBranches.get(repo);
    if (!lsRemoteCache || Date.now() - lsRemoteCache.at > 60_000) {
      const out = git(repo, ["ls-remote", "--heads", "origin"]);
      const names = new Map<string, string>();
      for (const l of out.split("\n")) { const m = /\trefs\/heads\/(.+)$/.exec(l); if (m) names.set(m[1], ""); }
      lsRemoteCache = { at: Date.now(), names };
      remoteBranches.set(repo,lsRemoteCache);
    }
    all = [...lsRemoteCache.names.keys()].map((name) => ({ name, date: "" }));
  } else {
    const out = git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:lstrip=3)|%(committerdate:short)", "refs/remotes/origin"]);
    all = out.split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf("|"); return { name: l.slice(0, i), date: l.slice(i + 1) }; }).filter((b) => b.name !== "HEAD");
  }
  const needle = contains.toLowerCase();
  const matched = needle ? all.filter((b) => b.name.toLowerCase().includes(needle)) : all;
  const indexed = new Set((db.prepare("SELECT r.name AS ref FROM refs r WHERE r.name NOT GLOB ':stage:*' AND EXISTS (SELECT 1 FROM manifest m WHERE m.ref_id = r.id)").all() as { ref: string }[]).map((r) => r.ref));
  return { total: all.length, matched: matched.length, branches: matched.slice(0, limit).map((b) => ({ ...b, indexed: indexed.has(b.name) })) };
}

export function isIndexed(db: Db, ref: string): boolean {
  return !!db.prepare("SELECT 1 FROM manifest m JOIN refs r ON r.id = m.ref_id WHERE r.name = ? LIMIT 1").get(ref);
}

export function revision(db: Db, branch: string): string | null {
  const row = db.prepare("SELECT v FROM meta WHERE k=?").get("revision:" + branch) as { v: string } | undefined;
  return row?.v ?? null;
}

type Job = { ref: string; repo: string; phase?: string; revision?: string; workerStartedAt?: number; workerFinishedAt?: number; state: "waiting" | "queued" | "running" | "done" | "error"; startedAt: number; report?: IndexReport; error?: string; progress?: { done: number; total: number }; promise: Promise<void> };
const jobs = new Map<string, Job>();
let queue: Promise<unknown> = Promise.resolve(); // single writer: one index job at a time

// Capacity: at most MAX_PENDING builds in flight (running + queued). Beyond that, new requests WAIT (state "waiting")
// until a slot frees; they never fail. Shown in index_status so people can see the line.
export const MAX_PENDING = Math.max(1, Number(process.env.INDEX_MAX_PENDING ?? 5));
let pending = 0;
export const capacity = () => ({ pending, max: MAX_PENDING, waiting: [...jobs.values()].filter((j) => j.state === "waiting").length });

const jkey = (repo: string, ref: string) => `${repo}|${ref}`;

export function isIndexing(repo: string, ref: string): boolean {
  const j = jobs.get(jkey(repo, ref));
  return !!j && (j.state === "waiting" || j.state === "queued" || j.state === "running");
}

export function jobStatus(): Omit<Job, "promise">[] {
  return [...jobs.values()].map(({ promise: _p, ...j }) => j);
}

/** Fetch just this branch (never all 17k) and index its manifest; blobs already known are reused. Dedupes concurrent calls per ref. */
export function ensureIndexed(db: Db, repo: string, branch: string, opts: { refresh?: boolean; fetch?: boolean } = {}): Job {
  if (poolEnabled()) return ensurePoolIndex(db, repo, branch, !!opts.refresh);
  const running = jobs.get(jkey(repo, branch));
  if (running && (running.state === "waiting" || running.state === "queued" || running.state === "running")) return running;
  const job: Job = { repo: basename(db.name, ".sqlite"), ref: branch, state: pending >= MAX_PENDING ? "waiting" : "queued", startedAt: Date.now(), promise: Promise.resolve() };
  // reserve a slot now (or when one frees), then run in order behind the single writer
  const admitted: Promise<void> = (async () => {
    while (pending >= MAX_PENDING) await new Promise((r) => setTimeout(r, 1000));
    pending++;
    job.state = "queued";
  })();
  const p: Promise<void> = Promise.all([queue, admitted]).then(async () => {
    job.state = "running";
    try {
      // fetch + index run in the worker thread (git fetch is blocking); the main thread only queues and reports
      let fetchArgs: string[] | undefined;
      if (branch.startsWith("commit:")) {
        const sha = branch.slice(7);
        const have = (() => { try { execFileSync("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; } })();
        if (!have) fetchArgs = ["fetch", "--no-tags", "--quiet", "origin", sha];
      } else if (opts.fetch !== false && (opts.refresh || !isIndexed(db, branch))) {
        fetchArgs = ["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
      }
      job.report = await indexInWorker(db, repo, gitRefOf(branch), branch, (p) => { job.progress = p; }, fetchArgs);
      job.state = "done";
      touchRef(db, branch);
      for (const d of enforceBudget(db, BUDGET_BYTES, new Set([branch]), BASE)) {
        let note = `evicted ${d} (over ${process.env.INDEX_BUDGET_MB ?? 500} MiB)`;
        if (PRUNE_MIRROR && !d.startsWith("commit:")) { const r = pruneRemoteRef(repo, d); note += r.removed ? `, mirror pruned in ${r.gcMs}ms` : ""; }
        evictionLog.push(note);
      }
    } catch (e) {
      job.state = "error";
      job.error = (e as Error).message.split("\n")[0];
    } finally {
      pending--;
    }
  });
  queue = p;
  job.promise = p;
  jobs.set(jkey(repo, branch), job);
  return job;
}

// Pool workers prepare private inputs and install only completed artifacts. The
// existing serial queue remains available when the Development flag is off.
const waiting: Array<() => void> = [];
let publications: Promise<void> = Promise.resolve();
let generationDirectory: string | undefined;


function releasePoolSlot() {
  const next = waiting.shift();
  if (next) next();
  else pending--;
}

function ensurePoolIndex(db: Db, repo: string, branch: string, refresh: boolean): Job {
  const key = jkey(repo, branch);
  const prior = jobs.get(key);
  if (prior && isIndexing(repo, branch) && !refresh) return prior;
  const generation = randomUUID();
  const name = basename(db.name, ".sqlite");
  generationDirectory ??= mkdtempSync(join(tmpdir(), "crm-index-generations-"));
  const marker = join(generationDirectory,createHash("sha256").update(key).digest("hex"));
  writeFileSync(marker + ".next",generation,{mode:0o600});
  renameSync(marker + ".next",marker);
  const job: Job = { ref: branch, repo: name, state: "waiting", startedAt: Date.now(), promise: Promise.resolve() };
  jobs.set(key, job);
  job.promise = (async () => {
    if (pending >= MAX_PENDING) await new Promise<void>(resolve => waiting.push(resolve));
    else pending++;
    try {
      if (jobs.get(key) !== job) throw new Error("branch request superseded");
      job.state = "running";
      job.report = await new Promise<IndexReport>((resolve, reject) => {
        const worker = new Worker(new URL("./poolWorker.ts", import.meta.url), {
          workerData: { dbFile: db.name, repo, name, ref: branch, generation, refresh, marker }, execArgv: ["--import", "tsx"]
        });
        let unlock: (() => void) | undefined;
        let exited = false;
        worker.once("exit", () => { exited = true; unlock?.(); });
        worker.on("message", message => {
          if (message.installPermit) {
            const previous = publications;
            const released = new Promise<void>(resolve => { unlock = resolve; });
            publications = previous.then(() => released);
            void previous.then(() => { if (!exited) worker.postMessage("install"); });
            return;
          }
          if (message.releaseInstall) { unlock?.(); unlock = undefined; return; }
          if (message.ok) resolve(message.ok);
          else if (message.error) reject(new Error(message.error));
          else {
            job.phase = message.phase;
            job.revision = message.revision;
            if (message.startedAt) job.workerStartedAt = message.startedAt;
            if (message.finishedAt) job.workerFinishedAt = message.finishedAt;
          }
        });
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error("index worker exited with code " + code)));
      });
      job.state = "done";
      touchRef(db, branch);
      // Keep foreground readers out of a write transaction while another artifact installs.
      if (pending > 1) return;
      const keep = protectedBranches(db, repo);
      keep.add(branch);
      for (const ref of enforceBudget(db, BUDGET_BYTES, keep, BASE)) evictionLog.push("evicted " + ref);
    } catch (err) {
      job.state = "error";
      job.error = (err as Error).message;
    } finally { releasePoolSlot(); }
  })();
  return job;
}

// Preserve the five most recently used resident branches as well as builds in flight.
function protectedBranches(db: Db, repo: string): Set<string> {
  const keep = new Set<string>();
  if (!poolEnabled()) return keep;
  persistTouches(db);
  const rows = db.prepare("SELECT r.name FROM refs r JOIN meta m ON m.k='used:' || r.name WHERE r.name<>? AND CAST(m.v AS INTEGER)>? ORDER BY CAST(m.v AS INTEGER) DESC LIMIT 5").all(BASE, Date.now() - IDLE_TTL_MS) as { name: string }[];
  for (const row of rows) keep.add(row.name);
  for (const job of jobs.values()) if (isIndexing(repo, job.ref)) keep.add(job.ref);
  return keep;
}

/** Wait up to ms for a job; resolves either way so tools can answer "still indexing". */
export async function waitFor(job: Job, ms: number): Promise<boolean> {
  await Promise.race([job.promise, new Promise((r) => setTimeout(r, ms))]);
  return job.state === "done" || job.state === "error";
}

/** Index (if needed) and wait for completion. Throws on failure. */
export async function ensureReady(db: Db, repo: string, label: string): Promise<void> {
  if (isIndexed(db, label) && (poolEnabled() ? !!revision(db, label) : !isIndexing(repo, label))) return;
  const job = ensureIndexed(db, repo, label);
  await job.promise;
  if (job.state === "error") throw new Error(`could not index ${label}: ${job.error}`);
}

/** Check a cached view against the durable branch head when serving multiple replicas. */
export async function reconcileBranch(db: Db, repo: string, branch: string) {
  if (!poolEnabled() || isIndexing(repo,branch)) return;
  const local = revision(db,branch);
  if (!local) return;
  let published: {head:{revision:string}|null};
  try {
    published = await brokerCall("readHead", { repo:basename(db.name,".sqlite"), branch });
  } catch {
    // A reader can keep serving its last committed revision during a broker outage.
    return;
  }
  if (published.head && published.head.revision !== local) return ensureIndexed(db,repo,branch);
}
