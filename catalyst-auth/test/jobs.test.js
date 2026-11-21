'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHmac} = require('node:crypto');
const {readFile, writeFile} = require('node:fs/promises');
const {coordinate, buildKey, UPLOAD_LEASE_MS, DISPATCH_LEASE_MS} = require('../functions/crm_index_jobs/coordinator');
const {authenticate} = require('../functions/crm_index_jobs');
const {run} = require('../functions/crm_index_build');

const build = {repo: 'crm', branch: 'main', revision: 'd'.repeat(40), baseRevision: 'empty', version: 1};
function fixture() {
  const rows = new Map();
  const repoDigests = new Map();
  const data = new Map();
  const jobs = new Map();
  const store = {
    async insert(key, value, columns = {}) {
      if (rows.has(key)) return false;
      rows.set(key, value); repoDigests.set(key, columns.RepoDigest);
      return true;
    },
    async get(key) { return rows.get(key) || null; },
    async latest(key, digest) {
      const entries = Array.from(rows.entries()).reverse();
      return entries.find(([name]) => name.startsWith(key) && (!digest || repoDigests.get(name) === digest))?.[1] || null;
    },
  };
  let now = Date.now();
  const io = {
    now: () => now, store,
    sign: async key => 'test:/' + key,
    hasObject: async key => data.has(key),
    async submit(params) {
      const id = String(jobs.size + 1);
      jobs.set(id, {params, status:'Submitted'});
      return id;
    },
    jobStatus: async id => jobs.get(id).status,
  };
  const worker = {
    read: (key, prefix) => prefix ? store.latest(key) : store.get(key),
    insert: store.insert,
    download: (key, file) => writeFile(file, data.get(key)),
    upload: async (key, file) => {data.set(key, await readFile(file));},
    removeInput: async key => data.delete(key),
    parse: async (source, output, revision) => {
      assert.equal(revision, build.revision);
      await writeFile(output, await readFile(source));
      return {sha256: 'a'.repeat(64)};
    }
  };
  return {io, worker, jobs, data, advance: duration => now += duration};
}

test('concurrent replicas prepare once per repo, pinned revision, base and format; submit once', async () => {
  const {io, data, jobs, worker} = fixture();
  const claims = await Promise.all(Array.from({length: 12}, () => coordinate(io, {...build, action:'prepare'})));
  const owners = claims.filter(claim => claim.ticket);
  assert.equal(owners.length, 1);
  const owner = owners[0];
  data.set(owner.uploadUrl.slice(6), 'input');
  const submit = {action:'submit', ...build, ticket:owner.ticket};
  const submits = await Promise.all(Array.from({length: 5}, () => coordinate(io, submit)));
  assert.ok(submits.every(result => result.state === 'queued'));
  assert.equal(jobs.size, 1);
  const job = jobs.get('1');
  job.status = 'RUNNING';
  assert.equal((await coordinate(io, {action:'status', ...build})).state, 'running');
  await run(worker, job.params, '1');
  job.status = 'Successful';
  const result = await coordinate(io, {action:'prepare', ...build, branch:'alias'});
  assert.equal(result.state, 'ready');
  assert.equal(result.sha256, 'a'.repeat(64));
  assert.ok(result.startedAt > 0 && result.finishedAt >= result.startedAt);
  assert.equal(data.get(result.downloadUrl.slice(6)).toString(), 'input');
  const secondBase = await coordinate(io, {action:'prepare', ...build, baseRevision:'b'.repeat(40)});
  assert.ok(secondBase.ticket);
  const newer = {...build, revision: 'e'.repeat(40)};
  assert.equal((await coordinate(io, {action:'status', ...newer})).state, 'missing');
  assert.notEqual(buildKey(build), buildKey({...build, repo:'other'}));
});

