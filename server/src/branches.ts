import type { Db } from "./db.js";
import { git } from "./git.js";
import { gitRefOf } from "./diff.js";
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
  const indexed = new Set((db.prepare("SELECT DISTINCT ref FROM manifest").all() as { ref: string }[]).map((r) => r.ref));
  return { total: all.length, matched: matched.length, branches: matched.slice(0, limit).map((b) => ({ ...b, indexed: indexed.has(b.name) })) };
}

export function isIndexed(db: Db, ref: string): boolean {
  return !!db.prepare("SELECT 1 FROM manifest WHERE ref=? LIMIT 1").get(ref);
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
