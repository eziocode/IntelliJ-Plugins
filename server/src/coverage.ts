import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Db } from "./db.js";
import { gitRefOf } from "./diff.js";

export interface CovConfig {
  jacocoBase: string;      // e.g. http://host:8085/Report/Report_CodeCoverage_   (reportId + /pkg/Class.java.html appended)
  jsBase: string;          // e.g. https://host   (project + report appended)
  jsProject: string;
  jsCookie: string;
  jsToken: string;
  fixtureDir: string;
}

export const covConfigFromEnv = (): CovConfig => ({
  jacocoBase: process.env.COVERAGE_JACOCO_BASE ?? "",
  jsBase: (process.env.COVERAGE_JS_BASE ?? "").replace(/\/$/, ""),
  jsProject: process.env.COVERAGE_JS_PROJECT ?? "",
  jsCookie: process.env.COVERAGE_JS_COOKIE ?? "",
  jsToken: process.env.COVERAGE_JS_TOKEN ?? "",
  fixtureDir: process.env.COVERAGE_FIXTURE_DIR ?? "",
});

export type LineState = "covered" | "partial" | "missed" | "qa_covered" | "qa_waived";

// ---------- JaCoCo (Java) ----------
export function parseJacocoHtml(html: string): Map<number, LineState> {
  const out = new Map<number, LineState>();
  for (const m of html.matchAll(/<span class="(fc|pc|nc)(?: [a-z]+)?" id="L(\d+)"/g)) {
    out.set(Number(m[2]), m[1] === "fc" ? "covered" : m[1] === "pc" ? "partial" : "missed");
  }
  return out;
}

export function javaPackageOf(source: string): string {
  return /^\s*package\s+([\w.]+)\s*;/m.exec(source)?.[1] ?? "";
}

async function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const r = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  return { status: r.status, text: await r.text() };
}

const now = () => new Date().toISOString();

/** Cached per (report,file). Returns null when the class is not in the report (404). */
export async function jacocoFileLines(db: Db, cfg: CovConfig, reportId: string, repoPath: string, source: string): Promise<{ lines: Map<number, LineState> | null; note?: string }> {
  const cached = db.prepare("SELECT status FROM cov_file WHERE report=? AND file=?").get(reportId, repoPath) as { status: string } | undefined;
  if (cached) {
    if (cached.status !== "ok") return { lines: null, note: cached.status };
    const rows = db.prepare("SELECT line,state FROM cov_line WHERE report=? AND file=?").all(reportId, repoPath) as { line: number; state: LineState }[];
    return { lines: new Map(rows.map((r) => [r.line, r.state])) };
  }
  if (!cfg.jacocoBase) return { lines: null, note: "COVERAGE_JACOCO_BASE not configured" };
  const pkg = javaPackageOf(source);
  const cls = repoPath.replace(/^.*\//, "");
  const url = `${cfg.jacocoBase}${reportId}/${pkg}/${cls}.html`;
  let res;
  try { res = await httpGet(url); } catch (e) { return { lines: null, note: `fetch failed: ${(e as Error).message}` }; }
  if (res.status === 404) { db.prepare("INSERT OR REPLACE INTO cov_file VALUES (?,?,?,?)").run(reportId, repoPath, "absent", now()); return { lines: null, note: "absent" }; }
  if (res.status !== 200) return { lines: null, note: `http ${res.status}` };
  const lines = parseJacocoHtml(res.text);
  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO cov_file VALUES (?,?,?,?)").run(reportId, repoPath, "ok", now());
    const ins = db.prepare("INSERT OR REPLACE INTO cov_line VALUES (?,?,?,?)");
    for (const [l, st] of lines) ins.run(reportId, repoPath, l, st);
  })();
  return { lines };
}

// ---------- JS coverage API ----------
interface JsCase { file: string; start: number; end: number; category?: string; status?: string | null; description?: string; commits?: { commit_id?: string }[] }
export interface JsReportMeta { branch: string | null; commit: string | null; build: string | null; total: number }

async function jsJson(cfg: CovConfig, reportId: string, suffix: string): Promise<any> {
  const fx = cfg.fixtureDir ? `${cfg.fixtureDir}/js_${reportId}${suffix ? "_" + suffix.slice(1) : "_report"}.json` : "";
  if (fx && existsSync(fx)) return JSON.parse(readFileSync(fx, "utf8"));
  if (!cfg.jsBase || !cfg.jsProject) throw new Error("COVERAGE_JS_BASE / COVERAGE_JS_PROJECT not configured (and no fixture found)");
  const headers: Record<string, string> = {};
  if (cfg.jsCookie) headers.cookie = cfg.jsCookie;
  if (cfg.jsToken) headers.authorization = `Bearer ${cfg.jsToken}`;
  const r = await httpGet(`${cfg.jsBase}/api/coverage/${cfg.jsProject}/report/${reportId}${suffix}`, headers);
  if (r.status === 401 || r.status === 403) throw new Error(`coverage API auth failed (${r.status}); set COVERAGE_JS_COOKIE or COVERAGE_JS_TOKEN`);
  if (r.status !== 200) throw new Error(`coverage API http ${r.status}`);
  return JSON.parse(r.text);
}

