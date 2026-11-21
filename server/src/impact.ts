import type { Db } from "./db.js";
import { readBlobs, prefetchBlobs } from "./git.js";
import { diffSymbols, type DiffSymbolsResult } from "./diff.js";
import { TEST_RE, moduleOf } from "./summary.js";

export interface ImpactResult {
  method: string;
  testFilesScanned: number;
  tests: { path: string; score: number; matched: string[] }[];
  scenarios: { report: string; file: string; lines: string; category: string | null; status: string | null; description: string }[];
  terms: number;
  caveats: string[];
}

const GENERIC_MAX = 25; // names defined in more than this many places carry no signal

const idCache = new Map<string, Set<string>>();
const identifiersOf = (src: string): Set<string> => new Set(src.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []);

export async function impactTests(db: Db, repo: string, base: string, head: string, opts: { testRe?: RegExp; diff?: DiffSymbolsResult; limit?: number } = {}): Promise<ImpactResult> {
  const diff = opts.diff ?? diffSymbols(db, repo, base, head);
  const testRe = opts.testRe ?? TEST_RE;
  const caveats = ["No per-test coverage exists in the available tools, so this is a lexical guess, not proof of execution."];

  // terms: weight 3 = changed file's class name, weight 1 = changed symbol names that are not generic
  const terms = new Map<string, number>();
  // one scan instead of an index on symbols(name) (the index cost ~14 MB and only this tool needs it)
  const freqMap = new Map((db.prepare("SELECT name, COUNT(*) c FROM symbols GROUP BY name").all() as { name: string; c: number }[]).map((r) => [r.name, r.c]));
  for (const s of diff.symbols) {
    if (testRe.test(s.path) || s.status === "class_level") continue;
    const stem = s.path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
    if (stem.length >= 5) terms.set(stem, Math.max(terms.get(stem) ?? 0, 3));
    const nm = s.symbol.split(".").pop()!;
    if (nm.length < 6 || terms.has(nm)) continue;
    if ((freqMap.get(nm) ?? 0) > GENERIC_MAX) continue;
    terms.set(nm, 1);
  }

  const testPaths = (db.prepare("SELECT path, blob FROM v_manifest WHERE ref=?").all(head) as { path: string; blob: string }[])
    .filter((r) => testRe.test(r.path) && /\.(java|js|mjs|cjs)$/.test(r.path)).slice(0, 5000);
  const need = testPaths.filter((t) => !idCache.has(t.blob));
  if (need.length) {
    await prefetchBlobs(repo, need.map((t) => t.blob));
    const blobs = await readBlobs(repo, [...new Set(need.map((t) => t.blob))]);
    for (const [sha, buf] of blobs) if (buf) idCache.set(sha, identifiersOf(buf.toString("utf8")));
  }
  const hits: ImpactResult["tests"] = [];
  for (const t of testPaths) {
    const ids = idCache.get(t.blob);
    if (!ids) continue;
    const matched = [...terms].filter(([term]) => ids.has(term));
    if (!matched.length) continue;
    hits.push({ path: t.path, score: matched.reduce((a, [, w]) => a + w, 0), matched: matched.map(([m]) => m).slice(0, 6) });
  }
  hits.sort((a, b) => b.score - a.score);
  if (!testPaths.length) caveats.push("No test files matched the test-path pattern in this repo; QA automation likely lives in a separate repo that is not indexed.");
  else if (!hits.length) caveats.push(`Scanned ${testPaths.length} test file(s); none reference the changed identifiers.`);

  // QA scenario text attached to overlapping lines in previously ingested reports
  const scenarios: ImpactResult["scenarios"] = [];
  const q = db.prepare("SELECT report,file,sl,el,category,status,description FROM cov_case WHERE file=? AND description IS NOT NULL AND sl<=? AND el>=?");
  for (const s of diff.symbols) {
    if (s.status === "removed") continue;
    for (const r of q.all(s.path, s.el, s.sl) as { report: string; file: string; sl: number; el: number; category: string | null; status: string | null; description: string }[]) {
      scenarios.push({ report: r.report, file: r.file, lines: `${r.sl}-${r.el}`, category: r.category, status: r.status, description: r.description.slice(0, 200) });
    }
  }
  const seen = new Set<string>();
  const uniq = scenarios.filter((x) => { const k = `${x.report}|${x.file}|${x.lines}|${x.description}`; if (seen.has(k)) return false; seen.add(k); return true; });
  scenarios.length = 0; scenarios.push(...uniq);
  if (scenarios.length) caveats.push("Scenarios come from earlier coverage reports; their line numbers refer to that report's commit and may have drifted.");

  return { method: "lexical identifier match in repo test files + QA scenario text from ingested reports", testFilesScanned: testPaths.length, tests: hits.slice(0, opts.limit ?? 15), scenarios: scenarios.slice(0, 10), terms: terms.size, caveats };
}

