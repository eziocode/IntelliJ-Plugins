'use strict';
const {setTimeout:delay} = require('node:timers/promises');
const {createHash} = require('node:crypto');

// Publication order is the order in which refreshes were requested. Updating an
// older request after a newer one completes cannot make it the current head.
module.exports = async function branchHead(app, req) {
  if (typeof req.repo !== 'string' || typeof req.branch !== 'string' ||
      !req.repo || !req.branch || req.repo.length > 256 || req.branch.length > 1024)
    throw new Error('invalid branch identity');
  const prefix = 'head-' + createHash('sha256').update(JSON.stringify([req.repo, req.branch])).digest('hex') + '-';
  const table = app.datastore().table('IndexBuildEvents');
  const query = async predicate => {
    const rows = await app.zcql().executeZCQLQuery('SELECT ROWID,Payload,OrderNo FROM IndexBuildEvents WHERE ' + predicate + ' ORDER BY OrderNo DESC LIMIT 1');
    return rows[0]?.IndexBuildEvents;
  };
  const range = "EventKey LIKE '" + prefix + "*'";
  const head = async () => {
    const row = await query(range + " AND Published = true");
    return row ? JSON.parse(row.Payload) : null;
  };
  if (req.action === 'readHead') return {head: await head()};
  if (!/^[0-9a-f-]{36}$/.test(req.generation)) throw new Error('invalid generation');
  const exact = range + " AND Generation = '" + req.generation + "'";
  if (req.action === 'beginHead') {
    for (let retry = 0; retry < 20; retry++) {
      if (await query(exact)) return {};
      const latest = await query(range);
      const order = Number(latest?.OrderNo || 0) + 1;
      const key = prefix + order;
      try {
        await table.insertRow({EventKey:key, Generation:req.generation, OrderNo:order, Payload:'{}', Published:false});
        return {};
      } catch (error) {
        if (!await query("EventKey = '" + key + "'")) throw error;
        await delay(30 * (retry + 1));
      }
    }
    throw new Error("branch intent allocation busy");
  }
  if (req.action !== 'publishHead' || !/^[0-9a-f]{40}$/.test(req.revision) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64}|empty)$/.test(req.baseRevision)) throw new Error('invalid branch publication');
  const row = await query(exact);
  if (!row) throw new Error('unknown generation');
  await table.updateRow({ROWID:row.ROWID, Published:true, Payload:JSON.stringify({revision:req.revision,baseRevision:req.baseRevision})});
  return {head: await head()};
};
