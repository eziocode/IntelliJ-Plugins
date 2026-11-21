'use strict';
const {createHmac, timingSafeEqual} = require('node:crypto');
const catalyst = require('zcatalyst-sdk-node');
const {coordinate, RequestError} = require('./coordinator');
const branchHead = require('./heads');
const TABLE = 'IndexBuildEvents';

function authenticate(header, body, key, now) {
  const match = /^(\d{13})\.([\w-]{43})$/.exec(header || '');
  if (!key || !match || Math.abs(now - Number(match[1])) > 300_000) return false;
  const mac = createHmac('sha256', key).update(match[1] + '.').update(body).digest('base64url');
  return timingSafeEqual(Buffer.from(mac), Buffer.from(match[2]));
}

function services(app) {
  const table = app.datastore().table(TABLE);
  const bucket = app.stratus().bucket(process.env.SNAPSHOT_BUCKET || 'crmindex-snapshots');
  const jobs = app.jobScheduling().job();
  async function read(key, prefix, repoDigest) {
    // Keys are built from internal constants, hashes, UUIDs, and attempt numbers.
    if (!/^[a-z0-9-]{1,255}$/.test(key)) throw new Error('invalid internal event key');
    const predicate = prefix ? "LIKE '" + key + "*'" : "= '" + key + "'";
    if (repoDigest && !/^[a-f0-9]{64}$/.test(repoDigest)) throw new Error('invalid repo digest');
    const filter = repoDigest ? " AND RepoDigest = '" + repoDigest + "'" : '';
    const order = prefix ? ' ORDER BY OrderNo DESC, CREATEDTIME DESC, ROWID DESC' : '';
    const rows = await app.zcql().executeZCQLQuery(
      'SELECT Payload FROM ' + TABLE + ' WHERE EventKey ' + predicate + filter + order + ' LIMIT 1'
    );
    return rows.length ? JSON.parse(rows[0][TABLE].Payload) : null;
  }
  return {
    now: Date.now,
    store: {
      get: key => read(key, false),
      latest: (key, digest) => read(key, true, digest),
      async insert(key, value, columns = {}) {
        try {
          await table.insertRow({EventKey: key, Payload: JSON.stringify(value), ...columns});
          return true;
        } catch (error) {
          // Distinguish a uniqueness collision (or a lost successful response)
          // from an unavailable table. No vendor error text leaves this service.
          if (await read(key, false)) return false;
          throw error;
        }
      }
    },
    sign: async (key, method) => (await bucket.generatePreSignedUrl(key, method, {expiryIn: 900})).signature,
    hasObject: key => bucket.headObject(key, {throwErr: false}),
    async submit(params) {
      const id = process.env.INDEX_JOB_POOL_ID;
      if (!id) throw new Error('pool unconfigured');
      const target = process.env.INDEX_JOB_FUNCTION_ID
        ? {target_id: process.env.INDEX_JOB_FUNCTION_ID}
        : {target_name: 'crm_index_build'};
      const job = await jobs.submitJob({
        job_name: 'idx' + params.ticket.replace(/-/g, '').slice(0, 16), jobpool_id: id, target_type: 'Function', ...target, params
      });
      if (!job.job_id) throw new Error('missing scheduler job ID');
      return String(job.job_id);
    },
    async jobStatus(id) {
      try { return (await jobs.getJob(id)).job_status; }
      catch (error) {
        if (error.status === 404 || error.statusCode === 404) return 'NOT_FOUND';
        throw error;
      }
    }
  };
}

async function handler(req, res) {
  const reply = (code, data) => {
    res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  };
  try {
    if (req.method !== 'POST') throw new RequestError(405, 'POST required');
    if (!process.env.SNAPSHOT_KEY) throw new RequestError(503, 'broker unconfigured');
    const chunks = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 16_384) throw new RequestError(413, 'request too large');
      chunks.push(Buffer.from(part));
    }
    const body = Buffer.concat(chunks);
    if (!authenticate(req.headers['x-index-auth'], body, process.env.SNAPSHOT_KEY, Date.now())) {
      throw new RequestError(401, 'unauthorized');
    }
    let request;
    try { request = JSON.parse(body.toString('utf8')); } catch { throw new RequestError(400, 'invalid JSON'); }
    const app = catalyst.initialize(req, {scope: 'admin'});
    const result = ['beginHead','readHead','publishHead'].includes(request?.action)
      ? await branchHead(app, request) : await coordinate(services(app), request);
    reply(200, {ok: true, ...result});
  } catch (error) {
    if (error instanceof RequestError) return reply(error.status, {ok: false, error: error.message});
    // Keep signed URLs, request payloads, and SDK credentials out of logs.
    console.error('Index broker request failed', String(error.code || 'service-error').replace(/[^A-Z0-9_/-]/gi, '').slice(0,80));
    reply(503, {ok: false, error: 'index broker temporarily unavailable'});
  }
}
module.exports = handler;
module.exports.authenticate = authenticate;
