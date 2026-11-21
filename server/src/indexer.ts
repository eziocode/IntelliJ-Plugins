import type { Db } from "./db.js";
import { packBody, packText, refId } from "./db.js";
import { lsTree, prefetchBlobs, readBlobs } from "./git.js";
import { chunk, initChunker, isSkippable, langOf } from "./chunker.js";
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

export async function indexRef(db: Db, repo: string, gitRef: string, onProgress?: (done: number, total: number) => void, label = gitRef): Promise<IndexReport> {
  const t0 = Date.now();
  await initChunker();
  const tree = lsTree(repo, gitRef).filter((e) => langOf(e.path));
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
    db.prepare("DELETE FROM manifest WHERE ref_id=?").run(rid);
    for (const e of tree) insManifest.run(rid, pathIds.get(e.path)!, blobIds.get(e.blob)!);
  })();

  // 3. parse only blobs that are new to the whole index
  const todo = newBlobs;
  const pre = await prefetchBlobs(repo, todo);
  const updBlob = db.prepare("UPDATE blobs SET size=?, lang=?, status=?, nsyms=?, lines=? WHERE id=?");
  const insSym = db.prepare("INSERT INTO symbols(blob_id,kind,name,parent,sig,doc,sl,el) VALUES (?,?,?,?,?,?,?,?)");
  const insBody = db.prepare("INSERT OR REPLACE INTO bodies(blob_id, z) VALUES (?,?)");
  const insFts = db.prepare("INSERT INTO symbols_fts(rowid,name,path,sig,doc) VALUES (?,?,?,?,?)");

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
        const ptoks = tokenize(path.replace(/^webapps\/zohocrm\//, ""));
        for (const s of syms) {
          const id = Number(insSym.run(bid, s.kind, s.name, s.parent, packText(s.sig), packText(s.doc), s.sl, s.el).lastInsertRowid);
          insFts.run(id, tokenizeName(`${s.parent} ${s.name}`), FTS_PATH ? ptoks : "", tokenize(s.sig), FTS_DOC ? tokenize(s.doc) : "");
        }
        symbols += syms.length;
        updBlob.run(buf.length, lang, syms.length ? "ok" : "no_symbols", syms.length, lines, bid);
      }
    })();
    onProgress?.(Math.min(i + BATCH, todo.length), todo.length);
  }

  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)").run(`indexed:${label}`, new Date().toISOString());
  const distinct = new Set(tree.map((e) => e.blob));
  return { ref: label, files: tree.length, manifestRows: tree.length, newBlobs: todo.length, reusedBlobs: distinct.size - todo.length, symbols, skipped, missing, ms: Date.now() - t0, prefetched: pre.requested };
}
