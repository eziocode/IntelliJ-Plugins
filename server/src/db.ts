import Database from "better-sqlite3";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

export type Db = Database.Database;
// v4: v3 + compressed bodies table (get_symbol without the git mirror).
const SCHEMA_VERSION = "4";

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // a writer (index worker, touch, flush) waits for the lock instead of failing with SQLITE_BUSY
  db.pragma("busy_timeout = 30000");
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  const cur = (db.prepare("SELECT v FROM meta WHERE k='schema'").get() as { v: string } | undefined)?.v;
  if (cur !== SCHEMA_VERSION) {
    // The code index is rebuildable from git, so a schema change = drop and re-index.
    // Coverage tables (cov_*) are NOT rebuildable from git and are never dropped here.
    db.exec(`
      DROP VIEW IF EXISTS v_manifest;
      DROP TABLE IF EXISTS symbols_fts; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS blobs;
      DROP TABLE IF EXISTS manifest; DROP TABLE IF EXISTS paths; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS bodies;
      DELETE FROM meta WHERE k LIKE 'indexed:%' OR k LIKE 'used:%' OR k='schema';`);
    db.prepare("INSERT INTO meta(k,v) VALUES ('schema',?)").run(SCHEMA_VERSION);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS refs (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS paths (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS blobs (
      id INTEGER PRIMARY KEY, sha TEXT UNIQUE NOT NULL, size INTEGER, lang TEXT, status TEXT, nsyms INTEGER, lines INTEGER
    );
    -- deflated source per blob: get_symbol reads here, so the git mirror is only needed to index new blobs
    CREATE TABLE IF NOT EXISTS bodies (blob_id INTEGER PRIMARY KEY, z BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY, blob_id INTEGER NOT NULL, kind TEXT, name TEXT, parent TEXT,
      sig, doc, sl INTEGER, el INTEGER
    );
    CREATE INDEX IF NOT EXISTS symbols_blob ON symbols(blob_id);
    CREATE TABLE IF NOT EXISTS manifest (
      ref_id INTEGER NOT NULL, path_id INTEGER NOT NULL, blob_id INTEGER NOT NULL,
      PRIMARY KEY (ref_id, path_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS manifest_blob ON manifest(blob_id, ref_id);
    CREATE VIEW IF NOT EXISTS v_manifest AS
      SELECT r.name AS ref, p.path AS path, m.blob_id AS blob_id, b.sha AS blob
      FROM manifest m JOIN refs r ON r.id = m.ref_id JOIN paths p ON p.id = m.path_id JOIN blobs b ON b.id = m.blob_id;
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, path, sig, doc, content='', contentless_delete=1, tokenize='unicode61');
    -- coverage data is NOT rebuildable from git
    CREATE TABLE IF NOT EXISTS cov_report (id TEXT PRIMARY KEY, kind TEXT, branch TEXT, commit_sha TEXT, fetched_at TEXT, meta TEXT);
    CREATE TABLE IF NOT EXISTS cov_file (report TEXT NOT NULL, file TEXT NOT NULL, status TEXT, fetched_at TEXT, PRIMARY KEY (report, file)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cov_line (report TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (report, file, line)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cov_case (report TEXT NOT NULL, file TEXT NOT NULL, sl INTEGER, el INTEGER, category TEXT, status TEXT, description TEXT, commits TEXT);
    CREATE INDEX IF NOT EXISTS cov_case_file ON cov_case(file);
  `);
  return db;
}

/**
 * Long signatures/doc lines are deflated with a shared dictionary (src/zdict.bin, built by `cli mkdict`).
 * Packed value = [0x01][deflateRaw(text, dict)]. Short values stay plain TEXT (cheaper than a blob).
 * Changing zdict.bin requires a full re-index (the header byte stays the same).
 */
const PACK_MIN = 40;
const V1 = 0x01;
let dictCache: Buffer | null = null;
export function zdict(): Buffer {
  if (!dictCache) dictCache = readFileSync(new URL("./zdict.bin", import.meta.url));
  return dictCache;
}
export function packText(s: string | null | undefined): string | Buffer {
  if (!s) return "";
  if (s.length < PACK_MIN) return s;
  const z = deflateRawSync(Buffer.from(s, "utf8"), { level: 9, dictionary: zdict() });
  const out = Buffer.concat([Buffer.from([V1]), z]);
  return out.length < Buffer.byteLength(s) ? out : s;
}
export function unpackText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) {
    if (v[0] !== V1) throw new Error(`unknown packed text version ${v[0]}`);
    return inflateRawSync(v.subarray(1), { dictionary: zdict() }).toString("utf8");
  }
  return String(v);
}

export function refId(db: Db, name: string, create = false): number | undefined {
  const r = db.prepare("SELECT id FROM refs WHERE name=?").get(name) as { id: number } | undefined;
  if (r) return r.id;
  if (!create) return undefined;
  return Number(db.prepare("INSERT INTO refs(name) VALUES (?)").run(name).lastInsertRowid);
}

/** Source bodies are stored deflated (plain deflate; the code corpus compresses ~5:1). */
export function packBody(buf: Buffer): Buffer {
  return deflateRawSync(buf, { level: 6 });
}
export function unpackBody(z: Buffer): string {
  return inflateRawSync(z).toString("utf8");
}
