import { execFileSync } from "node:child_process";
import type { Db } from "./db.js";
import { diffSymbols, gitRefOf, type DiffSymbolsResult } from "./diff.js";
import { ensureReady } from "./branches.js";
import { commitGate, ingestJsReport, javaPackageOf, jacocoFileLines, type CovConfig, type Gate, type LineState } from "./coverage.js";

export type GapKind = "jacoco" | "js";
type Bucket = "covered" | "partial" | "missed" | "qa_covered" | "qa_waived" | "inferred" | "not_in_report" | "unverifiable";

export interface FileGap {
  path: string; counts: Record<Bucket, number>; missedLines: number[]; note?: string;
}
export interface SymbolGap { symbol: string; path: string; sl: number; el: number; changed: number; missed: number; partial: number; missedRanges: string; qaStatus: string }
export interface GapResult {
  kind: GapKind; report: string; base: string; head: string; reportBranch: string | null; gate: Gate;
  totals: Record<Bucket, number>; files: FileGap[]; symbols: SymbolGap[]; filesSkipped: string[];
  crossCheck?: { toolMissedLines: number; toolMissedInDiff: number; toolMissedOutsideDiff: number; samples: string[] };
  notes: string[];
}

const emptyCounts = (): Record<Bucket, number> => ({ covered: 0, partial: 0, missed: 0, qa_covered: 0, qa_waived: 0, inferred: 0, not_in_report: 0, unverifiable: 0 });

export function ranges(lines: number[]): string {
  const s = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(s[i] === s[j] ? `${s[i]}` : `${s[i]}-${s[j]}`); i = j + 1; }
  return out.join(",");
}

/** Pure: classify changed lines of one file. covMap=null means "file not in report". */
export function classifyLines(kind: GapKind, changed: number[], covMap: Map<number, LineState> | null): { counts: Record<Bucket, number>; byLine: Map<number, Bucket> } {
  const counts = emptyCounts();
  const byLine = new Map<number, Bucket>();
  for (const l of changed) {
    let b: Bucket | null;
    if (kind === "jacoco") {
      if (!covMap) b = "not_in_report";
      else { const st = covMap.get(l); b = st ?? null; } // no span => non-executable line (comment, brace, declaration): ignored
    } else {
      const st = covMap?.get(l);
      b = st ?? "inferred"; // JS report lists only missed ranges: absence is NOT proof of coverage
    }
    if (!b) continue;
    counts[b]++; byLine.set(l, b);
  }
  return { counts, byLine };
}

