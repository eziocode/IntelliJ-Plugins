import type { Db } from "./db.js";
import { execFileSync } from "node:child_process";
import { parseId } from "./search.js";

const TYPE_KINDS = new Set(["class", "interface", "enum", "record", "annotation_type"]);

interface SymRow { id: number; blob: string; kind: string; parent: string; name: string; sl: number; el: number; sig: string }

export function getSymbol(db: Db, repo: string, id: string, ref: string, maxLines = 150): { ok: boolean; text: string } {
  const p = parseId(id);
  if (!p) return { ok: false, text: `bad id "${id}"` };
  const s = db.prepare("SELECT id,blob,kind,parent,name,sl,el,sig FROM symbols WHERE id=?").get(p.rowid) as SymRow | undefined;
  if (!s || !s.blob.startsWith(p.blob5)) return { ok: false, text: `stale id "${id}": re-run get_code_context` };
  const pathRow = (db.prepare("SELECT path FROM manifest WHERE blob=? AND ref=? LIMIT 1").get(s.blob, ref)
    ?? db.prepare("SELECT path FROM manifest WHERE blob=? LIMIT 1").get(s.blob)) as { path: string } | undefined;
  const path = pathRow?.path ?? "(unknown path)";
  const head = `${s.kind} ${s.parent ? s.parent + "." : ""}${s.name}  ${path}:${s.sl}-${s.el}`;

  if (TYPE_KINDS.has(s.kind)) {
    const kids = db.prepare("SELECT id,blob,kind,name,sl,el,sig FROM symbols WHERE blob=? AND sl>=? AND el<=? AND id<>? ORDER BY sl").all(s.blob, s.sl, s.el, s.id) as SymRow[];
    const shown = kids.slice(0, 80);
    const lines = shown.map((k) => `  ${k.sl}-${k.el} ${k.sig.replace(/^(@\w+(\([^)]*\))?\s+)*/, "").replace(/\s+throws\s+[\w., ]+$/, "").slice(0, 80)}`);
    return { ok: true, text: `${head}\n[outline: ${kids.length} members${kids.length > shown.length ? `, first ${shown.length}` : ""}; search a member by name for its body; outline capped at 80]\n${lines.join("\n")}` };
  }
  let src: string;
  try { src = execFileSync("git", ["-C", repo, "cat-file", "blob", s.blob], { encoding: "utf8", maxBuffer: 1 << 28 }); }
  catch { return { ok: false, text: `could not read blob ${s.blob.slice(0, 10)} from mirror` }; }
  const body = src.split("\n").slice(s.sl - 1, s.el);
  const cut = body.length > maxLines;
  const out = (cut ? body.slice(0, maxLines) : body).map((l, i) => `${s.sl + i}: ${l}`).join("\n");
  return { ok: true, text: `${head}\n${out}${cut ? `\n[truncated at ${maxLines} of ${body.length} lines; pass max_lines to see more]` : ""}` };
}
