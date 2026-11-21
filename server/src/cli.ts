import { statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { openDb } from "./db.js";
import { indexRef } from "./indexer.js";
import { runEval } from "./eval.js";
import { searchSymbols, formatCards } from "./search.js";
import { changeSummary, formatSummary, formatDiffSymbols } from "./summary.js";
import { diffSymbols } from "./diff.js";
import { coverageGap, formatGap } from "./gap.js";
import { covConfigFromEnv } from "./coverage.js";
import { impactTests, formatImpact, compareDescription, formatDescriptionCheck } from "./impact.js";

const [cmd, ...rest] = process.argv.slice(2);
const DATA = process.env.DATA_DIR ?? "data";
mkdirSync(DATA, { recursive: true });
const dbFile = `${DATA}/index.sqlite`;

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
} else {
  console.error("usage: cli.ts index <repo> [ref] | stats | search <query> [limit] [ref] | eval [file] [ref]");
  process.exit(1);
}