const showBlob = (repo: string, branch: string, path: string): string => {
  try { return execFileSync("git", ["-C", repo, "show", `${gitRefOf(branch)}:${path}`], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

export async function coverageGap(db: Db, repo: string, cfg: CovConfig, a: { base: string; head: string; kind: GapKind; report: string; reportCommit?: string; atReportCommit?: boolean; diff?: DiffSymbolsResult }): Promise<GapResult> {
  const notes: string[] = [];
  const ext = a.kind === "jacoco" ? /\.java$/ : /\.(js|mjs|cjs)$/;

  let reportCommit = a.reportCommit ?? null, reportBranch: string | null = null;
  if (a.kind === "js") {
    const meta = await ingestJsReport(db, cfg, a.report);
    reportBranch = meta.branch; reportCommit = reportCommit ?? meta.commit;
  } else {
    const r = db.prepare("SELECT branch,commit_sha FROM cov_report WHERE id=?").get(a.report) as { branch: string; commit_sha: string } | undefined;
    reportBranch = r?.branch ?? null; reportCommit = reportCommit ?? r?.commit_sha ?? null;
  }
  let head = a.head;
  if (a.atReportCommit) {
    if (!reportCommit) notes.push("at_report_commit requested but the report has no commit; using the branch head.");
    else { head = `commit:${reportCommit}`; notes.push(`evaluated at the report's commit ${reportCommit.slice(0, 10)} instead of the current tip of ${a.head}.`); }
  }
  await ensureReady(db, repo, a.base);
  await ensureReady(db, repo, head);
  const diff = a.diff ?? diffSymbols(db, repo, a.base, head);
  const paths = [...diff.changedLinesByPath.keys()].filter((p) => ext.test(p));
  const gate = commitGate(repo, reportCommit, head, paths);
  if (gate.state === "unknown") notes.push(`commit gate: ${gate.reason}. Results assume the report matches head; verify manually.`);
  if (gate.state === "differs") notes.push(`${gate.differing.size} changed file(s) differ between the report's commit and head; those are excluded (unverifiable).`);

  const totals = emptyCounts();
  const files: FileGap[] = [];
  const byLineAll = new Map<string, Map<number, Bucket>>();
  const filesSkipped: string[] = [];

  for (const p of paths) {
    const changed = diff.changedLinesByPath.get(p) ?? [];
    if (!changed.length) continue;
    if (gate.differing.has(p)) {
      const counts = emptyCounts(); counts.unverifiable = changed.length; totals.unverifiable += changed.length;
      files.push({ path: p, counts, missedLines: [], note: "file differs between report commit and head" }); filesSkipped.push(p);
      continue;
    }
    let covMap: Map<number, LineState> | null = null; let note: string | undefined;
    if (a.kind === "jacoco") {
      const res = await jacocoFileLines(db, cfg, a.report, p, showBlob(repo, head, p));
      covMap = res.lines; note = res.note;
    } else {
      const rows = db.prepare("SELECT line,state FROM cov_line WHERE report=? AND file=?").all(a.report, p) as { line: number; state: LineState }[];
      covMap = new Map(rows.map((r) => [r.line, r.state]));
    }
    const { counts, byLine } = classifyLines(a.kind, changed, covMap);
    for (const k of Object.keys(counts) as Bucket[]) totals[k] += counts[k];
    byLineAll.set(p, byLine);
    files.push({ path: p, counts, missedLines: [...byLine].filter(([, b]) => b === "missed").map(([l]) => l), note });
  }

  const symbols: SymbolGap[] = [];
  for (const s of diff.symbols) {
    const by = byLineAll.get(s.path);
    if (!by || !s.lines.length) continue;
    const considered = s.lines.filter((l) => by.has(l));
    if (!considered.length) continue;
    const missed = considered.filter((l) => by.get(l) === "missed");
    const partial = considered.filter((l) => by.get(l) === "partial");
    const qa = new Set(considered.map((l) => by.get(l)).filter((b) => b === "qa_covered" || b === "qa_waived"));
    symbols.push({ symbol: s.symbol, path: s.path, sl: s.sl, el: s.el, changed: considered.length, missed: missed.length, partial: partial.length, missedRanges: ranges(missed), qaStatus: [...qa].join("+") });
  }
  symbols.sort((x, y) => y.missed - x.missed || y.partial - x.partial);

  let crossCheck: GapResult["crossCheck"];
  if (a.kind === "js") {
    const rows = db.prepare("SELECT file,line FROM cov_line WHERE report=? AND state IN ('missed','qa_covered','qa_waived')").all(a.report) as { file: string; line: number }[];
    const changedSet = new Map<string, Set<number>>();
    for (const [p, ls] of diff.changedLinesByPath) changedSet.set(p, new Set(ls));
    const outside = new Map<string, number[]>();
    let inDiff = 0;
    for (const r of rows) { if (changedSet.get(r.file)?.has(r.line)) inDiff++; else { if (!outside.has(r.file)) outside.set(r.file, []); outside.get(r.file)!.push(r.line); } }
    crossCheck = { toolMissedLines: rows.length, toolMissedInDiff: inDiff, toolMissedOutsideDiff: rows.length - inDiff, samples: [...outside].slice(0, 4).map(([f, ls]) => `${f.replace(/^.*\//, "")}: ${ranges(ls).slice(0, 60)}`) };
    if (crossCheck.toolMissedOutsideDiff > 0) notes.push(`${crossCheck.toolMissedOutsideDiff} of the tool's ${crossCheck.toolMissedLines} missed lines are outside this diff (different base/changeset than ${a.base}...${a.head}, or shifted line numbers).`);
  }
  if (a.kind === "js") notes.push("JS report lists only missed ranges: 'inferred' lines are NOT confirmed covered (comments/blank lines included).");
  if (a.kind === "jacoco") notes.push("Java: lines without a JaCoCo span are non-executable and excluded.");

  return { kind: a.kind, report: a.report, base: a.base, head: a.head === head ? a.head : `${a.head}@${head.slice(7, 17)}`, reportBranch, gate, totals, files, symbols, filesSkipped, crossCheck, notes };
}

export function formatGap(r: GapResult, maxSyms = 15): string {
  const t = r.totals;
  const exec = t.covered + t.partial + t.missed + t.qa_covered + t.qa_waived;
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
  const L: string[] = [];
  L.push(`coverage_gap ${r.head} vs ${r.base} | ${r.kind} report ${r.report}${r.reportBranch ? ` (branch ${r.reportBranch})` : ""}`);
  L.push(`commit gate: ${r.gate.state}${r.gate.reportCommit ? ` report=${r.gate.reportCommit.slice(0, 10)} head=${r.gate.headCommit?.slice(0, 10)}` : ""}${r.gate.relation ? ` (${r.gate.relation})` : ""}`);
  if (r.kind === "jacoco") {
    L.push(`changed executable lines: ${exec}  covered ${t.covered} (${pct(t.covered, exec)})  partial ${t.partial}  MISSED ${t.missed}${t.not_in_report ? `  not-in-report ${t.not_in_report}` : ""}${t.unverifiable ? `  unverifiable ${t.unverifiable}` : ""}`);
  } else {
    L.push(`tool-missed changed lines: ${t.missed + t.qa_covered + t.qa_waived} (unresolved ${t.missed}, QA-marked covered ${t.qa_covered}, QA waived ${t.qa_waived}); inferred-ok ${t.inferred}${t.unverifiable ? `; unverifiable ${t.unverifiable}` : ""}`);
  }
  const worst = r.symbols.filter((s) => s.missed || s.partial).slice(0, maxSyms);
  if (worst.length) {
    L.push("uncovered changed symbols:");
    for (const s of worst) L.push(`  ${s.symbol}  ${s.path.replace(/^.*\//, "")}:${s.sl}-${s.el}  changed=${s.changed} missed=${s.missed}${s.partial ? ` partial=${s.partial}` : ""} lines ${s.missedRanges.slice(0, 80)}${s.qaStatus ? ` [${s.qaStatus}]` : ""}`);
    if (r.symbols.filter((s) => s.missed || s.partial).length > worst.length) L.push(`  ... ${r.symbols.filter((s) => s.missed || s.partial).length - worst.length} more`);
  } else L.push("no uncovered changed symbols found.");
  if (r.crossCheck) L.push(`cross-check vs tool: tool missed ${r.crossCheck.toolMissedLines}, inside diff ${r.crossCheck.toolMissedInDiff}, outside ${r.crossCheck.toolMissedOutsideDiff}${r.crossCheck.samples.length ? ` e.g. ${r.crossCheck.samples.join(" | ")}` : ""}`);
  for (const n of r.notes) L.push(`note: ${n}`);
  return L.join("\n");
}
