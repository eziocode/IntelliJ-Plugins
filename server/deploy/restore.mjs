// Boot-time restore: download the latest index snapshot from Stratus (through the signing function) and unpack it
// straight into DATA_DIR. Plain Node, no dependencies. Exit 0 = restored or nothing to do; non-zero = failed (server
// then builds the index from git as before).
import { createHmac } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const FN = process.env.SNAPSHOT_URL ?? "", KEY = process.env.SNAPSHOT_KEY ?? "";
const DATA = process.env.DATA_DIR ?? "/tmp/crm-index/data";
const NAME = process.env.REPO_NAME ?? "zohocrm";
const dest = `${DATA}/${NAME}.sqlite`;
if (!FN || !KEY) { console.log("[restore] SNAPSHOT_URL/KEY not set; skipping"); process.exit(0); }
if (existsSync(dest)) { console.log("[restore] index already present; skipping"); process.exit(0); }
mkdirSync(DATA, { recursive: true });

const ts = String(Date.now());
const auth = `${ts}.${createHmac("sha256", KEY).update(ts).digest("base64url")}`;
const t0 = Date.now();
try {
  const r = await fetch(`${FN}?action=get&key=${encodeURIComponent(`snapshots/${NAME}.sqlite.gz`)}`, { headers: { "x-index-auth": auth }, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`signing function: ${j.error ?? `http ${r.status}`}`);
  const d = await fetch(j.url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (d.status === 404) { console.log("[restore] no snapshot in Stratus yet; building from git"); process.exit(0); }
  if (!d.ok || !d.body) throw new Error(`download http ${d.status}`);
  const tmp = `${dest}.restoring`;
  rmSync(tmp, { force: true });
  await pipeline(Readable.fromWeb(d.body), createGunzip(), createWriteStream(tmp));
  renameSync(tmp, dest);
  console.log(`[restore] restored ${dest} (${Math.round(statSync(dest).size / 1048576)} MiB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  rmSync(`${dest}.restoring`, { force: true });
  console.error(`[restore] failed: ${e.message}`);
  process.exit(1);
}
