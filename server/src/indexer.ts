import type { Db } from "./db.js";
import { packBody, packText, refId } from "./db.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { Gunzip } from "fflate";
import { setTimeout as delay } from "node:timers/promises";
import { BRANCH_ARTIFACT_VERSION, checkEntry, checkSource, manifestRecord, readHeader, requireObjectId,
  writeCompressed, type FileEntry, type Header, type Parsed, type Source } from "./branchArtifact.js";
import { git, lsTree, prefetchBlobs, readBlobs } from "./git.js";
import { chunk, initChunker, isSkippable, langOf, MAX_BYTES, type Sym } from "./chunker.js";
import { tokenize, tokenizeName } from "./tokens.js";

export interface IndexReport {
  ref: string; files: number; manifestRows: number; newBlobs: number; reusedBlobs: number;
  symbols: number; skipped: Record<string, number>; missing: number; ms: number; prefetched: number;
}

const BATCH = 400;
// Doc-comment tokens in the FTS index: off saves ~1/3 of FTS size; check eval before turning off.
const FTS_DOC = process.env.FTS_DOC === "1";
// Path tokens repeat on every symbol row of a file; the path filter already works on the manifest, so they are off by default.
const FTS_PATH = process.env.FTS_PATH === "1";

function symbolWriter(db: Db) {
  const insert = db.prepare("INSERT INTO symbols(blob_id,kind,name,parent,sig,doc,sl,el) VALUES (?,?,?,?,?,?,?,?)");
  const fts = db.prepare("INSERT INTO symbols_fts(rowid,name,path,sig,doc) VALUES (?,?,?,?,?)");
  return (blobId: number, path: string, symbols: Sym[]) => {
    const pathTokens = FTS_PATH ? tokenize(path.replace(/^webapps\/zohocrm\//, "")) : "";
    for (const s of symbols) {
      const id = insert.run(blobId, s.kind, s.name, s.parent, packText(s.sig), packText(s.doc), s.sl, s.el).lastInsertRowid;
      fts.run(id, tokenizeName(`${s.parent} ${s.name}`), pathTokens, tokenize(s.sig), FTS_DOC ? tokenize(s.doc) : "");
    }
  };
}

export async function indexRef(db: Db, repo: string, gitRef: string, onProgress?: (done: number, total: number) => void, label = gitRef): Promise<IndexReport> {
  const t0 = Date.now();
  await initChunker();
  const revision = git(repo, ["rev-parse", "--verify", "--end-of-options", gitRef + "^{commit}"]).trim();
  const tree = lsTree(repo, revision).filter((e) => langOf(e.path));
  const rid = refId(db, label, true)!;

  // 1. dictionary rows: paths and blobs (blob rows first, so manifest can reference them)
  const pathIds = new Map<string, number>(
    (db.prepare("SELECT id, path FROM paths").all() as { id: number; path: string }[]).map((r) => [r.path, r.id]),
  );
  const blobIds = new Map<string, number>(
    (db.prepare("SELECT id, sha FROM blobs").all() as { id: number; sha: string }[]).map((r) => [r.sha, r.id]),
  );
  const insPath = db.prepare("INSERT INTO paths(path) VALUES (?)");
  const insBlobRow = db.prepare("INSERT INTO blobs(sha, status) VALUES (?, 'pending')");
  const newBlobs: string[] = [];
  const pathOfBlob = new Map<string, string>();
  db.transaction(() => {
    for (const e of tree) {
      if (!pathIds.has(e.path)) pathIds.set(e.path, Number(insPath.run(e.path).lastInsertRowid));
      if (!blobIds.has(e.blob)) {
        blobIds.set(e.blob, Number(insBlobRow.run(e.blob).lastInsertRowid));
        newBlobs.push(e.blob);
        pathOfBlob.set(e.blob, e.path);
      }
    }
  })();

  // 2. manifest for this ref (replaces previous rows for the ref)
  const insManifest = db.prepare("INSERT INTO manifest(ref_id, path_id, blob_id) VALUES (?,?,?)");
  db.transaction(() => {
    db.prepare("DELETE FROM meta WHERE k=?").run(`revision:${label}`);
    db.prepare("DELETE FROM manifest WHERE ref_id=?").run(rid);
    for (const e of tree) insManifest.run(rid, pathIds.get(e.path)!, blobIds.get(e.blob)!);
  })();

  // 3. parse only blobs that are new to the whole index
  const todo = newBlobs;
  const pre = await prefetchBlobs(repo, todo);
  const updBlob = db.prepare("UPDATE blobs SET size=?, lang=?, status=?, nsyms=?, lines=? WHERE id=?");
  const saveSymbols = symbolWriter(db);
  const insBody = db.prepare("INSERT OR REPLACE INTO bodies(blob_id, z) VALUES (?,?)");

  const skipped: Record<string, number> = {};
  let symbols = 0, missing = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const shas = todo.slice(i, i + BATCH);
    const blobs = await readBlobs(repo, shas);
    db.transaction(() => {
      for (const sha of shas) {
        const path = pathOfBlob.get(sha)!;
        const bid = blobIds.get(sha)!;
        const lang = langOf(path)!;
        const buf = blobs.get(sha);
        if (!buf) { missing++; updBlob.run(0, lang, "missing", 0, 0, bid); continue; }
        const text = buf.toString("utf8");
        const lines = text.split("\n").length;
        const skip = isSkippable(buf.length, text);
        if (!skip) insBody.run(bid, packBody(buf));
        if (skip) { updBlob.run(buf.length, lang, skip, 0, lines, bid); skipped[skip] = (skipped[skip] ?? 0) + 1; continue; }
        let syms;
        try { syms = chunk(lang, text, path); } catch { updBlob.run(buf.length, lang, "parse_error", 0, lines, bid); skipped.parse_error = (skipped.parse_error ?? 0) + 1; continue; }
        saveSymbols(bid, path, syms);
        symbols += syms.length;
        updBlob.run(buf.length, lang, syms.length ? "ok" : "no_symbols", syms.length, lines, bid);
      }
    })();
    onProgress?.(Math.min(i + BATCH, todo.length), todo.length);
  }

  db.transaction(() => {
    const meta = db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)");
    meta.run(`indexed:${label}`, new Date().toISOString());
    const incomplete = db.prepare(`SELECT 1 FROM manifest m JOIN blobs b ON b.id=m.blob_id
      WHERE m.ref_id=? AND b.status IN ('pending','missing') LIMIT 1`).get(rid);
    if (!incomplete) meta.run(`revision:${label}`, revision);
  })();
  const distinct = new Set(tree.map((e) => e.blob));
  return { ref: label, files: tree.length, manifestRows: tree.length, newBlobs: todo.length, reusedBlobs: distinct.size - todo.length, symbols, skipped, missing, ms: Date.now() - t0, prefetched: pre.requested };
}

