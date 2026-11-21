'use strict';
// Throwaway Phase-0 spike for crm-index MCP hosting. Delete after use.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const dns = require('dns').promises, net = require('net'), https = require('https');
const TOKEN = process.env.SPIKE_TOKEN || 'CHANGE_ME_BEFORE_DEPLOY';
const PORT = process.env.X_ZOHO_CATALYST_LISTEN_PORT || 9000;
const BOOT = new Date().toISOString();
const sh = (cmd, args, ms = 8000) => { try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms }); return (r.stdout || r.stderr || String(r.error || '')).trim().slice(0, 600); } catch (e) { return 'ERR ' + e.message; } };

function marker() {
  // does state written by an earlier process survive? (restart / redeploy persistence)
  const out = {};
  for (const dir of [os.tmpdir(), __dirname, os.homedir(), '/data', '/mnt']) {
    const f = path.join(dir, '.spike-marker');
    try {
      const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
      if (!prev) fs.writeFileSync(f, BOOT);
      out[dir] = { writable: true, previousBoot: prev };
    } catch (e) { out[dir] = { writable: false, err: e.code || e.message }; }
  }
  return out;
}

function diskTest(mb) {
  const out = {};
  for (const dir of [os.tmpdir(), __dirname]) {
    const f = path.join(dir, '.spike-big');
    try {
      const chunk = Buffer.alloc(1024 * 1024, 7);
      const fd = fs.openSync(f, 'w');
      let n = 0;
      try { for (; n < mb; n++) fs.writeSync(fd, chunk); } catch (e) { out[dir] = { wroteMB: n, stoppedBecause: e.code }; }
      fs.closeSync(fd);
      if (!out[dir]) out[dir] = { wroteMB: n };
      fs.unlinkSync(f);
    } catch (e) { out[dir] = { error: e.code || e.message }; }
  }
  return out;
}

async function reach(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return { status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    const c = (e.cause && (e.cause.code || e.cause.message)) || e.name;
    return { error: String(c).slice(0, 80), ms: Date.now() - t0 };
  }
}

async function probe() {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^(X_ZOHO_CATALYST_(LISTEN_PORT|ENVIRONMENT|RUNTIME_MEMORY)|CATALYST_(MAX_TIMEOUT|USER_ENVIRONMENT))$/.test(k)) env[k] = process.env[k];
  const targets = {
    repo_host: 'https://repository.zohocorpcloud.in/',
    repo_git_host: 'https://zrepository.zohocorpcloud.in/zohocorp/CRM/zohocrm.git/info/refs?service=git-upload-pack',
    coverage_js_host: 'https://crmqa-u24-23.csez.zohocorpin.com/coverage/6092/report/8539',
    coverage_jacoco_host: 'http://crmqa19.csez.zohocorpin.com:8085/codecoverage/',
    public_internet: 'https://example.com/',
  };
  const reachRes = {};
  await Promise.all(Object.entries(targets).map(async ([k, u]) => { reachRes[k] = await reach(u); }));
  return {
    boot: BOOT, node: process.version, platform: process.platform + '/' + process.arch, uid: process.getuid && process.getuid(),
    cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576), freeMemMB: Math.round(os.freemem() / 1048576),
    cwd: process.cwd(), env,
    git: { version: sh('git', ['--version']), which: sh('which', ['git']) },
    df: sh('df', ['-k', '.']).split('\n').slice(0, 3), dfTmp: sh('df', ['-k', os.tmpdir()]).split('\n').slice(0, 3),
    reach: reachRes,
  };
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip);
const tcp = (host, port) => new Promise((resolve) => { const t0 = Date.now(); const s = net.connect({ host, port, timeout: 5000 }); s.on('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); }); s.on('timeout', () => { s.destroy(); resolve({ ok: false, err: 'timeout' }); }); s.on('error', (e) => resolve({ ok: false, err: e.code })); });
const httpsNoVerify = (host, p) => new Promise((resolve) => { const r = https.request({ host, path: p, method: 'GET', rejectUnauthorized: false, timeout: 8000 }, (res) => { res.resume(); resolve({ status: res.statusCode }); }); r.on('timeout', () => { r.destroy(); resolve({ err: 'timeout' }); }); r.on('error', (e) => resolve({ err: e.code || e.message })); r.end(); });
async function netProbe() {
  const out = {};
  for (const [name, host, ports] of [['js_cov', 'crmqa-u24-23.csez.zohocorpin.com', [443, 80]], ['jacoco_cov', 'crmqa19.csez.zohocorpin.com', [8085, 80, 443]], ['git', 'zrepository.zohocorpcloud.in', [443]]]) {
    const r = { };
    try { const a = await dns.lookup(host, { all: true }); r.dns = a.map((x) => (isPrivate(x.address) ? 'private' : 'public') + '/v' + x.family); } catch (e) { r.dns = 'ERR ' + e.code; }
    r.tcp = {}; for (const p of ports) r.tcp[p] = await tcp(host, p);
    if (name === 'js_cov') r.httpsNoVerify = await httpsNoVerify(host, '/coverage/6092/report/8539');
    out[name] = r;
  }
  return out;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200).end('ok'); return; }
  if (req.headers['x-spike-token'] !== TOKEN && u.searchParams.get('t') !== TOKEN) { res.writeHead(401).end('no'); return; }
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o, null, 1)); };
  try {
    if (u.pathname === '/probe') return json(await probe());
    if (u.pathname === '/net') return json(await netProbe());
    if (u.pathname === '/marker') return json({ boot: BOOT, marker: marker() });
    if (u.pathname === '/disk') return json(diskTest(Math.min(Number(u.searchParams.get('mb') || 300), 3000)));
    if (u.pathname === '/slow') { const s = Math.min(Number(u.searchParams.get('s') || 30), 300); await new Promise((r) => setTimeout(r, s * 1000)); return json({ waitedSeconds: s }); }
    if (u.pathname === '/stream') {
      // SSE-style: does the gateway buffer or cut long-lived streaming responses?
      const s = Math.min(Number(u.searchParams.get('s') || 40), 300);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let i = 0; const t0 = Date.now();
      const iv = setInterval(() => { res.write('data: tick ' + (++i) + ' at ' + Math.round((Date.now() - t0) / 1000) + 's\n\n'); if ((Date.now() - t0) / 1000 >= s) { clearInterval(iv); res.end('data: done\n\n'); } }, 5000);
      req.on('close', () => clearInterval(iv));
      return;
    }
    if (u.pathname === '/session') {
      // instance affinity: in-memory counter. Different values for repeated calls => multiple instances / no sticky routing.
      globalThis.__n = (globalThis.__n || 0) + 1; return json({ boot: BOOT, hits: globalThis.__n, pid: process.pid, host: os.hostname() });
    }
    res.writeHead(404).end('?');
  } catch (e) { res.writeHead(500).end(String(e.message)); }
}).listen(PORT, () => console.log('spike listening on', PORT));
