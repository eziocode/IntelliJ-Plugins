import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
type Node = Parser.SyntaxNode;
type Language = Parser.Language;

const require = createRequire(import.meta.url);

export interface Sym {
  kind: string;
  name: string;
  parent: string;
  sig: string;
  doc: string;
  sl: number; // 1-based
  el: number;
}

export type Lang = "java" | "js";

const langs: Partial<Record<Lang, Language>> = {};
let parser: Parser | undefined;

let initializing: Promise<void> | undefined;

export function initChunker(): Promise<void> {
  initializing ??= loadChunker().catch(error => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

async function loadChunker(): Promise<void> {
  await Parser.init();
  parser = new Parser();
  for (const [lang, wasm] of [["java", "tree-sitter-java.wasm"], ["js", "tree-sitter-javascript.wasm"]] as const) {
    langs[lang] = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${wasm}`));
  }
}

export const MAX_BYTES = 10_000_000;
const MAX_AVG_LINE = 400; // minified detector

export function langOf(path: string): Lang | null {
  if (path.endsWith(".java")) return "java";
  if (/\.(js|mjs|cjs)$/.test(path) && !/\.min\.js$/.test(path)) return "js";
  return null;
}

export function isSkippable(size: number, text: string): string | null {
  if (size > MAX_BYTES) return "too_big";
  const lines = text.split("\n").length;
  if (text.length / Math.max(lines, 1) > MAX_AVG_LINE) return "minified";
  return null;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function signature(text: string, n: Node): string {
  const body = n.childForFieldName("body");
  const end = body ? body.startIndex : n.endIndex;
  return squash(text.slice(n.startIndex, end)).slice(0, 240);
}

function docBefore(text: string, n: Node): string {
  const p = n.previousNamedSibling;
  if (!p || !/comment/.test(p.type)) return "";
  if (n.startPosition.row - p.endPosition.row > 1) return "";
  const d = squash(
    text
      .slice(p.startIndex, p.endIndex)
      .replace(/^\s*\/\*+|\*+\/\s*$/g, "")
      .replace(/^\s*\*+ ?/gm, "")
      .replace(/^\s*\/\/+ ?/gm, ""),
  ).slice(0, 240);
  return /[A-Za-z]{3}/.test(d) ? d : "";
}

function nameOf(n: Node): string {
  return n.childForFieldName("name")?.text ?? "";
}

const JAVA_TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const JAVA_MEMBERS = new Set(["method_declaration", "constructor_declaration"]);

function walkJava(text: string, node: Node, parent: string, out: Sym[]): void {
  for (const c of node.namedChildren) {
    if (JAVA_TYPES.has(c.type)) {
      const name = nameOf(c);
      out.push({ kind: c.type.replace("_declaration", ""), name, parent, sig: signature(text, c), doc: docBefore(text, c), sl: c.startPosition.row + 1, el: c.endPosition.row + 1 });
      const body = c.childForFieldName("body");
      if (body) walkJava(text, body, parent ? `${parent}.${name}` : name, out);
    } else if (JAVA_MEMBERS.has(c.type)) {
      out.push({ kind: c.type === "constructor_declaration" ? "constructor" : "method", name: nameOf(c), parent, sig: signature(text, c), doc: docBefore(text, c), sl: c.startPosition.row + 1, el: c.endPosition.row + 1 });
    } else if (c.type === "enum_body" || c.type === "enum_body_declarations" || c.type === "class_body") {
      walkJava(text, c, parent, out);
    }
  }
}

const FN_VALUE = new Set(["function_expression", "function", "arrow_function", "generator_function"]);

function walkJs(text: string, node: Node, parent: string, out: Sym[], depth = 0): void {
  for (const c of node.namedChildren) {
    switch (c.type) {
      case "export_statement": {
        const v = c.childForFieldName("value");
        if (v && (v.type === "object" || v.type === "call_expression")) walkValue(text, v, parent, out);
        else walkJs(text, c, parent, out, depth);
        break;
      }
      case "function_declaration":
      case "generator_function_declaration":
        out.push({ kind: "function", name: nameOf(c), parent, sig: signature(text, c), doc: docBefore(text, c), sl: c.startPosition.row + 1, el: c.endPosition.row + 1 });
        break;
      case "class_declaration": {
        const name = nameOf(c);
        out.push({ kind: "class", name, parent, sig: signature(text, c), doc: docBefore(text, c), sl: c.startPosition.row + 1, el: c.endPosition.row + 1 });
        const body = c.childForFieldName("body");
        if (body) for (const m of body.namedChildren) {
          if (m.type === "method_definition") out.push({ kind: "method", name: nameOf(m), parent: name, sig: signature(text, m), doc: docBefore(text, m), sl: m.startPosition.row + 1, el: m.endPosition.row + 1 });
        }
        break;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const d of c.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const v = d.childForFieldName("value");
          if (v && FN_VALUE.has(v.type)) {
            out.push({ kind: "function", name: nameOf(d), parent, sig: squash(text.slice(c.startIndex, (v.childForFieldName("body") ?? v).startIndex)).slice(0, 240), doc: docBefore(text, c), sl: c.startPosition.row + 1, el: c.endPosition.row + 1 });
          } else if (v && v.type === "object" && depth < 1) {
            walkObject(text, v, nameOf(d), out, 0);
          } else if (v && v.type === "call_expression" && depth < 2) {
            const body = iifeBody(v);
            if (body) walkJs(text, body, nameOf(d), out, depth + 1);
            else walkValue(text, v, nameOf(d), out);
          }
        }
        break;
      case "expression_statement": {
        const e = c.firstNamedChild;
        if (e?.type === "assignment_expression") {
          const l = e.childForFieldName("left"), r = e.childForFieldName("right");
          if (l && r && FN_VALUE.has(r.type)) {
            out.push({ kind: "function", name: l.text.slice(0, 120), parent, sig: squash(text.slice(c.startIndex, (r.childForFieldName("body") ?? r).startIndex)).slice(0, 240), doc: docBefore(text, c), sl: c.startPosition.row + 1, el: c.endPosition.row + 1 });
          } else if (l && r && r.type === "object" && depth < 1) {
            walkObject(text, r, l.text.slice(0, 80), out, 0);
          }
        } else if (e?.type === "call_expression" && depth < 2) {
          // IIFE / module wrappers: (function(){ ... })() and similar
          const body = iifeBody(e);
          if (body) walkJs(text, body, parent, out, depth + 1);
          else {
            // Lyte.Component.register("name", {...}), X.extend({...}) etc.
            const args = e.childForFieldName("arguments");
            const str = args?.namedChildren.find((a) => a.type === "string");
            const nm = str ? str.text.replace(/^['"`]|['"`]$/g, "") : parent;
            walkValue(text, e, nm || parent, out);
          }
        }
        break;
      }
    }
  }
}

