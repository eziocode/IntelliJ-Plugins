import { Worker } from "node:worker_threads";
import type { Db } from "./db.js";
import type { IndexReport } from "./indexer.js";

export interface IndexProgress { done: number; total: number }

/** Run indexRef in a worker thread. Resolves with the report; rejects with the worker's error. */
export function indexInWorker(db: Db, repo: string, gitRef: string, label: string, onProgress?: (p: IndexProgress) => void, fetchArgs?: string[]): Promise<IndexReport> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./indexWorker.ts", import.meta.url), {
      workerData: { dbFile: db.name, repo, gitRef, label, fetchArgs },
      execArgv: ["--import", "tsx"],
    });
    let settled = false;
    w.on("message", (m: { progress?: [number, number]; ok?: IndexReport; error?: string }) => {
      if (m.progress && onProgress) onProgress({ done: m.progress[0], total: m.progress[1] });
      if (m.ok && !settled) { settled = true; resolve(m.ok); }
      if (m.error && !settled) { settled = true; reject(new Error(m.error)); }
    });
    w.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    w.on("exit", (code) => { if (!settled) { settled = true; reject(new Error(`index worker exited with code ${code}`)); } });
  });
}
