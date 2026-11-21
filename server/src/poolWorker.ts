import { workerData, parentPort } from "node:worker_threads";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openDb } from "./db.js";
import { git } from "./git.js";
import { baseIdentity, exportBranchInput, stageBranchArtifact, promoteBranchArtifact, discardBranchArtifact } from "./indexer.js";
import { brokerCall, ensureGitRevision } from "./buildBroker.js";

interface State {
  state: "missing" | "preparing" | "queued" | "running" | "failed" | "ready";
  startedAt?: number; finishedAt?: number; ticket?: string; uploadUrl?: string; downloadUrl?: string; sha256?: string; error?: string;
}
const { dbFile, repo, name, ref, generation, refresh, marker } = workerData as {
  dbFile: string; repo: string; name: string; ref: string; generation: string; refresh: boolean; marker:string;
};
const db = openDb(dbFile);
const temp = await mkdtemp(join(tmpdir(), "crm-index-job-"));
const input = join(temp, "input.gz");
const output = join(temp, "output.gz");
function stillWanted() {
  if (readFileSync(marker,"utf8") !== generation) throw new Error("branch request superseded");
}

function resolveCommit() {
  if (ref.startsWith("commit:")) {
    const id = ref.slice(7);
    if (!/^[0-9a-f]{7,40}$/i.test(id)) throw new Error("invalid commit");
    try { return git(repo, ["rev-parse", "--verify", id + "^{commit}"]).trim(); }
    catch { git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", id]); }
    return git(repo, ["rev-parse", "--verify", id + "^{commit}"]).trim();
  }
  git(repo, ["check-ref-format", "refs/heads/" + ref]);
  // Use a private ref so simultaneous refreshes cannot change the SHA we capture.
  const fetched = "refs/crm-index/fetch/" + generation;
  try {
    git(repo, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", "--filter=blob:none", "origin", "+refs/heads/" + ref + ":" + fetched]);
    return git(repo, ["rev-parse", "--verify", fetched + "^{commit}"]).trim();
  } finally { git(repo, ["update-ref", "-d", fetched]); }
}

let installing = false;
function releaseInstall() {
  if (installing) parentPort!.postMessage({ releaseInstall: true });
  installing = false;
}

async function build(revision: string, baseRevision: string) {
  const identity = { repo: name, branch: ref, revision, version: 1, baseRevision };
  const deadline = Date.now() + 22 * 60_000;
  let state = await brokerCall<State>("prepare", identity);
  let attempts = 0;
  while (state.state !== "ready") {
    stillWanted();
    if (Date.now() > deadline) throw new Error("timed out waiting for Catalyst index job");
    parentPort!.postMessage({ phase: state.state, revision });
    if (state.ticket && state.uploadUrl) {
      await ensureGitRevision(repo,revision);
      await rm(input, {force:true});
      await exportBranchInput(db, repo, revision, input, identity.baseRevision);
      const bytes = (await stat(input)).size;
      const put = await fetch(state.uploadUrl, { method: "PUT",
        headers: { "content-length": String(bytes), "content-type": "application/gzip", overwrite: "true" },
        body: Readable.toWeb(createReadStream(input)), duplex: "half", signal: AbortSignal.timeout(180_000) } as RequestInit);
      if (!put.ok) throw new Error("Stratus build input upload returned HTTP " + put.status);
      await rm(input, { force: true });
      state = await brokerCall<State>("submit", { ...identity, ticket: state.ticket });
      attempts++;
    } else if (state.state === "failed" || state.state === "missing") {
      if (attempts >= 3 && state.state === "failed") throw new Error(state.error || "Catalyst index job failed");
      state = await brokerCall<State>("prepare", identity);
    } else {
      await delay(1200);
      state = await brokerCall<State>("status", identity);
    }
  }
  if (!state.downloadUrl || !state.sha256) throw new Error("incomplete artifact metadata");
  // Parallel processing happens in Catalyst. Serialize large downloads and SQLite
  // publication on this replica to bound temporary disk and WAL pressure.
  parentPort!.postMessage({phase:"publishing", revision, startedAt:state.startedAt, finishedAt:state.finishedAt});
  parentPort!.postMessage({installPermit:true});
  await new Promise<void>(resolve=>parentPort!.once("message",resolve));
  installing = true;
  try {
    const get = await fetch(state.downloadUrl, { signal: AbortSignal.timeout(180_000) });
    if (!get.ok || !get.body) throw new Error("Stratus artifact download returned HTTP " + get.status);
    await pipeline(Readable.fromWeb(get.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(output));
    return await stageBranchArtifact(db, generation, revision, output, state.sha256, stillWanted);
  } catch (error) {
    releaseInstall();
    throw error;
  } finally {
    await rm(output, {force:true});
  }
}

try {
  const fields = {repo:name, branch:ref, generation};
  type Head = {revision:string; baseRevision:string};
  const stored = refresh ? null : (await brokerCall<{head:Head|null}>("readHead", fields)).head;
  if (!stored) await brokerCall("beginHead", fields);
  let revision = stored?.revision ?? resolveCommit();
  let base = stored?.baseRevision ?? baseIdentity(db);
  let publish = !stored;
  for (;;) {
    stillWanted();
    parentPort!.postMessage({ phase: "resolved", revision });
    let report: Awaited<ReturnType<typeof build>>;
    try { report = await build(revision, base); }
    catch (error) {
      const current = baseIdentity(db);
      if (current === base || !/absent base blob|Base snapshot changed/.test((error as Error).message)) throw error;
      base = current;
      await ensureGitRevision(repo, revision);
      continue;
    }
    stillWanted();
    const {head} = publish
      ? await brokerCall<{head:Head}>("publishHead", {...fields,revision,baseRevision:base})
      : await brokerCall<{head:Head}>("readHead", fields);
    if (head.revision === revision) {
      promoteBranchArtifact(db,ref,generation,revision,stillWanted);
      parentPort!.postMessage({ ok: {...report,ref} });
      break;
    }
    discardBranchArtifact(db,generation);
    releaseInstall();
    revision = head.revision;
    base = head.baseRevision;
    publish = false;
  }
} catch (e) {
  parentPort!.postMessage({ error: String((e as Error).message).split("\n")[0] });
} finally {
  try { discardBranchArtifact(db,generation); } finally { db.close(); releaseInstall(); }
  await rm(temp, { recursive: true, force: true });
}
