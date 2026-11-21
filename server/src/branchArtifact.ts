// Portable wire format for AppSail and the Catalyst Job Function. No Git or SQLite imports.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { chunk, initChunker, isSkippable, langOf, MAX_BYTES, type Sym } from "./chunker.js";

export const BRANCH_ARTIFACT_VERSION = 1;
export type FileEntry = { path: string; blob: string };
export type Source = FileEntry & { type: "source"; size: number; lines: number; data?: string };
export type Parsed = Omit<Source, "type"> & { type: "parsed"; status: string; symbols: Sym[] };
export type Header = {
  type: "input" | "artifact"; version: number; revision: string; files: number;
  sources: number; manifestSha256: string;
};

export function requireObjectId(value: string): void {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Invalid Git object ID");
}

export function manifestRecord(entry: FileEntry): string {
  return JSON.stringify([entry.path, entry.blob]) + "\n";
}

export function readHeader(line: string, type: Header["type"], revision: string): Header {
  requireObjectId(revision);
  const h: Header = JSON.parse(line);
  if (h.type !== type || h.version !== BRANCH_ARTIFACT_VERSION || h.revision !== revision ||
      !Number.isSafeInteger(h.files) || h.files < 0 || !Number.isSafeInteger(h.sources) || h.sources < 0 ||
      h.sources > h.files || !/^[a-f0-9]{64}$/.test(h.manifestSha256)) {
    throw new Error("Invalid branch index header or revision");
  }
  return h;
}

export function checkEntry(entry: FileEntry): void {
  requireObjectId(entry.blob);
  if (typeof entry.path !== "string" || !langOf(entry.path)) throw new Error("Unsupported manifest path");
}

export function checkSource(source: Source | Parsed): Buffer | undefined {
  checkEntry(source);
  if (!Number.isSafeInteger(source.size) || source.size < 0 ||
      !Number.isSafeInteger(source.lines) || source.lines < 1) throw new Error("Invalid source metadata");
  if (source.data === undefined) return undefined;
  if (source.size > MAX_BYTES || typeof source.data !== "string" ||
      source.data.length !== 4 * Math.ceil(source.size / 3)) throw new Error("Invalid source length");
  const buf = Buffer.from(source.data, "base64");
  const hash = createHash(source.blob.length === 40 ? "sha1" : "sha256")
    .update(`blob ${buf.length}\0`).update(buf).digest("hex");
  if (buf.length !== source.size || hash !== source.blob) throw new Error("Source blob checksum mismatch");
  return buf;
}

export async function writeCompressed(records: AsyncIterable<string>, file: string): Promise<string> {
  const hash = createHash("sha256");
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  let owned = false;
  output.once("open", () => { owned = true; });
  try {
    await pipeline(records, createGzip(), async function* (chunks) {
      for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
    }, output);
  } catch (error) {
    if (owned) await rm(file, { force: true });
    throw error;
  }
  return hash.digest("hex");
}

export async function buildBranchArtifact(inputFile: string, outputFile: string, expectedRevision: string): Promise<{ sha256: string }> {
  await initChunker();
  let sha256 = "";
  await pipeline(createReadStream(inputFile), createGunzip(), async (plain) => {
    const lines = createInterface({ input: plain, crlfDelay: Infinity });
    async function* records() {
      let header: Header | undefined;
      let files = 0, sources = 0;
      const manifest = createHash("sha256");
      for await (const line of lines) {
        if (!header) {
          header = readHeader(line, "input", expectedRevision);
          yield JSON.stringify({ ...header, type: "artifact" }) + "\n";
          continue;
        }
        const record = JSON.parse(line);
        if (record.type === "file") {
          checkEntry(record);
          manifest.update(manifestRecord(record));
          files++;
          yield line + "\n";
        } else if (record.type === "source") {
          const source: Source = record;
          const body = checkSource(source);
          if (!body && source.size <= MAX_BYTES) throw new Error("Missing source payload");
          const text = body?.toString("utf8") ?? "";
          if (body && source.lines !== text.split("\n").length) throw new Error("Source line count mismatch");
          let status = isSkippable(source.size, text);
          let symbols: Sym[] = [];
          if (!status) {
            try {
              symbols = chunk(langOf(source.path)!, text, source.path);
              status = symbols.length ? "ok" : "no_symbols";
            } catch { status = "parse_error"; }
          }
          const parsed: Parsed = { ...source, type: "parsed", status, symbols };
          if (status === "minified" || status === "too_big") delete parsed.data;
          sources++;
          yield JSON.stringify(parsed) + "\n";
        } else {
          throw new Error("Unexpected branch input record");
        }
      }
      if (!header || files !== header.files || sources !== header.sources ||
          manifest.digest("hex") !== header.manifestSha256) throw new Error("Incomplete branch input");
    }
    try { sha256 = await writeCompressed(records(), outputFile); }
    finally { lines.close(); }
  });
  return { sha256 };
}
