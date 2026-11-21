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
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
    CREATE TABLE IF NOT EXISTS manifest (
      ref TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (ref, path)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS manifest_blob ON manifest(blob, ref);
    -- coverage data is NOT rebuildable from git, so it lives outside the schema-version drop list
    CREATE TABLE IF NOT EXISTS cov_report (id TEXT PRIMARY KEY, kind TEXT, branch TEXT, commit_sha TEXT, fetched_at TEXT, meta TEXT);
    CREATE TABLE IF NOT EXISTS cov_file (report TEXT NOT NULL, file TEXT NOT NULL, status TEXT, fetched_at TEXT, PRIMARY KEY (report, file)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cov_line (report TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (report, file, line)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cov_case (report TEXT NOT NULL, file TEXT NOT NULL, sl INTEGER, el INTEGER, category TEXT, status TEXT, description TEXT, commits TEXT);
    CREATE INDEX IF NOT EXISTS cov_case_file ON cov_case(file);
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, path, sig, doc, content='', tokenize='unicode61');
  `);
  return db;
}
