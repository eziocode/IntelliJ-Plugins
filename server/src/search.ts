import type { Db } from "./db.js";
import { queryTokens, tokenize } from "./tokens.js";

export interface Card {
  id: string; kind: string; symbol: string; path: string; lines: string; sig: string; doc: string; score: number;
}

export const makeId = (rowid: number, blob: string) => `${rowid.toString(36)}.${blob.slice(0, 5)}`;
export function parseId(id: string): { rowid: number; blob5: string } | null {
  const m = /^([0-9a-z]+)\.([0-9a-f]{5})$/.exec(id);
  return m ? { rowid: parseInt(m[1], 36), blob5: m[2] } : null;
}

const SQL = `
  SELECT s.id, s.blob, s.kind, s.parent, s.name, s.sl, s.el, s.sig, s.doc, m.path,
         bm25(symbols_fts, 10.0, 3.0, 3.0, 1.0) AS score
  FROM symbols_fts f
  JOIN symbols s ON s.id = f.rowid
  JOIN manifest m ON m.blob = s.blob AND m.ref = ?
  WHERE symbols_fts MATCH ?
  ORDER BY score LIMIT ?`;

interface Row { id: number; blob: string; kind: string; parent: string; name: string; sl: number; el: number; sig: string; doc: string; path: string; score: number }

function run(db: Db, ref: string, match: string, limit: number): Row[] {
  return db.prepare(SQL).all(ref, match, limit) as Row[];
}

const OR_POOL = 200;

export function searchSymbols(db: Db, ref: string, q: string, limit = 8, pathFilter?: string): { cards: Card[]; mode: "and" | "or" | "none" } {
  const toks = queryTokens(q);
  if (!toks.length) return { cards: [], mode: "none" };
  const quoted = toks.map((t) => `"${t}"`);
  let mode: "and" | "or" = "and";
  let rows = run(db, ref, quoted.join(" AND "), limit * 4);
  if (rows.length < limit && toks.length > 1) {
    mode = "or";
    // widen: also try adjacent-token concatenations ("set up" -> "setup") and rerank by how many query tokens each candidate covers
    const alts = new Set(quoted);
    for (let i = 0; i + 1 < toks.length; i++) alts.add(`"${toks[i]}${toks[i + 1]}"`);
    const pool = new Map(rows.map((r) => [r.id, r] as const));
    for (const r of run(db, ref, [...alts].join(" OR "), OR_POOL)) if (!pool.has(r.id)) pool.set(r.id, r);
    const cover = (r: Row) => {
      const S = new Set(tokenize(`${r.parent} ${r.name} ${r.path} ${r.sig} ${r.doc}`).split(" "));
      const nm = tokenize(`${r.parent} ${r.name}`).split(" ");
      for (let i = 0; i + 1 < nm.length; i++) S.add(nm[i] + nm[i + 1]);
      let c = 0;
      toks.forEach((t, i) => { if (S.has(t) || (i > 0 && S.has(toks[i - 1] + t)) || (i + 1 < toks.length && S.has(t + toks[i + 1]))) c++; });
      return c;
    };
    rows = [...pool.values()].map((r) => ({ r, c: cover(r) })).sort((a, b) => b.c - a.c || a.r.score - b.r.score).map((x) => x.r);
  }
  if (pathFilter) rows = rows.filter((r) => r.path.includes(pathFilter));
  // one card per (path,symbol): same blob may appear at several paths
  const uniq = new Map<string, Row>();
  for (const r of rows) { const k = `${r.path}#${r.id}`; if (!uniq.has(k)) uniq.set(k, r); }
  const cards = [...uniq.values()].slice(0, limit).map((r): Card => ({
    id: makeId(r.id, r.blob), kind: r.kind, symbol: r.parent ? `${r.parent}.${r.name}` : r.name,
    path: r.path.replace(/^webapps\/zohocrm\//, "~/"), lines: `${r.sl}-${r.el}`,
    sig: r.sig.length > 110 ? r.sig.slice(0, 107) + "..." : r.sig, doc: r.doc.length > 90 ? r.doc.slice(0, 87) + "..." : r.doc, score: r.score,
  }));
  return { cards, mode };
}

/** Compact text form: ~50-100 tokens per card. */
export function formatCards(cards: Card[]): string {
  return cards.map((c) => `[${c.id}] ${c.kind} ${c.symbol}\n  ${c.path}:${c.lines}\n  ${c.sig}${c.doc ? `\n  // ${c.doc}` : ""}`).join("\n");
}
