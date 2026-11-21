import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { openDb, unpackBody } from "../src/db.js";
import { dropRef, enforceBudget, sweepIdle } from "../src/evict.js";
import { baseIdentity, discardBranchArtifact, exportBranchInput, indexRef, installBranchArtifact,
  promoteBranchArtifact, recoverStagedArtifacts, stageBranchArtifact } from "../src/indexer.js";

test("job parser artifact survives branch eviction and installs a complete SHA atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "branch-artifact-test-"));
  const repo = join(dir, "repo");
  const db = openDb(join(dir, "index.db"));
  try {
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "master");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    const commit = (msg: string) => {
      git("add", "-A");
      git("-c", "commit.gpgsign=false", "commit", "-qm", msg);
      return git("rev-parse", "HEAD");
    };
    const base = "class Base {}\n";
    const feature = "export function featureSearch() { return 1; }\n";
    await writeFile(join(repo, "Base.java"), base);
    const master = commit("base");
    await indexRef(db, repo, "master");
    assert.equal(baseIdentity(db), master);
    db.prepare("DELETE FROM meta WHERE k='revision:master'").run();
    const legacy = baseIdentity(db);
    assert.match(legacy, /^[a-f0-9]{64}$/);
    git("checkout", "-qb", "feature");
    await writeFile(join(repo, "Feature.js"), feature);
    await writeFile(join(repo, "Alias.js"), feature);
    const revision = commit("feature");
    const input = join(dir, "input.gz"), artifact = join(dir, "artifact.gz");
    await assert.rejects(exportBranchInput(db, repo, revision, input, master), /Base snapshot changed/);
    await exportBranchInput(db, repo, revision, input, legacy);
    const inputRows = gunzipSync(await readFile(input)).toString().trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(inputRows[0].files, 3);
    assert.equal(inputRows[0].sources, 1);
    assert.equal(inputRows.filter(r => r.type === "source").length, 1);
    execFileSync(process.execPath, [fileURLToPath(new URL("../deploy/build-job-parser.mjs", import.meta.url)), dir]);
    const parserUrl = pathToFileURL(join(dir, "parser/branchArtifact.js")).href;
    const { buildBranchArtifact } = await import(parserUrl);
    const { sha256 } = await buildBranchArtifact(input, artifact, revision);
    const rows = () => db.prepare("SELECT path FROM v_manifest WHERE ref='feature' ORDER BY path").pluck().all();
    const previous = ["Alias.js", "Base.java", "Feature.js"];
    let report = await installBranchArtifact(db, "feature", revision, artifact, sha256);
    assert.equal(report.newBlobs, 1);
    assert.equal(report.reusedBlobs, 1);
    assert.deepEqual(rows(), previous);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='revision:feature'").pluck().get(), revision);
    assert.equal(db.prepare("SELECT count(*) FROM symbols_fts WHERE symbols_fts MATCH 'feature*'").pluck().get(), 1);
    const packed = db.prepare("SELECT z FROM bodies WHERE blob_id=(SELECT blob_id FROM symbols WHERE name='featureSearch')").pluck().get() as Buffer;
    assert.equal(unpackBody(packed), feature);
    report = await installBranchArtifact(db, "other", revision, artifact, sha256);
    assert.equal(report.newBlobs, 0);
    assert.equal(report.reusedBlobs, 2);
    dropRef(db, "feature");
    dropRef(db, "other");
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='revision:feature'").get(), undefined);
    assert.equal((await installBranchArtifact(db, "feature", revision, artifact, sha256)).newBlobs, 1);

    await assert.rejects(installBranchArtifact(db, "feature", revision, artifact, "0".repeat(64)), /checksum/);
    await assert.rejects(installBranchArtifact(db, "feature", master, artifact, sha256), /revision/);
    await assert.rejects(installBranchArtifact(db, "feature", revision, artifact, sha256, () => { throw new Error("superseded"); }), /superseded/);
    const truncated = join(dir, "truncated.gz");
    const fileRows = gunzipSync(await readFile(artifact)).toString().trimEnd().split("\n");
    const data = gzipSync(fileRows.slice(0, -1).join("\n") + "\n");
    await writeFile(truncated, data);
    await assert.rejects(installBranchArtifact(db, "feature", revision, truncated, createHash("sha256").update(data).digest("hex")), /Incomplete/);
    assert.deepEqual(rows(), previous);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='revision:feature'").pluck().get(), revision);

    await rm(join(repo, "Alias.js"));
    await rm(join(repo, "Feature.js"));
    const next = commit("drop feature");
    const input2 = join(dir, "next-input.gz"), artifact2 = join(dir, "next-result.gz");
    await exportBranchInput(db, repo, next, input2, legacy);
    const result2 = await buildBranchArtifact(input2, artifact2, next);
    const generation = randomUUID();
    await stageBranchArtifact(db, generation, next, artifact2, result2.sha256);
    assert.deepEqual(rows(), previous);
    assert.deepEqual(enforceBudget(db, 1, new Set(["feature"])), []);
    assert.deepEqual(sweepIdle(db, 0, new Set(["feature"])), []);
    assert.throws(() => promoteBranchArtifact(db, "feature", generation, revision), /revision unavailable/);
    assert.throws(() => promoteBranchArtifact(db, "feature", generation, next, () => { throw new Error("superseded"); }), /superseded/);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='revision:feature'").pluck().get(), revision);
    promoteBranchArtifact(db, "feature", generation, next);
    discardBranchArtifact(db, generation);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='revision:feature'").pluck().get(), next);
    assert.equal(db.prepare("SELECT count(*) FROM refs WHERE name GLOB ':stage:*'").pluck().get(), 0);

    // A crash after durable publication but before local promotion leaves the old public branch readable.
    const interrupted = randomUUID();
    await stageBranchArtifact(db, interrupted, revision, artifact, sha256);
    const restarted = openDb(db.name);
    try {
      assert.equal(recoverStagedArtifacts(restarted), 1);
      assert.equal(recoverStagedArtifacts(restarted), 0);
    } finally { restarted.close(); }
    assert.equal(db.prepare("SELECT count(*) FROM meta WHERE k GLOB '*::stage:*'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='revision:feature'").pluck().get(), next);

    assert.deepEqual(rows(), ["Base.java"]);
    assert.deepEqual(db.prepare("SELECT path FROM paths").pluck().all(), ["Base.java"]);
    assert.equal(db.prepare("SELECT count(*) FROM symbols_fts WHERE symbols_fts MATCH 'feature*'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT count(*) FROM blobs").pluck().get(), 1);
    dropRef(db, "feature");
    dropRef(db, "master");
    await assert.rejects(installBranchArtifact(db, "feature", revision, artifact, sha256), /absent base blob/);
    assert.equal(db.prepare("SELECT count(*) FROM refs").pluck().get(), 0);
    assert.equal(db.prepare("SELECT count(*) FROM blobs").pluck().get(), 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