function iifeBody(call: Node): Node | null {
  const fn = call.childForFieldName("function");
  const inner = fn?.type === "parenthesized_expression" ? fn.firstNamedChild : fn;
  return inner && FN_VALUE.has(inner.type) ? inner.childForFieldName("body") : null;
}

/** object literal, or a call like X.extend({...}) / Mixin.create(a, {...}) -> members of its object args. */
function walkValue(text: string, v: Node, parent: string, out: Sym[]): void {
  if (v.type === "object") return walkObject(text, v, parent, out, 0);
  if (v.type === "call_expression") {
    const args = v.childForFieldName("arguments");
    if (args) for (const a of args.namedChildren) if (a.type === "object") walkObject(text, a, parent, out, 0);
  }
}

function hasFnArg(call: Node): boolean {
  const args = call.childForFieldName("arguments");
  return !!args?.namedChildren.some((a) => FN_VALUE.has(a.type));
}

function walkObject(text: string, obj: Node, parent: string, out: Sym[], depth: number): void {
  for (const p of obj.namedChildren) {
    if (p.type === "method_definition") {
      out.push({ kind: "method", name: nameOf(p), parent, sig: signature(text, p), doc: docBefore(text, p), sl: p.startPosition.row + 1, el: p.endPosition.row + 1 });
    } else if (p.type === "pair") {
      const v = p.childForFieldName("value");
      const key = p.childForFieldName("key")?.text ?? "";
      if (!v) continue;
      if (FN_VALUE.has(v.type) || (v.type === "call_expression" && hasFnArg(v))) {
        out.push({ kind: "method", name: key, parent, sig: squash(text.slice(p.startIndex, (v.childForFieldName("body") ?? v).startIndex)).slice(0, 240), doc: docBefore(text, p), sl: p.startPosition.row + 1, el: p.endPosition.row + 1 });
      } else if (v.type === "object" && depth < 2) {
        walkObject(text, v, parent ? `${parent}.${key}` : key, out, depth + 1);
      }
    }
  }
}

export function chunk(lang: Lang, text: string, fileName = ""): Sym[] {
  if (!parser) throw new Error("initChunker() not called");
  parser.setLanguage(langs[lang]!);
  const tree = parser.parse(text);
  if (!tree) return [];
  const out: Sym[] = [];
  try {
    if (lang === "java") walkJava(text, tree.rootNode, "", out);
    else walkJs(text, tree.rootNode, fileName.replace(/^.*\//, "").replace(/\.[^.]+$/, ""), out);
  } finally {
    tree.delete();
  }
  return out.filter((s) => s.name);
}
