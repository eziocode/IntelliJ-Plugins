'use strict';
const {createReadStream, createWriteStream} = require('node:fs');
const {mkdtemp, rm, stat} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {pipeline} = require('node:stream/promises');
const {randomUUID} = require('node:crypto');
const catalyst = require('zcatalyst-sdk-node');
const TABLE = 'IndexBuildEvents';

function services(context) {
  const app = catalyst.initialize(context, {scope: 'admin'});
  const bucket = app.stratus().bucket(process.env.SNAPSHOT_BUCKET || 'crmindex-snapshots');
  const table = app.datastore().table(TABLE);
  const signed = async (key, verb) => (await bucket.generatePreSignedUrl(key, verb, {expiryIn: 900})).signature;
  async function read(key, latest = false) {
    const predicate = latest ? "LIKE '" + key + "*'" : "= '" + key + "'";
    const rows = await app.zcql().executeZCQLQuery('SELECT Payload FROM ' + TABLE +
      ' WHERE EventKey ' + predicate + (latest ? ' ORDER BY OrderNo DESC, CREATEDTIME DESC, ROWID DESC' : '') + ' LIMIT 1');
    return rows[0] ? JSON.parse(rows[0][TABLE].Payload) : null;
  }
  return {
    read,
    async insert(key, value) {
      try { await table.insertRow({EventKey: key, Payload: JSON.stringify(value)}); }
      catch (error) { if (!(await read(key))) throw error; }
    },
    async download(key, file) {
      const response = await fetch(await signed(key, 'GET'), {redirect: 'error'});
      if (!response.ok || !response.body) throw new Error('input download failed');
      await pipeline(response.body, createWriteStream(file, {flags: 'wx'}));
    },
    async upload(key, file) {
      const source = createReadStream(file);
      try {
        const res = await fetch(await signed(key, 'PUT'), {
          method: 'PUT', body: source, duplex: 'half', redirect: 'error',
          headers: {'Content-Length': String((await stat(file)).size), 'Content-Type': 'application/octet-stream'},
        });
        if (!res.ok) throw new Error('artifact upload failed');
        await res.body?.cancel();
      } finally { source.destroy(); }
    },
    async parse(input, output, revision) {
      const {buildBranchArtifact} = await import('./parser/branchArtifact.js');
      return buildBranchArtifact(input, output, revision);
    },
    removeInput: key => bucket.deleteObject(key)
  };
}

async function run(io, params, jobId) {
  const startedAt = Date.now();
  const {key, ticket, revision} = params || {};
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ticket) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('invalid job parameters');

  const input = 'branch-inputs/' + key + '/' + ticket + '.gz';
  const ready = 'ready-' + key;
  const claim = await io.read('attempt-' + key + '-', true);
  if (claim?.ticket !== ticket || await io.read(ready)) return;
  // Also records acceptance when the broker crashed after submitting the job.
  if (jobId) await io.insert('submitted-' + ticket, {jobId: String(jobId)});
  const dir = await mkdtemp(join(tmpdir(), 'index-build-'));
  try {
    const source = join(dir, 'input.gz');
    const output = join(dir, 'output.gz');
    await io.download(input, source);
    const {sha256} = await io.parse(source, output, revision);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid parser checksum');
    // Unique object even for a redelivery of this same job. The unique result
    // row picks exactly one completed upload and cannot be overwritten.
    const object = 'branch-artifacts/' + key + '/' + randomUUID() + '.gz';
    await io.upload(object, output);
    await io.insert(ready, {object, sha256, startedAt, finishedAt: Date.now()});
    try { await io.removeInput(input); } catch { console.warn('Index input cleanup deferred'); }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

module.exports = async (jobRequest, context) => {
  try {
    await run(services(context), jobRequest.getAllJobParams(), jobRequest.getJobDetails()?.job_id);
    context.closeWithSuccess();
  } catch (error) {
    console.error('Index build failed', String(error.code || 'worker-error').replace(/[^A-Z0-9_/-]/gi, '').slice(0,80));
    context.closeWithFailure();
  }
};
module.exports.run = run;
