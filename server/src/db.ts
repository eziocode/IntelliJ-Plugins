import Database from "better-sqlite3";

export type Db = Database.Database;
const SCHEMA_VERSION = "2";

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  const cur = (db.prepare("SELECT v FROM meta WHERE k='schema'").get() as { v: string } | undefined)?.v;
  if (cur !== SCHEMA_VERSION) {
    // Index is rebuildable from git, so a schema change = drop and re-index.
    db.exec(`DROP TABLE IF EXISTS symbols_fts; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS blobs; DROP TABLE IF EXISTS manifest; DELETE FROM meta;`);
    db.prepare("INSERT INTO meta(k,v) VALUES ('schema',?)").run(SCHEMA_VERSION);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      sha TEXT PRIMARY KEY, size INTEGER, lang TEXT, status TEXT, nsyms INTEGER, lines INTEGER
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY, blob TEXT NOT NULL, kind TEXT, name TEXT, parent TEXT,
      sig TEXT, doc TEXT, sl INTEGER, el INTEGER
    );
    CREATE INDEX IF NOT EXISTS symbols_blob ON symbols(blob);
    CREATE TABLE IF NOT EXISTS manifest (
      ref TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (ref, path)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS manifest_blob ON manifest(blob, ref);
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, path, sig, doc, content='', tokenize='unicode61');
  `);
  return db;
}
