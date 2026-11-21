import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildBranchArtifact } from "../src/branchArtifact.js";
import { openDb } from "../src/db.js";
import { brokerCall } from "../src/buildBroker.js";
import { ensureIndexed, revision } from "../src/branches.js";
import { searchSymbols } from "../src/search.js";
import { getSymbol } from "../src/symbol.js";

test("five branch builds overlap and publish isolated revisions", {timeout: 18 * 60_000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "crm-parallel-"));
  const live = process.env.CRM_TEST_CATALYST === "1";
  const states = new Map<string, Record<string, unknown>>();
  const heads = new Map<string,unknown>();
  let running = 0, peak = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      const key = url.searchParams.get("id")!;
      const artifact = join(dir, key || "unused");
      if (url.pathname === "/upload") { await pipeline(req, createWriteStream(artifact + ".in")); res.end(); return; }
      if (url.pathname === "/download") { await pipeline(createReadStream(artifact + ".out"), res); return; }
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const { action, branch, baseRevision, revision: sha } = JSON.parse(Buffer.concat(parts).toString());
      const state = states.get(sha);
      const base = "http://127.0.0.1:" + (server.address() as {port:number}).port;
      let reply = state;
      if (action === "publishHead") heads.set(branch,{revision:sha,baseRevision});
      if (action === "publishHead" || action === "readHead") reply = {head:heads.get(branch) ?? null};
      if (action === "prepare" && !state) {
        states.set(sha, {state:"preparing"});
        reply = {state:"preparing", ticket:sha, uploadUrl:base + "/upload?id=" + sha};
      }
      if (action === "submit") {
        states.set(sha, {state:"running"}); reply = {state:"running"};
        running++; peak = Math.max(peak, running);
        void (async () => {
          // Barrier makes serial scheduling fail without relying on machine speed.
          for (let i = 0; peak < 5 && i < 150; i++) await delay(100);
          const {sha256} = await buildBranchArtifact(join(dir,sha+".in"),join(dir,sha+".out"),sha);
          states.set(sha,{state:"ready",sha256,downloadUrl:base+"/download?id="+sha});
        })().catch(err => states.set(sha,{state:"failed",error:err.message})).finally(()=>running--);
      }
      res.setHeader("content-type","application/json"); res.end(JSON.stringify({ok:true,...reply}));
    } catch { res.writeHead(500).end(); }
  });
  const opts = ["INDEX_BUILD_POOL", "INDEX_JOB_URL", "SNAPSHOT_KEY"] as const;
  const old = opts.map(k=>process.env[k]);
  process.env.INDEX_BUILD_POOL = "1";
  const name = "fixture-" + randomUUID();
  const db = openDb(join(dir, name + ".sqlite"));
  try {
    if (!live) {
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      process.env.INDEX_JOB_URL = "http://127.0.0.1:" + (server.address() as {port:number}).port;
      process.env.SNAPSHOT_KEY = "fixture";
    }
    const repo = join(dir,"repo"), mirror = join(dir,"mirror");
    function git(cwd:string,...args:string[]) {
      return execFileSync("git",["-C",cwd,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    }
    git(dir,"init","-b","master",repo);git(repo,"config","user.name","Index Test");git(repo,"config","user.email","index@example.invalid");
    await writeFile(join(repo,"base.js"),"function commonBaseSymbol() {}\n");
    git(repo,"add",".");git(repo,"commit","-qm","base");
    const names = ["Alpha","Bravo","Charlie","Delta","Echo"];
    const shas: string[] = [];
    for (const n of names) {
      git(repo,"switch","-qc",n,"master");
      await writeFile(join(repo,n+".js"),"function unique"+n+"() { return '"+n+"'; }\n");
      if (live) {
        // Long enough to measure overlapping parser executions despite scheduler jitter.
        const methods = Array.from({length:12000},(_,i)=>"int calc"+i+"(){return "+i+";}");
        await writeFile(join(repo,n+".java"),"class "+n+" {\n"+methods.join("\n")+"\n}");
      }
      git(repo,"add",".");git(repo,"commit","-qm",n);shas.push(git(repo,"rev-parse","HEAD"));
    }
    git(dir,"clone","--bare",repo,mirror);
    const jobs = names.map(n=>ensureIndexed(db,mirror,n));
    assert.equal(ensureIndexed(db,mirror,names[0]),jobs[0]);
    await Promise.all(jobs.map(j=>j.promise));
    assert.deepEqual(jobs.map(j=>j.error),names.map(()=>undefined));
    if (!live) assert.equal(peak,5);
    const ids = names.map((n,i)=>{
      assert.equal(revision(db,n),shas[i]);
      const card = searchSymbols(db,n,"unique"+n).cards.find(c=>c.symbol===n+".unique"+n);
      assert.ok(card, n);
      assert.match(getSymbol(db,mirror,card.id,n).text,new RegExp("return '"+n+"'"));
      return card.id;
    });
    for (let i=0;i<names.length;i++) assert.equal(getSymbol(db,mirror,ids[i],names[(i+1)%names.length]).ok,false);
    // Dropping a local view must reuse the published object on next switch.
    const {dropRef} = await import("../src/evict.js");
    dropRef(db,"Alpha");
    const restored = ensureIndexed(db,mirror,"Alpha"); await restored.promise;
    assert.equal(restored.error,undefined); assert.equal(revision(db,"Alpha"),shas[0]);
    if (live) {
      const times = await Promise.all(shas.map((sha,i)=>brokerCall<{startedAt:number;finishedAt:number}>("status",{
        repo:name,branch:names[i],revision:sha,version:1,baseRevision:"empty"
      })));
      const overlap = Math.min(...times.map(t=>t.finishedAt)) - Math.max(...times.map(t=>t.startedAt));
      console.log("Catalyst worker intervals", JSON.stringify(times.map(t=>[t.startedAt,t.finishedAt])), "five-way overlap ms",overlap);
      assert.ok(overlap>0, "five remote worker execution intervals must overlap");
    }
  } finally {
    db.close(); server.closeAllConnections(); if (server.listening) await new Promise<void>(r=>server.close(()=>r()));
    opts.forEach((k,i)=>{ if(old[i]===undefined) delete process.env[k]; else process.env[k]=old[i]; });
    await rm(dir,{force:true,recursive:true});
  }
});
