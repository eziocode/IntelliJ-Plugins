// Runs one index build off the main thread. Opens its own SQLite connection (WAL: readers keep working).
import { parentPort, workerData } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { openDb } from "./db.js";
import { indexRef } from "./indexer.js";

const { dbFile, repo, gitRef, label, fetchArgs } = workerData as { dbFile: string; repo: string; gitRef: string; label: string; fetchArgs?: string[] };
const db = openDb(dbFile);
try {
  // git fetch is synchronous; it runs here so the main thread keeps serving searches
  if (fetchArgs) execFileSync("git", ["-C", repo, ...fetchArgs], { stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const report = await indexRef(db, repo, gitRef, (done, total) => parentPort!.postMessage({ progress: [done, total] }), label);
  parentPort!.postMessage({ ok: report });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message.split("\n")[0] });
} finally {
  db.close();
}