test('expired upload, crash during submission and failed scheduler job admit a new attempt', async () => {
  const {io, data, advance, jobs, worker} = fixture();
  const request = {action:'prepare', ...build};
  const first = await coordinate(io, request);
  advance(UPLOAD_LEASE_MS + 1);
  const second = await coordinate(io, request);
  assert.notEqual(first.ticket, second.ticket);
  await assert.rejects(coordinate(io, {...build, action:'submit', ticket:first.ticket}), /superseded/);
  const submit = io.submit;
  io.submit = async () => {throw new Error('lost acknowledgement');};
  data.set(second.uploadUrl.slice(6), 'input');
  await assert.rejects(coordinate(io, {...build, action:'submit', ticket:second.ticket}), /acknowledgement/);
  assert.equal((await coordinate(io, request)).state,'queued');
  advance(DISPATCH_LEASE_MS + 1);
  io.submit = submit;
  const third = await coordinate(io, request);
  assert.ok(third.ticket);
  data.set(third.uploadUrl.slice(6), 'input');
  await coordinate(io, {...build, action:'submit', ticket:third.ticket});
  jobs.get('1').status = 'Failure';
  assert.equal((await coordinate(io, {...build, action:'status'})).state,'failed');
  const last = await coordinate(io, request);
  assert.ok(last.ticket);
  // A delayed job from a former attempt exits without running its parser.
  await run({...worker, parse: () => assert.fail()}, jobs.get('1').params, '1');
  assert.equal((await coordinate(io, {...build, action:'status'})).state, 'preparing');
});

test('publication waits for uploaded artifact, including errors during parsing and upload', async () => {
  for (const step of ['parse', 'upload']) {
    const {io, data, jobs, worker} = fixture();
    const owner = await coordinate(io, {...build, action:'prepare'});
    data.set(owner.uploadUrl.slice(6), 'input');
    await coordinate(io, {...build, ticket:owner.ticket, action:'submit'});
    await assert.rejects(run({...worker, [step]:async () => {throw new Error(step);}}, jobs.get('1').params, '1'));
    assert.equal(await io.store.get('ready-' + buildKey(build)), null);
  }
});

test('context is owner isolated, repo-specific and latest across repos', async () => {
  const {io} = fixture();
  const user = 'a'.repeat(64), other = 'b'.repeat(64);
  const get = (owner, repo) => coordinate(io,{action:'getContext',user:owner,repo});
  const set = (repo, branch) => coordinate(io,{action:'putContext',user,repo,branch});
  await set('crm','master');
  await set('tools','release');
  assert.deepEqual(await get(user),{repo:'tools',branch:'release'});
  assert.deepEqual(await get(user,'crm'),{repo:'crm',branch:'master'});
  assert.deepEqual(await get(other),{repo:null,branch:null});
  await set('crm','feature/test');
  assert.deepEqual(await get(user),{repo:'crm',branch:'feature/test'});
  await assert.rejects(get('bad'), /invalid user/);
});

test('HMAC binds timestamp and exact request bytes', () => {
  const now = Date.now(), body = Buffer.from('{"action":"status"}'), secret = 'test-only';
  const header = now + '.' + createHmac('sha256',secret).update(now + '.').update(body).digest('base64url');
  assert.ok(authenticate(header,body,secret,now));
  assert.ok(!authenticate(header,Buffer.from('other'),secret,now));
  assert.ok(!authenticate(header,body,secret,now + 301_000));
  assert.ok(!authenticate(header,body,'wrong',now));
});

test('live scheduler casing and delayed visibility never report an active worker as failed', async () => {
  const {io, data, jobs, advance} = fixture();
  const owner = await coordinate(io, {...build, action:'prepare'});
  data.set(owner.uploadUrl.slice(6), 'input');
  await coordinate(io, {...build, action:'submit', ticket:owner.ticket});
  const poll = async () => (await coordinate(io, {...build, action:'status'})).state;
  for (const [status, state] of [['PENDING','queued'], ['RUNNING','running'], ['SUCCESS','running']]) {
    jobs.get('1').status = status;
    assert.equal(await poll(), state);
  }
  advance(61_000);
  assert.equal(await poll(), 'failed');
  await io.store.insert('ready-' + buildKey(build), {sha256:'b'.repeat(64), object:'artifact'});
  assert.equal(await poll(), 'ready');
});

test('concurrent selections acquire unique increasing positions across different repos', async () => {
  const {io} = fixture();
  const user = 'e'.repeat(64);
  await Promise.all(Array.from({length: 8}, (_, i) => coordinate(io, {
    action:'putContext',user,repo:'r' + i,branch:'b' + i
  })));
  for(let i = 0; i < 8; i++) {
    assert.deepEqual(await coordinate(io,{action:'getContext',user,repo:'r' + i}), {repo:'r'+i,branch:'b'+i});
  }
  assert.equal((await io.store.latest('selection-' + user + '-')).order, 8);
});
