// Index snapshots in Stratus, via a Catalyst function that hands out short-lived signed URLs
// (AppSail holds no Catalyst credentials; it only knows SNAPSHOT_KEY, a shared secret).
import { createReadStream, createWriteStream, rmSync, statfsSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createHmac } from "node:crypto";
import https from "node:https";
import { dirname } from "node:path";
import type { Db } from "./db.js";

const FN = process.env.SNAPSHOT_URL ?? "";
const KEY = process.env.SNAPSHOT_KEY ?? "";
export const snapshotEnabled = () => !!FN && !!KEY;

const authHeader = () => {
  const ts = String(Date.now());
  return `${ts}.${createHmac("sha256", KEY).update(ts).digest("base64url")}`;
};

export async function signedUrl(action: "get" | "put", key: string): Promise<string> {
  const r = await fetch(`${FN}?action=${action}&key=${encodeURIComponent(key)}`, { headers: { "x-index-auth": authHeader() }, signal: AbortSignal.timeout(30_000) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
  if (!r.ok || !j.url) throw new Error(`signing function: ${j.error ?? `http ${r.status}`}`);
  return j.url;
}

/** PUT a file with an explicit Content-Length (Stratus single-shot upload). */
function putFile(url: string, file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const size = statSync(file).size;
    const u = new URL(url);
    const req = https.request(u, { method: "PUT", headers: { "content-length": String(size), "content-type": "application/gzip", overwrite: "true" }, timeout: 10 * 60_000 }, (res) => {
      let body = ""; res.on("data", (d) => (body += d));
      res.on("end", () => (res.statusCode && res.statusCode < 300 ? resolve(size) : reject(new Error(`stratus PUT ${res.statusCode}: ${body.slice(0, 160)}`))));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("stratus PUT timed out")));
    createReadStream(file).pipe(req);
  });
}

export interface SnapResult { ok: boolean; rawBytes?: number; gzBytes?: number; ms: number; skipped?: string }

/** Consistent copy (VACUUM INTO) -> gzip -> upload. Needs ~1.6x the index size free on disk, else it skips. */
export async function uploadSnapshot(db: Db, name: string): Promise<SnapResult> {
  const t0 = Date.now();
  const dir = dirname(db.name);
  const idx = statSync(db.name).size;
  const free = (() => { try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } })();
  if (free < idx * 1.6 + 50 * 1048576) return { ok: false, ms: 0, skipped: `not enough free disk (${Math.round(free / 1048576)} MiB free, index ${Math.round(idx / 1048576)} MiB)` };
  const raw = `${db.name}.snap.tmp`, gz = `${raw}.gz`;
  rmSync(raw, { force: true }); rmSync(gz, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(raw);
    const rawBytes = statSync(raw).size;
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(gz));
    rmSync(raw, { force: true }); // free the big copy before uploading
    const url = await signedUrl("put", `snapshots/${name}.sqlite.gz`);
    const gzBytes = await putFile(url, gz);
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES ('snapshot_at', ?)").run(String(Date.now()));
    return { ok: true, rawBytes, gzBytes, ms: Date.now() - t0 };
  } finally {
    rmSync(raw, { force: true }); rmSync(gz, { force: true });
  }
}
