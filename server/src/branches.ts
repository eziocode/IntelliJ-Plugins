import type { Db } from "./db.js";
import { git } from "./git.js";
import { gitRefOf } from "./diff.js";
import { enforceBudget, sweepIdle, touchRef } from "./evict.js";
import { pruneRemoteRef } from "./git.js";

/** Index size budget (MiB of used SQLite pages). Least-recently-used branches are dropped beyond it. */
export const BUDGET_BYTES = Number(process.env.INDEX_BUDGET_MB ?? 500) * 1048576;
/** Also delete the mirror blobs of dropped branches (git gc). Off by default: gc is slow on a big mirror. */
export const PRUNE_MIRROR = process.env.PRUNE_MIRROR === "1";
export const evictionLog: string[] = [];
/** Branches idle longer than this are flushed (default 48 h). Base branch is never flushed. */
export const IDLE_TTL_MS = Number(process.env.IDLE_TTL_HOURS ?? 48) * 3600_000;

/** Flush idle branches (and their mirror refs when PRUNE_MIRROR=1). Called on a timer by the server. */
export function flushIdle(db: Db, repo: string, now = Date.now()): string[] {
  const dropped = sweepIdle(db, IDLE_TTL_MS, new Set(), BASE, now);
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

let lsRemoteCache: { at: number; names: Map<string, string> } | null = null;

/** Branch names + last commit date. Remote listing is cached; local refs are the fallback. */
export function listBranches(db: Db, repo: string, contains = "", limit = 25, useRemote = process.env.REMOTE_LIST === "1"): { total: number; matched: number; branches: BranchInfo[] } {
  let all: { name: string; date: string }[];
  if (useRemote) {
    if (!lsRemoteCache || Date.now() - lsRemoteCache.at > 60_000) {
      const out = git(repo, ["ls-remote", "--heads", "origin"]);
      const names = new Map<string, string>();
      for (const l of out.split("\n")) { const m = /\trefs\/heads\/(.+)$/.exec(l); if (m) names.set(m[1], ""); }
      lsRemoteCache = { at: Date.now(), names };
    }
    all = [...lsRemoteCache.names.keys()].map((name) => ({ name, date: "" }));
  } else {
    const out = git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:lstrip=3)|%(committerdate:short)", "refs/remotes/origin"]);
    all = out.split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf("|"); return { name: l.slice(0, i), date: l.slice(i + 1) }; }).filter((b) => b.name !== "HEAD");
  }
  const needle = contains.toLowerCase();
  const matched = needle ? all.filter((b) => b.name.toLowerCase().includes(needle)) : all;
  const indexed = new Set((db.prepare("SELECT r.name AS ref FROM refs r WHERE EXISTS (SELECT 1 FROM manifest m WHERE m.ref_id = r.id)").all() as { ref: string }[]).map((r) => r.ref));
  return { total: all.length, matched: matched.length, branches: matched.slice(0, limit).map((b) => ({ ...b, indexed: indexed.has(b.name) })) };
}

export function isIndexed(db: Db, ref: string): boolean {
  return !!db.prepare("SELECT 1 FROM manifest m JOIN refs r ON r.id = m.ref_id WHERE r.name = ? LIMIT 1").get(ref);
}

type Job = { ref: string; state: "queued" | "running" | "done" | "error"; startedAt: number; report?: IndexReport; error?: string; promise: Promise<void> };
const jobs = new Map<string, Job>();
let queue: Promise<unknown> = Promise.resolve(); // single writer: one index job at a time

const jkey = (repo: string, ref: string) => `${repo}|${ref}`;

export function isIndexing(repo: string, ref: string): boolean {
  const j = jobs.get(jkey(repo, ref));
  return !!j && (j.state === "queued" || j.state === "running");
}

export function jobStatus(): Omit<Job, "promise">[] {
  return [...jobs.values()].map(({ promise: _p, ...j }) => j);
}

/** Fetch just this branch (never all 17k) and index its manifest; blobs already known are reused. Dedupes concurrent calls per ref. */
export function ensureIndexed(db: Db, repo: string, branch: string, opts: { refresh?: boolean; fetch?: boolean } = {}): Job {
  const running = jobs.get(jkey(repo, branch));
  if (running && (running.state === "queued" || running.state === "running")) return running;
  const job: Job = { ref: branch, state: "queued", startedAt: Date.now(), promise: Promise.resolve() };
  const p: Promise<void> = queue.then(async () => {
    job.state = "running";
    try {
      if (branch.startsWith("commit:")) {
        const sha = branch.slice(7);
        try { git(repo, ["cat-file", "-e", `${sha}^{commit}`]); } catch { git(repo, ["fetch", "--no-tags", "--quiet", "origin", sha]); }
      } else if (opts.fetch !== false && (opts.refresh || !isIndexed(db, branch))) {
        git(repo, ["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      }
      job.report = await indexRef(db, repo, gitRefOf(branch), undefined, branch);
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
    }
  });
  queue = p;
  job.promise = p;
  jobs.set(jkey(repo, branch), job);
  return job;
}

/** Wait up to ms for a job; resolves either way so tools can answer "still indexing". */
export async function waitFor(job: Job, ms: number): Promise<boolean> {
  await Promise.race([job.promise, new Promise((r) => setTimeout(r, ms))]);
  return job.state === "done" || job.state === "error";
}

/** Index (if needed) and wait for completion. Throws on failure. */
export async function ensureReady(db: Db, repo: string, label: string): Promise<void> {
  if (isIndexed(db, label) && !isIndexing(repo, label)) return;
  const job = ensureIndexed(db, repo, label);
  await job.promise;
  if (job.state === "error") throw new Error(`could not index ${label}: ${job.error}`);
}
