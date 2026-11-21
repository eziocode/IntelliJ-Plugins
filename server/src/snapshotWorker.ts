// Runs one snapshot upload off the main thread (VACUUM + gzip are CPU/disk heavy).
import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db.js";
import { uploadSnapshot } from "./snapshot.js";

const { dbFile, name } = workerData as { dbFile: string; name: string };
const db = openDb(dbFile);
try {
  parentPort!.postMessage({ result: await uploadSnapshot(db, name) });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message.split("\n")[0] });
} finally {
  db.close();
}
