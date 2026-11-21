import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const enabledAtDeploy = existsSync(new URL("../deploy/branch-pool-enabled", import.meta.url));
export function poolEnabled(): boolean {
  return process.env.INDEX_BUILD_POOL === undefined ? enabledAtDeploy : process.env.INDEX_BUILD_POOL === "1";
}

export async function brokerCall<T>(action: string, fields: Record<string, unknown>): Promise<T> {
  const url = process.env.INDEX_JOB_URL || process.env.SNAPSHOT_URL?.replace("/crm_index_snapshot/", "/crm_index_jobs/");
  const key = process.env.SNAPSHOT_KEY;
  if (!url || !key) throw new Error("branch build broker is not configured");
  const body = JSON.stringify({ ...fields, action });
  const ts = String(Date.now());
  const mac = createHmac("sha256", key).update(ts + "." + body).digest("base64url");
  const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "x-index-auth": ts + "." + mac }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error("branch broker " + action + " returned HTTP " + r.status);
  const result = await r.json() as T & { ok: boolean; error?: string };
  if (!result.ok) throw new Error(result.error || "branch broker rejected " + action);
  return result;
}

export async function ensureGitRevision(repo: string, sha: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid pinned commit");
  try { await run("git", ["-C", repo, "cat-file", "-e", sha + "^{commit}"]); }
  catch { await run("git", ["-C", repo, "fetch", "--no-tags", "--no-write-fetch-head", "origin", sha]); }
}
