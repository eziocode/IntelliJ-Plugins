import { execFileSync, spawn } from "node:child_process";

export interface TreeEntry { path: string; blob: string; size?: number }

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 30, env: GIT_ENV });
}

/** path -> blob sha for every file in ref. No blob fetch needed (blobless-safe). */
export function lsTree(repo: string, ref: string): TreeEntry[] {
  const out = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", ref], { maxBuffer: 1 << 30, env: GIT_ENV });
  const res: TreeEntry[] = [];
  for (const rec of out.toString("utf8").split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [, type, sha] = rec.slice(0, tab).split(" ");
    if (type === "blob") res.push({ path: rec.slice(tab + 1), blob: sha });
  }
  return res;
}

/** Stream blob contents via one `git cat-file --batch` process per call. Missing blobs yield null. */
export async function readBlobs(repo: string, shas: string[]): Promise<Map<string, Buffer | null>> {
  const result = new Map<string, Buffer | null>();
  if (!shas.length) return result;
  const p = spawn("git", ["-C", repo, "cat-file", "--batch"], { env: GIT_ENV, stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  p.stdout.on("data", (d: Buffer) => chunks.push(d));
  p.stdin.end(shas.join("\n") + "\n");
  await new Promise<void>((res, rej) => { p.on("close", () => res()); p.on("error", rej); });
  const buf = Buffer.concat(chunks);
  let pos = 0;
  for (const sha of shas) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) { result.set(sha, null); continue; }
    const header = buf.toString("utf8", pos, nl);
    pos = nl + 1;
    if (header.endsWith(" missing")) { result.set(sha, null); continue; }
    const size = Number(header.split(" ")[2]);
    result.set(sha, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return result;
}

/** Which of these blobs are not in the local object store (never triggers a lazy fetch). */
export function missingBlobs(repo: string, shas: string[]): string[] {
  if (!shas.length) return [];
  const out = execFileSync("git", ["-C", repo, "cat-file", "--batch-check"], { input: shas.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28, env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" } });
  const miss: string[] = [];
  out.split("\n").forEach((l) => { if (l.endsWith(" missing")) miss.push(l.split(" ")[0]); });
  return miss;
}

/** Fetch many blobs in a few round trips (promisor remote, by object id). Falls back silently: cat-file will lazy-fetch the rest. */
export async function prefetchBlobs(repo: string, shas: string[], chunk = 2000): Promise<{ requested: number; ok: boolean }> {
  const miss = missingBlobs(repo, shas);
  let ok = true;
  for (let i = 0; i < miss.length; i += chunk) {
    const part = miss.slice(i, i + chunk);
    await new Promise<void>((res) => {
      const p = spawn("git", ["-C", repo, "-c", "fetch.negotiationAlgorithm=noop", "fetch", "origin", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"], { env: GIT_ENV, stdio: ["pipe", "ignore", "ignore"] });
      p.on("close", (code) => { if (code !== 0) ok = false; res(); });
      p.on("error", () => { ok = false; res(); });
      p.stdin.end(part.join("\n") + "\n");
    });
  }
  return { requested: miss.length, ok };
}

/** Drop a branch's remote-tracking ref and let git prune the blobs only it needed (partial clone: they are re-fetchable). */
export function pruneRemoteRef(repo: string, branch: string): { removed: boolean; gcMs: number } {
  const ref = `refs/remotes/origin/${branch}`;
  if (branch === "master") return { removed: false, gcMs: 0 };
  try { execFileSync("git", ["-C", repo, "update-ref", "-d", ref], { env: GIT_ENV }); } catch { return { removed: false, gcMs: 0 }; }
  const t0 = Date.now();
  execFileSync("git", ["-C", repo, "reflog", "expire", "--expire=now", "--all"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "gc", "--prune=now", "--quiet"], { env: GIT_ENV, maxBuffer: 1 << 26 });
  return { removed: true, gcMs: Date.now() - t0 };
}
