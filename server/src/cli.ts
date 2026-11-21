import { statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { openDb } from "./db.js";
import { indexRef } from "./indexer.js";
import { runEval } from "./eval.js";
import { searchSymbols, formatCards } from "./search.js";
import { changeSummary, formatSummary, formatDiffSymbols } from "./summary.js";
import { diffSymbols } from "./diff.js";
import { coverageGap, formatGap } from "./gap.js";
import { covConfigFromEnv } from "./coverage.js";
import { unpackText } from "./db.js";
import { impactTests, formatImpact, compareDescription, formatDescriptionCheck } from "./impact.js";

const [cmd, ...rest] = process.argv.slice(2);
const DATA = process.env.DATA_DIR ?? "data";
mkdirSync(DATA, { recursive: true });
// same file name the server uses for its default repo, so CLI-built snapshots/restores are the ones it serves
const dbFile = process.env.DB_FILE ?? `${DATA}/${process.env.REPO_NAME ?? "zohocrm"}.sqlite`;

if (cmd === "index") {
  const [repo, gitRef = "origin/master", label] = rest;
  const db = openDb(dbFile);
  const rep = await indexRef(db, repo, gitRef, (d, t) => { if (d % 2000 < 400 || d === t) process.stderr.write(`\r${d}/${t} blobs`); }, label ?? gitRef.replace(/^(refs\/remotes\/)?origin\//, ""));
  process.stderr.write("\n");
  console.log(JSON.stringify(rep, null, 2));
  console.log("db bytes:", statSync(dbFile).size);
} else if (cmd === "stats") {
  const db = openDb(dbFile);
  console.log(db.prepare("SELECT status, lang, COUNT(*) n, SUM(size) bytes, SUM(nsyms) syms FROM blobs GROUP BY 1,2").all());
  console.log(db.prepare("SELECT kind, COUNT(*) n FROM symbols GROUP BY 1 ORDER BY 2 DESC").all());
  console.log("db bytes:", statSync(dbFile).size);
} else if (cmd === "search") {
  const [q, limit = "8", ref = "master"] = rest;
  const db = openDb(dbFile);
  const r = searchSymbols(db, ref, q, Number(limit));
  console.log(`mode=${r.mode}\n${formatCards(r.cards)}`);
} else if (cmd === "eval") {
  const [file = "eval/seed.json", ref = "master"] = rest;
  const r = runEval(openDb(dbFile), ref, file);
  console.table(r.rows);
  console.log({ recallAt10: r.recallAtK, mrr: Number(r.mrr.toFixed(3)), p50ms: r.p50ms, maxMs: r.maxMs });
} else if (cmd === "diff" || cmd === "summary") {
  const [repo, base, head] = rest;
  const db = openDb(dbFile);
  if (cmd === "diff") console.log(formatDiffSymbols(diffSymbols(db, repo, base, head), 40));
  else console.log(formatSummary(changeSummary(db, repo, base, head)));
} else if (cmd === "gap") {
  const [repo, base, head, kind, report, reportCommit, at] = rest;
  const r = await coverageGap(openDb(dbFile), repo, covConfigFromEnv(), { base, head, kind: kind as "jacoco" | "js", report, reportCommit: reportCommit && reportCommit !== "-" ? reportCommit : undefined, atReportCommit: at === "at" });
  console.log(formatGap(r));
} else if (cmd === "impact" || cmd === "describe") {
  const [repo, base, head, desc] = rest;
  const db = openDb(dbFile);
  if (cmd === "impact") console.log(formatImpact(await impactTests(db, repo, base, head)));
  else console.log(formatDescriptionCheck(compareDescription(diffSymbols(db, repo, base, head), desc)));
} else if (cmd === "mkdict") {
  // Build the shared zlib dictionary from the most frequent signature/doc words in the index. Re-index after changing it.
  const db = openDb(dbFile);
  const freq = new Map<string, number>();
  const rows = db.prepare("SELECT sig, doc FROM symbols").iterate() as Iterable<{ sig: unknown; doc: unknown }>;
  let n = 0;
  for (const r of rows) {
    if (n++ > 150000) break;
    // the index being sampled may still hold pre-dictionary packs (no header): decode those without a dictionary
    const dec = (v: unknown): string => (Buffer.isBuffer(v) && v[0] !== 0x01 ? inflateRawSync(v).toString("utf8") : unpackText(v));
    for (const t of [dec(r.sig), dec(r.doc)]) for (const w of t.split(/[\s(),<>{};\[\]=.]+/)) if (w.length > 1) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 2000).map(([w]) => w);
  const dict = Buffer.from(top.join(" ").slice(0, 16384), "utf8");
  const { writeFileSync } = await import("node:fs");
  writeFileSync("src/zdict.bin", dict);
  console.log(`wrote src/zdict.bin ${dict.length} bytes from ${top.length} words; re-index every repo afterwards`);
} else if (cmd === "snapshot") {
  // Compacted, consistent copy of the index (safe while the server runs). Gzip it and upload to Stratus for cold starts.
  const [out = "data/snapshot.sqlite"] = rest;
  const db = openDb(dbFile);
  db.prepare("VACUUM INTO ?").run(out);
  const { gzipSync } = await import("node:zlib");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const gz = gzipSync(readFileSync(out), { level: 6 });
  writeFileSync(`${out}.gz`, gz);
  console.log(JSON.stringify({ snapshot: out, bytes: statSync(out).size, gzBytes: gz.length }));
} else if (cmd === "restore") {
  // Cold start: unpack a snapshot into DATA_DIR before the server opens the index.
  const [gzFile = "data/snapshot.sqlite.gz"] = rest;
  const { gunzipSync } = await import("node:zlib");
  const { readFileSync, writeFileSync, renameSync } = await import("node:fs");
  writeFileSync(`${dbFile}.tmp`, gunzipSync(readFileSync(gzFile)));
  renameSync(`${dbFile}.tmp`, dbFile);
  console.log(`restored ${dbFile} from ${gzFile}`);
} else if (cmd === "prune") {
  // Remove a branch's mirror blobs after dropping it from the index.
  const [repo, branch] = rest;
  const { pruneRemoteRef } = await import("./git.js");
  console.log(JSON.stringify(pruneRemoteRef(repo, branch)));
} else {
  console.error("usage: cli.ts index <repo> [ref] | stats | search <query> [limit] [ref] | eval [file] [ref]");
  process.exit(1);
}
