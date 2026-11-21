import type { Db } from "./db.js";

/** Bytes SQLite actually uses (page_count minus free pages). File size never shrinks without VACUUM, so this is the budget measure. */
export function usedBytes(db: Db): number {
  const pc = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const fl = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const ps = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  return (pc - fl) * ps;
}

// Request path never writes: use times live in memory and are persisted by persistTouches() on a timer.
const pendingTouch = new WeakMap<Db, Map<string, number>>();
/** Record that a ref was used now (LRU clock). In-memory only; no database lock on the request path. */
export function touchRef(db: Db, ref: string): void {
  let touches = pendingTouch.get(db);
  if (!touches) { touches = new Map(); pendingTouch.set(db, touches); }
  touches.set(ref, Date.now());
}
/** Write pending use times to meta. Called by the server on a timer and before a flush sweep. */
export function persistTouches(db: Db): number {
  const touches = pendingTouch.get(db);
  if (!touches?.size) return 0;
  const ins = db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)");
  const n = touches.size;
  db.transaction(() => { for (const [ref, t] of touches) ins.run(`used:${ref}`, String(t)); })();
  touches.clear();
  return n;
}

export function lastUsed(db: Db, ref: string): number {
  const r = db.prepare("SELECT v FROM meta WHERE k=?").get(`used:${ref}`) as { v: string } | undefined;
  return Math.max(r ? Number(r.v) : 0, pendingTouch.get(db)?.get(ref) ?? 0);
}

/** Remove one ref's manifest, then garbage-collect symbols/blobs/paths no ref references any more. */
export function dropRef(db: Db, ref: string): { symbols: number; blobs: number; paths: number } {
  const rid = (db.prepare("SELECT id FROM refs WHERE name=?").get(ref) as { id: number } | undefined)?.id;
  if (rid === undefined) return { symbols: 0, blobs: 0, paths: 0 };
  return db.transaction(() => {
    db.prepare("DELETE FROM manifest WHERE ref_id=?").run(rid);
    db.prepare("DELETE FROM refs WHERE id=?").run(rid);
    db.prepare("DELETE FROM meta WHERE k IN (?,?,?)").run(`indexed:${ref}`, `used:${ref}`, `revision:${ref}`);
    // symbols whose blob no ref uses any more (uses manifest_blob index)
    const dead = db.prepare("SELECT s.id FROM symbols s WHERE NOT EXISTS (SELECT 1 FROM manifest m WHERE m.blob_id = s.blob_id)").all() as { id: number }[];
    const delFts = db.prepare("DELETE FROM symbols_fts WHERE rowid = ?");
    const delSym = db.prepare("DELETE FROM symbols WHERE id = ?");
    for (const { id } of dead) { delFts.run(id); delSym.run(id); }
    db.prepare("DELETE FROM bodies WHERE NOT EXISTS (SELECT 1 FROM manifest m WHERE m.blob_id = bodies.blob_id)").run();
    const blobs = db.prepare("DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM manifest m WHERE m.blob_id = blobs.id)").run().changes;
    const paths = db.prepare("DELETE FROM paths WHERE id IN (SELECT id FROM paths EXCEPT SELECT path_id FROM manifest)").run().changes;
    return { symbols: dead.length, blobs, paths };
  })();
}

/**
 * Keep used bytes under budget by dropping least-recently-used refs. Never drops `keep`, master, or refs in use right now.
 * Returns what was dropped. Free pages are reused by later indexing, so the file size stays put rather than shrinking.
 */
export function enforceBudget(db: Db, budgetBytes: number, keep: Set<string>, base = "master"): string[] {
  const dropped: string[] = [];
  while (usedBytes(db) > budgetBytes) {
    const refs = (db.prepare("SELECT name FROM refs WHERE name NOT GLOB ':stage:*'").all() as { name: string }[]).map((r) => r.name)
      .filter((n) => n !== base && !keep.has(n));
    if (!refs.length) break;
    refs.sort((a, b) => lastUsed(db, a) - lastUsed(db, b));
    const victim = refs[0];
    dropRef(db, victim);
    dropped.push(victim);
  }
  return dropped;
}

/**
 * Idle policy: drop every non-base ref not used for `maxIdleMs` (default 48 h). Refs with no recorded use count as idle.
 * Base (master) and `keep` are never dropped. Returns the dropped refs.
 */
export function sweepIdle(db: Db, maxIdleMs: number, keep: Set<string>, base = "master", now = Date.now()): string[] {
  persistTouches(db);
  const names = (db.prepare("SELECT name FROM refs WHERE name NOT GLOB ':stage:*'").all() as { name: string }[]).map((r) => r.name);
  const dropped: string[] = [];
  for (const n of names) {
    if (n === base || keep.has(n)) continue;
    if (now - lastUsed(db, n) < maxIdleMs) continue;
    dropRef(db, n);
    dropped.push(n);
  }
  return dropped;
}
