/** Identifier-aware tokenizer: used at index time and query time so FTS5 can use its plain unicode61 tokenizer. */
export function splitIdentifier(id: string): string[] {
  const parts = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  return parts;
}

/** Text -> space-joined tokens: each identifier contributes its whole lowercased form plus its parts. */
export function tokenize(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const id = m[0];
    const parts = splitIdentifier(id);
    if (parts.length > 1) out.push(id.toLowerCase().replace(/[^a-z0-9]/g, ""));
    out.push(...parts);
  }
  return out.join(" ");
}

const STOP = new Set("a an the in of for to and or on with is are be by from at as that this it its into when where how what which do does".split(" "));

/** Query -> distinct tokens, stopwords removed. Whole-identifier tokens are kept alongside their parts. */
export function queryTokens(q: string): string[] {
  const all = tokenize(q).split(" ").filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of all) if (!STOP.has(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}

/** Like tokenize() plus concatenations of adjacent parts ("pick","list" -> "picklist") so compound words match either way. */
export function tokenizeName(text: string): string {
  const out: string[] = [tokenize(text)];
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const parts = splitIdentifier(m[0]);
    for (let i = 0; i + 1 < parts.length; i++) out.push(parts[i] + parts[i + 1]);
  }
  return out.join(" ");
}