export function formatImpact(r: ImpactResult): string {
  const L = [`impact_tests  method: ${r.method}`, `scanned ${r.testFilesScanned} test files against ${r.terms} identifiers`];
  if (r.tests.length) { L.push("likely-affected tests:"); for (const t of r.tests) L.push(`  ${t.score}  ${t.path}  [${t.matched.join(", ")}]`); } else L.push("likely-affected tests: none found");
  if (r.scenarios.length) { L.push("QA scenarios on overlapping lines:"); for (const s of r.scenarios) L.push(`  [${s.report}] ${s.file.replace(/^.*\//, "")}:${s.lines}${s.status ? ` (${s.status})` : ""} ${s.description}`); }
  for (const c of r.caveats) L.push(`note: ${c}`);
  return L.join("\n");
}

// ---------- description vs diff ----------
export interface DescriptionCheck { mentionedAndChanged: string[]; mentionedNotFound: string[]; changedNotMentioned: string[] }

const WORD_STOP = new Set("this that with from have been will were which when then than into also should would could about after before other these those their there where while using used uses added adds fixed fixes removed update updated updates change changed changes support supports issue issues field fields module modules value values data".split(" "));

export function compareDescription(diff: DiffSymbolsResult, description: string): DescriptionCheck {
  const idLike = [...new Set(description.match(/[A-Za-z_$][A-Za-z0-9_$.]{3,}/g) ?? [])].map((t) => t.replace(/[.]+$/, ""))
    .filter((t) => /[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]|\./.test(t) || /^[A-Z][A-Za-z0-9]{4,}$/.test(t));
  const bag = new Set<string>();
  for (const s of diff.symbols) { for (const p of s.symbol.split(".")) bag.add(p.toLowerCase()); for (const p of s.path.toLowerCase().split(/[\/.]/)) bag.add(p); }
  for (const f of diff.files) for (const p of f.path.toLowerCase().split(/[\/.]/)) bag.add(p);
  const found: string[] = [], missing: string[] = [];
  for (const t of idLike) (t.toLowerCase().split(".").some((p) => bag.has(p)) ? found : missing).push(t);

  const descWords = new Set((description.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !WORD_STOP.has(w)));
  const descCompact = description.toLowerCase().replace(/[^a-z0-9]/g, "");
  const mods = new Map<string, number>();
  for (const f of diff.files) { const m = moduleOf(f.path); mods.set(m, (mods.get(m) ?? 0) + 1); }
  const notMentioned: string[] = [];
  for (const [m, n] of [...mods].sort((a, b) => b[1] - a[1])) {
    const parts = m.split("/").slice(1).map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((p) => p.length >= 4);
    const hit = parts.some((p) => descCompact.includes(p) || descCompact.includes(p.slice(0, Math.max(5, p.length - 2))) || [...descWords].some((w) => p.includes(w) || w.includes(p)));
    if (!hit) notMentioned.push(`${m} (${n} files)`);
  }
  return { mentionedAndChanged: found, mentionedNotFound: missing, changedNotMentioned: notMentioned.slice(0, 10) };
}

export function formatDescriptionCheck(c: DescriptionCheck): string {
  return [
    "compare_description (heuristic; verify manually)",
    `named in description AND present in diff: ${c.mentionedAndChanged.join(", ") || "none"}`,
    `named in description but NOT found in diff: ${c.mentionedNotFound.join(", ") || "none"}`,
    `modules changed but not mentioned: ${c.changedNotMentioned.join("; ") || "none"}`,
  ].join("\n");
}
