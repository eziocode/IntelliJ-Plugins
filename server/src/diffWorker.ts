import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { diffSymbols } from "./diff.js";

const { dbFile, dir, base, head, revisions } = workerData;
const db = new Database(dbFile, {readonly: true, fileMustExist: true});
try {
  // Hold a single read snapshot for both manifests while Git maps the changed lines.
  const result = db.transaction(() => {
    const lookup = db.prepare("SELECT v FROM meta WHERE k=?").pluck();
    if (lookup.get("revision:" + base) !== revisions.base || lookup.get("revision:" + head) !== revisions.head)
      return { changed: true };
    return { diff: diffSymbols(db, dir, base, head, revisions) };
  })();
  parentPort!.postMessage(result);
} finally { db.close(); }