export async function ingestJsReport(db: Db, cfg: CovConfig, reportId: string, force = false): Promise<JsReportMeta> {
  const have = db.prepare("SELECT branch,commit_sha,meta FROM cov_report WHERE id=? AND kind='js'").get(reportId) as { branch: string; commit_sha: string; meta: string } | undefined;
  if (have && !force) return { branch: have.branch, commit: have.commit_sha, ...JSON.parse(have.meta) };
  const head = await jsJson(cfg, reportId, "");
  const caseJ = await jsJson(cfg, reportId, "/case");
  const cr = head.report?.coverage_report ?? head.coverage ?? {};
  const ic = cr.impact_coverage ?? {};
  const cases: JsCase[] = caseJ.report?.cases ?? [];
  const meta: JsReportMeta = { branch: ic.branch ?? null, commit: ic.end_changeset || null, build: cr.build_label ?? null, total: cases.length };
  db.transaction(() => {
    db.prepare("DELETE FROM cov_line WHERE report=?").run(reportId);
    db.prepare("DELETE FROM cov_case WHERE report=?").run(reportId);
    db.prepare("DELETE FROM cov_file WHERE report=?").run(reportId);
    db.prepare("INSERT OR REPLACE INTO cov_report VALUES (?,?,?,?,?,?)").run(reportId, "js", meta.branch, meta.commit, now(), JSON.stringify({ build: meta.build, total: meta.total }));
    const insL = db.prepare("INSERT OR REPLACE INTO cov_line VALUES (?,?,?,?)");
    const insC = db.prepare("INSERT INTO cov_case VALUES (?,?,?,?,?,?,?,?)");
    const insF = db.prepare("INSERT OR IGNORE INTO cov_file VALUES (?,?,?,?)");
    for (const c of cases) {
      const st: LineState = c.status === "Covered" ? "qa_covered" : c.status === "No Need To Cover" ? "qa_waived" : "missed";
      insF.run(reportId, c.file, "ok", now());
      for (let l = c.start; l <= c.end; l++) insL.run(reportId, c.file, l, st);
      insC.run(reportId, c.file, c.start, c.end, c.category ?? null, c.status ?? null, c.description ?? null, JSON.stringify((c.commits ?? []).map((x) => x.commit_id)));
    }
  })();
  return meta;
}

// ---------- commit gate ----------
export interface Gate {
  state: "match" | "files_identical" | "differs" | "unknown";
  reportCommit: string | null; headCommit: string | null; relation?: string;
  differing: Set<string>; reason?: string;
}

const g = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const tryG = (repo: string, args: string[]) => { try { return g(repo, args); } catch { return null; } };

export function commitGate(repo: string, reportCommit: string | null, headBranch: string, paths: string[]): Gate {
  const headCommit = tryG(repo, ["rev-parse", "--verify", `${gitRefOf(headBranch)}^{commit}`]);
  if (!reportCommit) return { state: "unknown", reportCommit, headCommit, differing: new Set(), reason: "report has no commit; pass report_commit" };
  let rc = tryG(repo, ["rev-parse", "--verify", `${reportCommit}^{commit}`]);
  if (!rc) { tryG(repo, ["fetch", "--no-tags", "--quiet", "origin", reportCommit]); rc = tryG(repo, ["rev-parse", "--verify", `${reportCommit}^{commit}`]); }
  if (!rc) return { state: "unknown", reportCommit, headCommit, differing: new Set(), reason: `report commit ${reportCommit.slice(0, 10)} not found in mirror` };
  if (rc === headCommit) return { state: "match", reportCommit: rc, headCommit, differing: new Set() };
  const relation = headCommit && tryG(repo, ["merge-base", "--is-ancestor", rc, headCommit]) !== null ? "report commit is an ancestor of head" : "report commit is not an ancestor of head (diverged or newer)";
  const differing = new Set<string>();
  for (const p of paths) {
    const a = tryG(repo, ["rev-parse", `${rc}:${p}`]);
    const b = tryG(repo, ["rev-parse", `${headCommit}:${p}`]);
    if (a !== b) differing.add(p);
  }
  return { state: differing.size ? "differs" : "files_identical", reportCommit: rc, headCommit, relation, differing };
}
