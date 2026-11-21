import type { Db } from "./db.js";
import { lsTree, prefetchBlobs, readBlobs } from "./git.js";
import { chunk, initChunker, isSkippable, langOf } from "./chunker.js";
import { tokenize, tokenizeName } from "./tokens.js";

export interface IndexReport {
  ref: string; files: number; manifestRows: number; newBlobs: number; reusedBlobs: number;
  symbols: number; skipped: Record<string, number>; missing: number; ms: number; prefetched: number;
}

const BATCH = 400;

export async function indexRef(db: Db, repo: string, gitRef: string, onProgress?: (done: number, total: number) => void, label = gitRef): Promise<IndexReport> {
  const ref = label;
  const t0 = Date.now();
  await initChunker();
  const tree = lsTree(repo, gitRef).filter((e) => langOf(e.path));
  const files = tree.length;

  const insManifest = db.prepare("INSERT OR REPLACE INTO manifest(ref,path,blob) VALUES (?,?,?)");
  db.transaction(() => {
    db.prepare("DELETE FROM manifest WHERE ref=?").run(ref);
    for (const e of tree) insManifest.run(ref, e.path, e.blob);
  })();

  const known = new Set((db.prepare("SELECT sha FROM blobs").all() as { sha: string }[]).map((r) => r.sha));
  const pathOf = new Map<string, string>();
  for (const e of tree) if (!known.has(e.blob) && !pathOf.has(e.blob)) pathOf.set(e.blob, e.path);
  const todo = [...pathOf.keys()];
  const pre = await prefetchBlobs(repo, todo);

  const insBlob = db.prepare("INSERT OR REPLACE INTO blobs(sha,size,lang,status,nsyms,lines) VALUES (?,?,?,?,?,?)");
  const insSym = db.prepare("INSERT INTO symbols(blob,kind,name,parent,sig,doc,sl,el) VALUES (?,?,?,?,?,?,?,?)");
  const insFts = db.prepare("INSERT INTO symbols_fts(rowid,name,path,sig,doc) VALUES (?,?,?,?,?)");

  const skipped: Record<string, number> = {};
  let symbols = 0, missing = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const shas = todo.slice(i, i + BATCH);
    const blobs = await readBlobs(repo, shas);
    db.transaction(() => {
      for (const sha of shas) {
        const path = pathOf.get(sha)!;
        const lang = langOf(path)!;
        const buf = blobs.get(sha);
        if (!buf) { missing++; continue; }
        const text = buf.toString("utf8");
        const lines = text.split("\n").length;
        const skip = isSkippable(buf.length, text);
        if (skip) { insBlob.run(sha, buf.length, lang, skip, 0, lines); skipped[skip] = (skipped[skip] ?? 0) + 1; continue; }
        let syms;
        try { syms = chunk(lang, text, path); } catch { insBlob.run(sha, buf.length, lang, "parse_error", 0, lines); skipped.parse_error = (skipped.parse_error ?? 0) + 1; continue; }
        const ptoks = tokenize(path.replace(/^webapps\/zohocrm\//, ""));
        for (const s of syms) {
          const id = Number(insSym.run(sha, s.kind, s.name, s.parent, s.sig, s.doc, s.sl, s.el).lastInsertRowid);
          insFts.run(id, tokenizeName(`${s.parent} ${s.name}`), ptoks, tokenize(s.sig), tokenize(s.doc));
        }
        symbols += syms.length;
        insBlob.run(sha, buf.length, lang, syms.length ? "ok" : "no_symbols", syms.length, lines);
      }
    })();
    onProgress?.(Math.min(i + BATCH, todo.length), todo.length);
  }

  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)").run(`indexed:${ref}`, new Date().toISOString());
  return { ref, files, manifestRows: tree.length, newBlobs: todo.length, reusedBlobs: new Set(tree.map((e) => e.blob)).size - todo.length, symbols, skipped, missing, ms: Date.now() - t0, prefetched: pre.requested };
}
