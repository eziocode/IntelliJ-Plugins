'use strict';
// crm-index snapshot signer. Hands out short-lived signed Stratus URLs so the AppSail service can save/restore
// its index snapshot without holding Catalyst credentials.
//   GET .../execute?action=get|put&key=snapshots/<name>      header  x-index-auth: <unix ms>.<hmac-sha256(ts) base64url>
// The caller proves it knows SNAPSHOT_KEY (shared secret); the timestamp must be within 5 minutes.
const catalyst = require('zcatalyst-sdk-node');
const crypto = require('crypto');

const KEY = process.env.SNAPSHOT_KEY || '';
const BUCKET = process.env.SNAPSHOT_BUCKET || 'crmindex-snapshots';
const EXPIRY_S = 900;

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function authorised(req) {
  const [ts, mac] = String(req.headers['x-index-auth'] || '').split('.');
  if (!KEY || !ts || !mac || !/^\d{10,16}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  const want = Buffer.from(crypto.createHmac('sha256', KEY).update(ts).digest('base64url'));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = async (req, res) => {
  try {
    if (!KEY) return send(res, 503, { ok: false, error: 'SNAPSHOT_KEY not set on this function' });
    if (!authorised(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
    const url = new URL(req.url, `https://${req.headers.host}`);
    const action = url.searchParams.get('action');
    const key = url.searchParams.get('key') || '';
    if (!/^snapshots\/[\w.-]{1,80}$/.test(key) || key.includes('..')) return send(res, 400, { ok: false, error: 'bad key' });
    if (action !== 'get' && action !== 'put') return send(res, 400, { ok: false, error: 'bad action' });

    const bucket = catalyst.initialize(req, { scope: 'admin' }).stratus().bucket(BUCKET);
    // existence is not checked here: downloading a missing object returns 404 from Stratus, which the caller handles
    const r = await bucket.generatePreSignedUrl(key, action === 'get' ? 'GET' : 'PUT', { expiryIn: EXPIRY_S });
    send(res, 200, { ok: true, url: r.signature, expiresIn: EXPIRY_S });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
};
