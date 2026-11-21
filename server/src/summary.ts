import type { Db } from "./db.js";
import { execFileSync } from "node:child_process";
import { diffSymbols, gitRefOf, type ChangedSymbol, type DiffSymbolsResult } from "./diff.js";

export const TEST_RE = /(^|\/)(test|tests|__tests__)\/|(Test|Tests|TestCase|IT)\.java$|\.(spec|test)\.[mc]?js$/;

export function moduleOf(path: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^source\/com\/adventnet\/crm\/(\w+)(?:\/(\w+))?\//.exec(path))) return `crm/${m[1]}${m[2] ? "/" + m[2] : ""}`;
  if ((m = /^source\/com\/zoho\/(\w+)(?:\/(\w+))?\//.exec(path))) return `zoho/${m[1]}${m[2] ? "/" + m[2] : ""}`;
  if ((m = /^webapps\/zohocrm\/CRMClient\/(\w[\w-]*)(?:\/(\w[\w-]*))?\//.exec(path))) return `client/${m[1]}${m[2] ? "/" + m[2] : ""}`;
  if ((m = /^webapps\/zohocrm\/(\w[\w-]*)\//.exec(path))) return `web/${m[1]}`;
  return path.split("/").slice(0, 3).join("/");
}

export interface Summary {
  base: string; head: string;
  commits: { sha: string; subject: string }[]; commitsTotal: number;
  files: { total: number; byStatus: Record<string, number>; byType: Record<string, number> };
  modules: { module: string; files: number; symbols: number }[];
  symbols: { added: number; modified: number; removed: number; classLevel: number };
  publicApi: { added: string[]; removed: string[] };
  testsTouched: string[];
  topSymbols: { symbol: string; path: string; status: string; changedLines: number }[];
  diff: DiffSymbolsResult;
}

const extOf = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? "none").toLowerCase();
const isPublicJava = (s: ChangedSymbol) => s.path.endsWith(".java") && /\bpublic\b/.test(s.sig) && s.kind !== "constructor";

export function changeSummary(db: Db, repo: string, base: string, head: string): Summary {
  const diff = diffSymbols(db, repo, base, head);
  const log = execFileSync("git", ["-C", repo, "log", "--format=%h%x09%s", "-n", "60", `${gitRefOf(base)}..${gitRefOf(head)}`], { encoding: "utf8", maxBuffer: 1 << 26 });
  const total = Number(execFileSync("git", ["-C", repo, "rev-list", "--count", `${gitRefOf(base)}..${gitRefOf(head)}`], { encoding: "utf8" }).trim());
  const commits = log.split("\n").filter(Boolean).map((l) => { const [sha, ...r] = l.split("\t"); return { sha, subject: r.join("\t").slice(0, 140) }; });

  const byStatus: Record<string, number> = {}, byType: Record<string, number> = {};
  const modFiles = new Map<string, Set<string>>(), modSyms = new Map<string, number>();
  for (const f of diff.files) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    byType[extOf(f.path)] = (byType[extOf(f.path)] ?? 0) + 1;
    const m = moduleOf(f.path);
    if (!modFiles.has(m)) modFiles.set(m, new Set());
    modFiles.get(m)!.add(f.path);
  }
  const count = { added: 0, modified: 0, removed: 0, classLevel: 0 };
  for (const s of diff.symbols) {
    if (s.status === "class_level") count.classLevel++; else count[s.status]++;
    const m = moduleOf(s.path);
    modSyms.set(m, (modSyms.get(m) ?? 0) + 1);
  }
  const pub = { added: [] as string[], removed: [] as string[] };
  for (const s of diff.symbols) {
    if (!isPublicJava(s)) continue;
    if (s.status === "added") pub.added.push(`${s.symbol}  ${s.sig.slice(0, 100)}`);
    if (s.status === "removed") pub.removed.push(`${s.symbol}  ${s.sig.slice(0, 100)}`);
  }
  return {
    base, head, commits, commitsTotal: total,
    files: { total: diff.files.length, byStatus, byType },
    modules: [...modFiles.entries()].map(([module, fs]) => ({ module, files: fs.size, symbols: modSyms.get(module) ?? 0 })).sort((a, b) => b.files - a.files),
    symbols: count, publicApi: pub,
    testsTouched: diff.files.filter((f) => TEST_RE.test(f.path)).map((f) => f.path),
    topSymbols: [...diff.symbols].sort((a, b) => b.changedLines - a.changedLines).slice(0, 10).map((s) => ({ symbol: s.symbol, path: s.path, status: s.status, changedLines: s.changedLines })),
    diff,
  };
}

const short = (p: string) => p.replace(/^webapps\/zohocrm\//, "~/").replace(/^source\/com\/adventnet\/crm\//, "crm/");

export function formatSummary(s: Summary, maxList = 12): string {
  const L: string[] = [];
  L.push(`${s.head} vs ${s.base}: ${s.commitsTotal} commits, ${s.files.total} files (${Object.entries(s.files.byStatus).map(([k, v]) => `${k}:${v}`).join(" ")}) types: ${Object.entries(s.files.byType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  L.push(`symbols: +${s.symbols.added} added, ~${s.symbols.modified} modified, -${s.symbols.removed} removed, ${s.symbols.classLevel} class-level edits (fields/constants/imports)`);
  L.push(`modules (${s.modules.length}):`);
  for (const m of s.modules.slice(0, maxList)) L.push(`  ${m.module}  files=${m.files} symbols=${m.symbols}`);
  if (s.publicApi.added.length || s.publicApi.removed.length) {
    L.push(`public Java API: +${s.publicApi.added.length} / -${s.publicApi.removed.length}`);
    for (const a of s.publicApi.added.slice(0, maxList)) L.push(`  + ${a}`);
    for (const a of s.publicApi.removed.slice(0, maxList)) L.push(`  - ${a}`);
  }
  L.push(s.testsTouched.length ? `tests touched (${s.testsTouched.length}): ${s.testsTouched.slice(0, 5).map(short).join(", ")}` : "tests touched: none");
  L.push("largest changes:");
  for (const t of s.topSymbols) L.push(`  ${t.status} ${t.symbol} (${t.changedLines} lines) ${short(t.path)}`);
  L.push(`commits${s.commitsTotal > s.commits.length ? ` (latest ${s.commits.length} of ${s.commitsTotal})` : ""}:`);
  for (const c of s.commits.slice(0, 15)) L.push(`  ${c.sha} ${c.subject}`);
  return L.join("\n");
}

export function formatDiffSymbols(d: DiffSymbolsResult, limit = 60): string {
  const order = { added: 0, modified: 1, removed: 2, class_level: 3 } as const;
  const syms = [...d.symbols].sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path) || a.sl - b.sl);
  const out = syms.slice(0, limit).map((s) => `${s.status.padEnd(11)} ${s.symbol}  ${short(s.path)}:${s.sl}-${s.el}${s.changedLines ? `  (${s.changedLines} lines)` : ""}`);
  const nonCode = d.files.filter((f) => !/\.(java|js|mjs|cjs)$/.test(f.path)).length;
  return `${syms.length} changed symbols in ${new Set(syms.map((s) => s.path)).size} code files; ${nonCode} non-code files changed\n${out.join("\n")}${syms.length > limit ? `\n... ${syms.length - limit} more` : ""}`;
}
