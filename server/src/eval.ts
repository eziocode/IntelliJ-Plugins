import { readFileSync } from "node:fs";
import type { Db } from "./db.js";
import { searchSymbols } from "./search.js";

interface Case { q: string; name?: string; path?: string }

/** recall@k / MRR over cases; a hit = a card whose symbol and/or path contains the expected substrings. */
export function runEval(db: Db, ref: string, file: string, k = 10) {
  const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: Case[] };
  const rows = cases.map((c) => {
    const t0 = performance.now();
    const { cards } = searchSymbols(db, ref, c.q, k);
    const ms = performance.now() - t0;
    const rank = cards.findIndex((x) => (!c.name || x.symbol.toLowerCase().includes(c.name.toLowerCase())) && (!c.path || x.path.includes(c.path)));
    return { q: c.q, rank: rank < 0 ? null : rank + 1, ms: Math.round(ms) };
  });
  const hits = rows.filter((r) => r.rank !== null);
  return {
    rows,
    recallAtK: hits.length / rows.length,
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
    p50ms: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    maxMs: Math.max(...rows.map((r) => r.ms)),
  };
}