const COMPLETE = "('ok','no_symbols','parse_error','minified','too_big')";
const BASE_SHAS = `SELECT DISTINCT b.sha FROM manifest m JOIN blobs b ON b.id=m.blob_id
  WHERE m.ref_id=(SELECT id FROM refs WHERE name='master') AND b.status IN ${COMPLETE} ORDER BY b.sha`;

export function baseIdentity(db: Db): string {
  const revision = db.prepare("SELECT v FROM meta WHERE k='revision:master'").pluck().get() as string | undefined;
  if (revision) return revision;
  // Older base snapshots have no commit marker. Fingerprint exactly the blobs those snapshots can supply.
  const hash = createHash("sha256");
  let count = 0;
  for (const sha of db.prepare(BASE_SHAS).pluck().iterate() as Iterable<string>) {
    hash.update(sha + "\n");
    count++;
  }
  return count ? hash.digest("hex") : "empty";
}

// Read one blob at a time through a single Git process. Count lines in oversized blobs without retaining their bodies.
async function* sourcesFromGit(repo: string, paths: Map<string, string>): AsyncGenerator<Source> {
  if (!paths.size) return;
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  closed.catch(() => {}); // The iterator may see stdout close before the process error.
  child.stdin.on("error", () => {}); // A failed child is reported by its exit status.
  child.stdin.end([...paths.keys()].join("\n") + "\n");
  const chunks = child.stdout[Symbol.asyncIterator]();
  let bytes: Buffer = Buffer.alloc(0);
  async function fill() {
    if (bytes.length) return;
    const next = await chunks.next();
    if (next.done) throw new Error("Unexpected end of Git blob stream");
    bytes = next.value as Buffer;
  }
  try {
    for (const [blob, path] of paths) {
      let header = "";
      while (true) {
        await fill();
        const end = bytes.indexOf(10);
        header += bytes.toString("ascii", 0, end < 0 ? bytes.length : end);
        if (header.length > 128) throw new Error("Invalid Git blob header");
        bytes = end < 0 ? bytes.subarray(bytes.length) : bytes.subarray(end + 1);
        if (end >= 0) break;
      }
      const [oid, type, length] = header.split(" ");
      const size = Number(length);
      if (oid !== blob || type !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new Error(`Missing Git blob ${blob}`);
      const body = size <= MAX_BYTES ? Buffer.allocUnsafe(size) : undefined;
      let offset = 0, lines = 1;
      while (offset < size) {
        await fill();
        const take = bytes.subarray(0, Math.min(bytes.length, size - offset));
        for (let i = take.indexOf(10); i >= 0; i = take.indexOf(10, i + 1)) lines++;
        body?.set(take, offset);
        bytes = bytes.subarray(take.length);
        offset += take.length;
      }
      await fill();
      if (bytes[0] !== 10) throw new Error("Invalid Git blob terminator");
      bytes = bytes.subarray(1);
      yield { type: "source", path, blob, size, lines, data: body?.toString("base64") };
    }
    if (await closed !== 0) throw new Error("Git blob export failed");
  } finally {
    child.kill();
  }
}

export async function exportBranchInput(db: Db, repo: string, revision: string, outputFile: string, expectedBaseRevision?: string): Promise<void> {
  requireObjectId(revision);
  if (git(repo, ["rev-parse", "--verify", revision + "^{commit}"]).trim() !== revision) throw new Error("Expected a pinned commit");
  const tree = lsTree(repo, revision).filter(e => langOf(e.path));
  const base = db.transaction(() => {
    if (!expectedBaseRevision) return new Set<string>();
    if (baseIdentity(db) !== expectedBaseRevision) throw new Error("Base snapshot changed during branch preparation");
    return new Set(db.prepare(BASE_SHAS).pluck().iterate() as Iterable<string>);
  })();
  const manifest = createHash("sha256");
  const changed = new Map<string, string>();
  for (const e of tree) {
    manifest.update(manifestRecord(e));
    if (!base.has(e.blob) && !changed.has(e.blob)) changed.set(e.blob, e.path);
  }
  const header: Header = { type: "input", version: BRANCH_ARTIFACT_VERSION, revision, files: tree.length,
    sources: changed.size, manifestSha256: manifest.digest("hex") };
  await prefetchBlobs(repo, [...changed.keys()]);
  async function* records() {
    yield JSON.stringify(header) + "\n";
    for await (const source of sourcesFromGit(repo, changed)) yield JSON.stringify(source) + "\n";
    for (const e of tree) yield JSON.stringify({ type: "file", ...e }) + "\n";
  }
  await writeCompressed(records(), outputFile);
}

// Keep the SQLite write transaction synchronous. Readers on other WAL connections see the old branch until commit.
function* readLines(file: string, expectedSha256: string): Generator<string> {
  const fd = openSync(file, "r");
  const hash = createHash("sha256");
  const input = Buffer.allocUnsafe(8192);
  const parts: Buffer[] = [];
  const output: Buffer[] = [];
  const inflater = new Gunzip(chunk => output.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  try {
    while (true) {
      const n = readSync(fd, input, 0, input.length, null);
      const compressed = input.subarray(0, n);
      hash.update(compressed);
      inflater.push(compressed, n === 0);
      for (const block of output) {
        let start = 0;
        for (let end = block.indexOf(10); end >= 0; end = block.indexOf(10, start)) {
          const line = block.subarray(start, end);
          yield parts.length ? Buffer.concat([...parts, line]).toString("utf8") : line.toString("utf8");
          parts.length = 0;
          start = end + 1;
        }
        if (start < block.length) parts.push(block.subarray(start));
      }
      output.length = 0;
      if (!n) break;
    }
    if (hash.digest("hex") !== expectedSha256) throw new Error("Branch artifact checksum mismatch");
    if (parts.length) throw new Error("Truncated branch artifact record");
  } finally { closeSync(fd); }
}

function detachManifest(db: Db, rid: number) {
  // Restrict garbage collection to replaced manifest entries. Other refs retain shared blobs and paths.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS previous_branch_manifest(path_id INTEGER PRIMARY KEY, blob_id INTEGER NOT NULL)");
  db.prepare("INSERT INTO previous_branch_manifest SELECT path_id,blob_id FROM manifest WHERE ref_id=?").run(rid);
  db.prepare("DELETE FROM manifest WHERE ref_id=?").run(rid);
}

function collectDetached(db: Db, replacementId?: number) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS replaced_blobs(id INTEGER PRIMARY KEY);
    INSERT INTO replaced_blobs SELECT DISTINCT p.blob_id FROM previous_branch_manifest p
      WHERE NOT EXISTS (SELECT 1 FROM manifest m WHERE m.blob_id=p.blob_id);
    DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE blob_id IN replaced_blobs);
    DELETE FROM symbols WHERE blob_id IN replaced_blobs;
    DELETE FROM bodies WHERE blob_id IN replaced_blobs;
    DELETE FROM blobs WHERE id IN replaced_blobs;
    DELETE FROM replaced_blobs;`);
  if (replacementId !== undefined) {
    db.prepare("DELETE FROM previous_branch_manifest WHERE path_id IN (SELECT path_id FROM manifest WHERE ref_id=?)").run(replacementId);
  }
  if (db.prepare("SELECT 1 FROM previous_branch_manifest LIMIT 1").get()) {
    db.exec(`DELETE FROM paths WHERE id IN (
      SELECT path_id FROM previous_branch_manifest EXCEPT SELECT path_id FROM manifest);
      DELETE FROM previous_branch_manifest;`);
  }
}

function installRecords(db: Db, branch: string, revision: string, file: string, expectedSha256: string, guard?: () => void): IndexReport {
  const t0 = Date.now();
  guard?.();
  const rid = refId(db, branch, true)!;
  detachManifest(db, rid);
  const findBlob = db.prepare("SELECT id,status FROM blobs WHERE sha=?");
  const saveBlob = db.prepare(`INSERT INTO blobs(sha,size,lang,status,nsyms,lines) VALUES (?,?,?,?,?,?)
    ON CONFLICT(sha) DO UPDATE SET size=excluded.size,lang=excluded.lang,status=excluded.status,nsyms=excluded.nsyms,lines=excluded.lines
    RETURNING id`).pluck();
  const putBody = db.prepare("INSERT OR REPLACE INTO bodies(blob_id,z) VALUES (?,?)");
  const saveSymbols = symbolWriter(db);
  const putPath = db.prepare("INSERT OR IGNORE INTO paths(path) VALUES (?)");
  const putFile = db.prepare(`INSERT INTO manifest(ref_id,path_id,blob_id)
    SELECT ?,p.id,b.id FROM paths p, blobs b WHERE p.path=? AND b.sha=? AND b.status IN ${COMPLETE}`);
  let header: Header | undefined;
  const manifest = createHash("sha256");
  const distinct = new Set<string>();
  const supplied = new Map<string, string>();
  let files = 0, sources = 0, newBlobs = 0, symbols = 0;
  const skipped: Record<string, number> = {};
  for (const line of readLines(file, expectedSha256)) {
    if (!header) {
      header = readHeader(line, "artifact", revision);
      continue;
    }
    const record = JSON.parse(line);
    if (record.type === "file") {
      const e: FileEntry = record;
      checkEntry(e);
      manifest.update(manifestRecord(e));
      distinct.add(e.blob);
      putPath.run(e.path);
      if (putFile.run(rid, e.path, e.blob).changes !== 1) throw new Error(`Branch artifact requires absent base blob ${e.blob}`);
      if (supplied.get(e.blob) === e.path) supplied.delete(e.blob);
      files++;
      continue;
    }
    if (record.type !== "parsed" || files) throw new Error("Unexpected branch artifact record");
    const b: Parsed = record;
    const body = checkSource(b);
    const skippedBody = b.status === "too_big" || b.status === "minified";
    if (!["too_big","minified","ok","no_symbols","parse_error"].includes(b.status) || !Array.isArray(b.symbols) ||
        Boolean(body) === skippedBody || (b.status === "too_big") !== (b.size > MAX_BYTES) ||
        (b.status === "ok") !== (b.symbols.length > 0) || supplied.has(b.blob)) throw new Error("Invalid parsed blob");
    supplied.set(b.blob, b.path);
    sources++;
    const existing = findBlob.get(b.blob) as { id: number; status: string } | undefined;
    if (existing && existing.status !== "missing" && existing.status !== "pending") continue;
    const id = saveBlob.get(b.blob, b.size, langOf(b.path), b.status, b.symbols.length, b.lines) as number;
    if (body) putBody.run(id, packBody(body));
    for (const s of b.symbols) {
      if (![s.kind,s.name,s.parent,s.sig,s.doc].every(v => typeof v === "string") || !s.name ||
          !Number.isSafeInteger(s.sl) || !Number.isSafeInteger(s.el) || s.sl < 1 || s.el < s.sl || s.el > b.lines) {
        throw new Error("Invalid branch artifact symbol");
      }
    }
    saveSymbols(id, b.path, b.symbols);
    newBlobs++;
    symbols += b.symbols.length;
    if (skippedBody || b.status === "parse_error") skipped[b.status] = (skipped[b.status] ?? 0) + 1;
  }
  if (!header || supplied.size || files !== header.files || sources !== header.sources ||
      manifest.digest("hex") !== header.manifestSha256) throw new Error("Incomplete branch artifact");
  collectDetached(db, rid);
  const meta = db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)");
  meta.run(`revision:${branch}`, revision);
  meta.run(`indexed:${branch}`, new Date().toISOString());
  return { ref: branch, files, manifestRows: files, newBlobs, reusedBlobs: distinct.size - newBlobs,
    symbols, skipped, missing: 0, prefetched: 0, ms: Date.now() - t0 };
}

function truncateWalIfIdle(db: Db) {
  // SQLite can retain the entire previous delta in its WAL after automatic checkpointing.
  // Truncate opportunistically. A reader or the next publisher can keep its existing lock.
  const timeout = db.pragma("busy_timeout", { simple: true }) as number;
  try {
    db.pragma("busy_timeout=0");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    console.warn("Branch WAL checkpoint deferred:", (error as Error).message);
  } finally { db.pragma(`busy_timeout=${timeout}`); }
}

export async function installBranchArtifact(db: Db, branch: string, expectedRevision: string, artifactFile: string,
  expectedSha256: string, guard?: () => void): Promise<IndexReport> {
  requireObjectId(expectedRevision);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid artifact checksum");
  // Simultaneous builds can finish together. Other worker connections publish in turn.
  const publish = db.transaction(() => installRecords(db, branch, expectedRevision, artifactFile, expectedSha256, guard));
  const deadline = Date.now() + 15 * 60_000;
  let report: IndexReport;
  for (;;) {
    try { report = publish.immediate(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      guard?.();
      await delay(200 + Math.random() * 300);
    }
  }
  truncateWalIfIdle(db);
  return report;
}

function stagingRef(generation: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(generation)) throw new Error("Invalid staging generation");
  // Git rejects ':' in branch names. Public commit selectors always start with "commit:".
  return ":stage:" + generation;
}

export function stageBranchArtifact(db: Db, generation: string, revision: string, file: string, sha256: string,
  guard?: () => void): Promise<IndexReport> {
  return installBranchArtifact(db, stagingRef(generation), revision, file, sha256, guard);
}

/** Rename a verified private manifest only after the durable branch head has accepted it. */
export function promoteBranchArtifact(db: Db, branch: string, generation: string, expectedRevision: string, guard?: () => void): void {
  const staged = stagingRef(generation);
  if (branch.startsWith(":")) throw new Error("Invalid public branch");
  requireObjectId(expectedRevision);
  db.transaction(() => {
    guard?.();
    const candidate = refId(db, staged);
    const revision = db.prepare("SELECT v FROM meta WHERE k=?").pluck().get(`revision:${staged}`);
    if (candidate === undefined || revision !== expectedRevision) throw new Error("Staged branch revision unavailable");

    const previous = refId(db, branch);
    if (previous !== undefined) {
      detachManifest(db, previous);
      db.prepare("DELETE FROM refs WHERE id=?").run(previous);
      collectDetached(db, candidate);
    }
    db.prepare("UPDATE refs SET name=? WHERE id=?").run(branch, candidate);
    const rename = db.prepare("UPDATE OR REPLACE meta SET k=? WHERE k=?");
    rename.run(`revision:${branch}`, `revision:${staged}`);
    rename.run(`indexed:${branch}`, `indexed:${staged}`);
  }).immediate();
  truncateWalIfIdle(db);
}

function discardStaged(db: Db, staged: string): void {
  const rid = refId(db, staged);
  if (rid === undefined) return;
  detachManifest(db, rid);
  db.prepare("DELETE FROM refs WHERE id=?").run(rid);
  db.prepare("DELETE FROM meta WHERE k IN (?,?)").run(`revision:${staged}`, `indexed:${staged}`);
  collectDetached(db);
}

export function discardBranchArtifact(db: Db, generation: string): void {
  const staged = stagingRef(generation);
  // Usual successful path has already renamed the candidate. Avoid taking a write lock for that case.
  if (refId(db, staged) === undefined) return;
  db.transaction(() => discardStaged(db, staged)).immediate();
  truncateWalIfIdle(db);
}

/** Call once on startup before admitting workers. Interrupted publications leave the previous public ref intact. */
export function recoverStagedArtifacts(db: Db): number {
  const stages = db.prepare("SELECT name FROM refs WHERE name GLOB ':stage:*'").pluck().all() as string[];
  if (!stages.length) return 0;
  db.transaction(() => { for (const name of stages) discardStaged(db, name); }).immediate();
  truncateWalIfIdle(db);
  return stages.length;
}
