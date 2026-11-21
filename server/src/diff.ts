import type { Db } from "./db.js";
import { unpackText } from "./db.js";
import { execFileSync } from "node:child_process";

const gitOut = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 1 << 29, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** Branch label -> git ref. Labels "commit:<sha>" address an exact commit (used to evaluate coverage at the report's commit). */
export const gitRefOf = (label: string) => (label.startsWith("commit:") ? label.slice(7) : `refs/remotes/origin/${label}`);

export interface FileChange { status: string; path: string; oldPath: string | null }
export interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number }
export interface FileDiff { oldPath: string | null; newPath: string | null; hunks: Hunk[] }

/** All changed files between merge-base(base,head) and head. */
export function changedFiles(repo: string, base: string, head: string): FileChange[] {
  const out = gitOut(repo, ["diff", "--name-status", "-M", "-z", `${gitRefOf(base)}...${gitRefOf(head)}`]);
  const parts = out.split("\0").filter((x) => x !== "");
  const res: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    if (st.startsWith("R") || st.startsWith("C")) { res.push({ status: st[0], oldPath: parts[i], path: parts[i + 1] }); i += 2; }
    else { res.push({ status: st[0], path: parts[i], oldPath: st === "A" ? null : parts[i] }); i += 1; }
  }
  return res;
}

export function parseUnifiedZero(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = { oldPath: null, newPath: null, hunks: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith("--- ")) { const p = line.slice(4); cur.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, ""); continue; }
    if (line.startsWith("+++ ")) { const p = line.slice(4); cur.newPath = p === "/dev/null" ? null : p.replace(/^b\//, ""); continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) cur.hunks.push({ oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4] });
  }
  // pure renames have no ---/+++ lines; they carry no hunks, so they are ignored for line mapping
  return files.filter((f) => f.hunks.length);
}

export function lineDiffs(repo: string, base: string, head: string, pathspecs: string[]): FileDiff[] {
  const out = gitOut(repo, ["diff", "-U0", "-M", "--no-color", `${gitRefOf(base)}...${gitRefOf(head)}`, "--", ...pathspecs]);
  return parseUnifiedZero(out);
}

/** New-side line numbers touched by hunks (additions/modifications), plus anchors for pure deletions. */
export function newSideLines(hunks: Hunk[]): { lines: number[]; deletionAnchors: number[] } {
  const lines: number[] = [], anchors: number[] = [];
  for (const h of hunks) {
    if (h.newCount > 0) for (let i = 0; i < h.newCount; i++) lines.push(h.newStart + i);
    else anchors.push(h.newStart);
  }
  return { lines, deletionAnchors: anchors };
}
export function oldSideLines(hunks: Hunk[]): number[] {
  const out: number[] = [];
  for (const h of hunks) for (let i = 0; i < h.oldCount; i++) out.push(h.oldStart + i);
  return out;
}

export interface SymRow { id: number; kind: string; parent: string; name: string; sig: string; sl: number; el: number }
const TYPE_KINDS = new Set(["class", "interface", "enum", "record", "annotation_type"]);

export function symbolsAt(db: Db, ref: string, path: string | null): SymRow[] {
  if (!path) return [];
  return (db.prepare("SELECT s.id,s.kind,s.parent,s.name,s.sig,s.sl,s.el FROM v_manifest m JOIN symbols s ON s.blob_id=m.blob_id WHERE m.ref=? AND m.path=? ORDER BY s.sl").all(ref, path) as SymRow[]).map((r) => ({ ...r, sig: unpackText(r.sig) }));
}

/** Innermost symbol containing line: prefer members over their enclosing type. Type-only hit => class-level code (fields/constants). */
export function innermost(syms: SymRow[], line: number): { sym: SymRow; classLevel: boolean } | null {
  let best: SymRow | null = null;
  for (const s of syms) {
    if (line < s.sl || line > s.el) continue;
    if (!best || s.el - s.sl < best.el - best.sl) best = s;
  }
  return best ? { sym: best, classLevel: TYPE_KINDS.has(best.kind) } : null;
}

const keyOf = (s: SymRow) => `${s.parent}.${s.name}|${s.sig.replace(/\s+/g, "")}`;
export const qname = (s: SymRow) => (s.parent ? `${s.parent}.${s.name}` : s.name);

export interface ChangedSymbol {
  status: "added" | "modified" | "removed" | "class_level";
  kind: string; symbol: string; path: string; sl: number; el: number; sig: string; changedLines: number; lines: number[];
}

export interface DiffSymbolsResult {
  files: FileChange[]; symbols: ChangedSymbol[];
  /** changed head-side lines per path (all file types), for coverage mapping */
  changedLinesByPath: Map<string, number[]>;
}

const CODE = /\.(java|js|mjs|cjs)$/;

export function diffSymbols(db: Db, repo: string, base: string, head: string, revisions?: { base: string; head: string }): DiffSymbolsResult {
  const gitBase = revisions ? `commit:${revisions.base}` : base;
  const gitHead = revisions ? `commit:${revisions.head}` : head;
  const files = changedFiles(repo, gitBase, gitHead);
  const codePaths = files.filter((f) => CODE.test(f.path) || (f.oldPath && CODE.test(f.oldPath))).flatMap((f) => (f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]));
  const diffs = codePaths.length ? lineDiffs(repo, gitBase, gitHead, [...new Set(codePaths)]) : [];
  const symbols: ChangedSymbol[] = [];
  const changedLinesByPath = new Map<string, number[]>();

  for (const d of diffs) {
    const headSyms = symbolsAt(db, head, d.newPath);
    const baseSyms = symbolsAt(db, base, d.oldPath);
    const baseKeys = new Set(baseSyms.map(keyOf));
    const headKeys = new Set(headSyms.map(keyOf));
    const { lines, deletionAnchors } = newSideLines(d.hunks);
    if (d.newPath) changedLinesByPath.set(d.newPath, lines);

    const touched = new Map<number, { s: SymRow; lines: Set<number>; classLevel: boolean }>();
    const touch = (line: number, count = true) => {
      const hit = innermost(headSyms, line);
      if (!hit) return;
      const t = touched.get(hit.sym.id) ?? { s: hit.sym, lines: new Set<number>(), classLevel: hit.classLevel };
      if (count) t.lines.add(line);
      touched.set(hit.sym.id, t);
    };
    for (const l of lines) touch(l);
    for (const a of deletionAnchors) { touch(a, false); touch(a + 1, false); }

    for (const { s, lines: ls, classLevel } of touched.values()) {
      const existed = baseKeys.has(keyOf(s));
      symbols.push({
        status: classLevel ? "class_level" : existed ? "modified" : "added",
        kind: s.kind, symbol: qname(s), path: d.newPath!, sl: s.sl, el: s.el, sig: s.sig, changedLines: ls.size, lines: [...ls].sort((a, b) => a - b),
      });
    }
    // removed: base symbols touched by deleted/changed old lines whose identity no longer exists in head
    const oldLines = oldSideLines(d.hunks);
    const removed = new Map<number, SymRow>();
    for (const l of oldLines) {
      const hit = innermost(baseSyms, l);
      if (hit && !hit.classLevel && !headKeys.has(keyOf(hit.sym))) removed.set(hit.sym.id, hit.sym);
    }
    for (const s of removed.values()) symbols.push({ status: "removed", kind: s.kind, symbol: qname(s), path: d.oldPath!, sl: s.sl, el: s.el, sig: s.sig, changedLines: 0, lines: [] });
  }
  // also record line sets for non-code changed files (for coverage of other types) - none needed now
  return { files, symbols, changedLinesByPath };
}
