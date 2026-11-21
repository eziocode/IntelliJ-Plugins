import type { Db } from "./db.js";
import { execFileSync } from "node:child_process";
import { parseId } from "./search.js";
import { unpackBody, unpackText } from "./db.js";

const TYPE_KINDS = new Set(["class", "interface", "enum", "record", "annotation_type"]);

interface SymRow { id: number; blob: string; kind: string; parent: string; name: string; sl: number; el: number; sig: string }

export function getSymbol(db: Db, repo: string, id: string, ref: string, maxLines = 150): { ok: boolean; text: string } {
  const stable = /^b1\.([0-9a-f]{40})\.([0-9a-z]{1,8})$/.exec(id);
  const legacy = stable ? null : parseId(id);
  if (!stable && !legacy) return { ok: false, text: `bad id "${id}"` };
  const fields = "SELECT s.id, s.blob_id, b.sha AS blob, s.kind, s.parent, s.name, s.sl, s.el, s.sig FROM symbols s JOIN blobs b ON b.id = s.blob_id";
  const s0 = (stable
    ? db.prepare(fields + " WHERE b.sha=? ORDER BY s.id LIMIT 1 OFFSET ?").get(stable[1], parseInt(stable[2], 36))
    : db.prepare(fields + " WHERE s.id=?").get(legacy!.rowid)) as (SymRow & { blob_id: number }) | undefined;
  if (!s0 || (legacy && !s0.blob.startsWith(legacy.blob5))) return { ok: false, text: `stale id "${id}": re-run get_code_context` };
  const s = { ...s0, sig: unpackText(s0.sig) };
  const pathRow = db.prepare("SELECT path FROM v_manifest WHERE blob_id=? AND ref=? ORDER BY path LIMIT 1").get(s.blob_id, ref) as { path: string } | undefined;
  if (!pathRow) return { ok: false, text: `id "${id}" is absent from branch "${ref}"; re-run get_code_context` };
  const path = pathRow.path;
  const head = `${s.kind} ${s.parent ? s.parent + "." : ""}${s.name}  ${path}:${s.sl}-${s.el}`;

  if (TYPE_KINDS.has(s.kind)) {
    const kids = (db.prepare("SELECT id,kind,name,sl,el,sig FROM symbols WHERE blob_id=? AND sl>=? AND el<=? AND id<>? ORDER BY sl").all(s.blob_id, s.sl, s.el, s.id) as SymRow[]).map((k) => ({ ...k, sig: unpackText(k.sig) }));
    const shown = kids.slice(0, 80);
    const lines = shown.map((k) => `  ${k.sl}-${k.el} ${k.sig.replace(/^(@\w+(\([^)]*\))?\s+)*/, "").replace(/\s+throws\s+[\w., ]+$/, "").slice(0, 80)}`);
    return { ok: true, text: `${head}\n[outline: ${kids.length} members${kids.length > shown.length ? `, first ${shown.length}` : ""}; search a member by name for its body; outline capped at 80]\n${lines.join("\n")}` };
  }
  // stored body first; git mirror only for indexes built before bodies were stored
  let src: string | undefined;
  const z = db.prepare("SELECT z FROM bodies WHERE blob_id=?").get(s.blob_id) as { z: Buffer } | undefined;
  if (z) src = unpackBody(z.z);
  else {
    try { src = execFileSync("git", ["-C", repo, "cat-file", "blob", s.blob], { encoding: "utf8", maxBuffer: 1 << 28 }); }
    catch { return { ok: false, text: `body not stored and blob ${s.blob.slice(0, 10)} not in mirror` }; }
  }
  const body = src.split("\n").slice(s.sl - 1, s.el);
  const cut = body.length > maxLines;
  const out = (cut ? body.slice(0, maxLines) : body).map((l, i) => `${s.sl + i}: ${l}`).join("\n");
  return { ok: true, text: `${head}\n${out}${cut ? `\n[truncated at ${maxLines} of ${body.length} lines; pass max_lines to see more]` : ""}` };
}
