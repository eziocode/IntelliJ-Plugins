'use strict';
const { createHash, randomUUID } = require('node:crypto');

const UPLOAD_LEASE_MS = 15 * 60_000;
// A process can exit between scheduler acceptance and saving the job ID.
// Give that submission time to publish before another attempt can take over.
const DISPATCH_LEASE_MS = 20 * 60_000;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = value => createHash('sha256').update(value).digest('hex');

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, message) {
  if (!condition) throw new RequestError(400, message);
}
function boundedText(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}

function buildKey({repo, revision, baseRevision, version}) {
  requireValue(boundedText(repo, 256), 'invalid repo');
  requireValue(typeof revision === 'string' && sha.test(revision), 'expected full revision');
  requireValue(baseRevision === 'empty' || (typeof baseRevision === 'string' && sha.test(baseRevision)), 'invalid base revision');
  requireValue(version === 1, 'unsupported parser version');
  return hash(JSON.stringify([repo, revision, baseRevision, version]));
}

async function context(store, req) {
  requireValue(typeof req.user === 'string' && /^[0-9a-f]{64}$/.test(req.user), 'invalid user');
  if (req.repo != null) requireValue(boundedText(req.repo, 256), 'invalid repo');
  const prefix = 'selection-' + req.user + '-';
  const digest = req.repo == null ? undefined : hash(req.repo);
  if (req.action === 'putContext') {
    requireValue(req.repo != null && boundedText(req.branch, 1024), 'invalid branch context');
    for (let i = 0; i < 32; i++) {
      const previous = await store.latest(prefix);
      const order = (previous?.order || 0) + 1;
      const value = {repo: req.repo, branch: req.branch, order};
      // A single unique slot per user makes simultaneous switches linearizable.
      if (await store.insert(prefix + order, value, {OrderNo: order, RepoDigest: digest})) {
        return {repo: req.repo, branch: req.branch};
      }
    }
    throw new RequestError(503, 'concurrent switches; retry');
  }
  let row = await store.latest(prefix, digest);
  if (!row) {
    // Existing contexts predate OrderNo and RepoDigest.
    row = await store.latest('context-' + req.user + '-' + (digest ? digest + '-' : ''));
  }
  return {repo: row?.repo ?? null, branch: row?.branch ?? null};
}

async function stateOf(io, claim) {
  if (!claim) return 'missing';
  const dispatch = await io.store.get('dispatch-' + claim.ticket);
  if (!dispatch) return io.now() - claim.at > UPLOAD_LEASE_MS ? 'missing' : 'preparing';
  if (dispatch.expired) return 'missing';
  const submitted = await io.store.get('submitted-' + claim.ticket);
  if (!submitted) return io.now() - dispatch.at > DISPATCH_LEASE_MS ? 'failed' : 'queued';
  const status = String(await io.jobStatus(submitted.jobId)).trim().toUpperCase();
  if (['RUNNING', 'IN_PROGRESS', 'EXECUTING'].includes(status)) return 'running';
  if (['FAILURE', 'FAILED', 'CANCELLED', 'CANCELED', 'TIMEOUT', 'TIMED_OUT', 'TERMINATED'].includes(status)) return 'failed';
  if (['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'NOT_FOUND'].includes(status)) {
    // Scheduler and Data Store have independent read visibility. Only recover
    // a terminal/missing job after its publication remained absent for a minute.
    const marker = 'terminal-' + claim.ticket;
    const seen = await io.store.get(marker);
    if (!seen) await io.store.insert(marker, {at: io.now()});
    return seen && io.now() - seen.at > 60_000 ? 'failed' : 'running';
  }
  return 'queued';
}

async function publication(io, key) {
  const result = await io.store.get('ready-' + key);
  if (!result) return null;
  return {state: 'ready', sha256: result.sha256, startedAt: result.startedAt, finishedAt: result.finishedAt,
    downloadUrl: await io.sign(result.object, 'GET')};
}

async function coordinate(io, req) {
  requireValue(req && typeof req === 'object' && !Array.isArray(req), 'expected object');
  if (req.action === 'getContext' || req.action === 'putContext') return context(io.store, req);
  requireValue(['prepare', 'submit', 'status'].includes(req.action), 'invalid action');
  const key = buildKey(req);
  const ready = await publication(io, key);
  if (ready) return ready;

  const prefix = 'attempt-' + key + '-';
  const current = await io.store.latest(prefix);
  if (req.action === 'submit') {
    if (!current || !req.ticket || current.ticket !== req.ticket) throw new RequestError(409, 'upload ticket superseded');
    const input = 'branch-inputs/' + key + '/' + current.ticket + '.gz';
    const dispatch = await io.store.get('dispatch-' + current.ticket);
    if (dispatch?.expired || (!dispatch && io.now() - current.at > UPLOAD_LEASE_MS)) {
      throw new RequestError(409, 'upload ticket expired');
    }
    if (!dispatch) {
      if (!(await io.hasObject(input))) throw new RequestError(409, 'input upload incomplete');
      if (await io.store.insert('dispatch-' + current.ticket, {at: io.now()})) {
        // Only the owner of this durable insert may dispatch this attempt.
        const jobId = await io.submit({key, ticket: current.ticket, revision: req.revision});
        await io.store.insert('submitted-' + current.ticket, {jobId});
        return {state: 'queued'};
      }
    }
  }

  const state = await stateOf(io, current);
  if (state === 'failed') {
    const late = await publication(io, key);
    if (late) return late;
  }
  if (req.action !== 'prepare' || (state !== 'failed' && state !== 'missing')) return {state};
  if (current && state === 'missing') {
    // Fence a stale uploader and a concurrent submit on the same unique row.
    await io.store.insert('dispatch-' + current.ticket, {expired: true, at: io.now()});
    const decision = await io.store.get('dispatch-' + current.ticket);
    if (!decision?.expired) return {state: 'queued'};
  }
  const attempt = (current?.attempt || 0) + 1;
  const claim = {attempt, at: io.now(), ticket: randomUUID()};
  // Concurrent replicas derive the same attempt number; the unique column
  // admits only one preparation even when both saw the same previous state.
  if (!(await io.store.insert(prefix + attempt, claim, {OrderNo: attempt}))) return {state: 'preparing'};
  return {
    state: 'preparing', ticket: claim.ticket,
    uploadUrl: await io.sign('branch-inputs/' + key + '/' + claim.ticket + '.gz', 'PUT'),
  };
}

module.exports = {coordinate, buildKey, RequestError, UPLOAD_LEASE_MS, DISPATCH_LEASE_MS};
