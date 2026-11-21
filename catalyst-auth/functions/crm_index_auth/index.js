'use strict';
// crm-index sign-in via Catalyst Authentication.
//   The shim opens  <this function>/execute?port=<local port>&state=<shim state>
//   - not signed in to Catalyst  -> page with a link to Catalyst's hosted login
//   - signed in, allowed domain  -> mint a signed session token and redirect to the shim's 127.0.0.1 callback
// Session format must match server/src/auth.ts:  s1.<base64url(JSON{email,name,exp})>.<hmac-sha256 base64url>
const catalyst = require('zcatalyst-sdk-node');
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || '';
const TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 3600 * 1000;
// Only this return address may receive a session (the crm-index MCP server's OAuth callback).
const RETURN_BASE = 'https://crmindex.development.catalystappsail.in/oauth/return';
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'zohocorp.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (res, code, title, body) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:40em;margin:4em auto"><h2>${esc(title)}</h2>${body}</body>`);
};
const b64u = (s) => Buffer.from(s).toString('base64url');
const mint = (email, name) => {
  const body = b64u(JSON.stringify({ email, name, exp: Date.now() + TTL_MS }));
  return `s1.${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};

module.exports = async (req, res) => {
  try {
    if (!SECRET) return page(res, 503, 'Sign-in not configured', '<p>The session secret is not set on this function.</p>');
    const url = new URL(req.url, `https://${req.headers.host}`);
    const port = Number(url.searchParams.get('port'));
    const state = url.searchParams.get('state') || '';
    // MCP OAuth flow: `return` is the server's /oauth/return URL (fixed prefix only); the session is appended to it.
    const ret = url.searchParams.get('return') || '';
    const retOk = ret.startsWith(RETURN_BASE + '?');
    if (ret && !retOk) return page(res, 400, 'Bad sign-in request', '<p>Unexpected return address.</p>');
    if (!ret && (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[\w-]{8,128}$/.test(state))) {
      return page(res, 400, 'Bad sign-in request', '<p>Start sign-in from the crm-index tool.</p>');
    }

    let user = null;
    try { user = await catalyst.initialize(req).userManagement().getCurrentUser(); } catch (e) { /* treated as signed out */ }
    if (!user || !user.email_id) {
      const self = `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
      return page(res, 401, 'Sign in required',
        `<p>Sign in with your Zoho account, then open the crm-index sign-in link again (or run the tool again).</p>` +
        `<p><a href="/__catalyst/auth/login" style="padding:.6em 1em;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>` +
        `<p style="color:#666;font-size:.9em">Sign-in link to reopen: <a href="${esc(self)}">${esc(self)}</a></p>`);
    }
    const email = user.email_id.toLowerCase();
    const domain = email.split('@')[1] || '';
    if (!DOMAINS.includes(domain)) {
      return page(res, 403, 'Not allowed', `<p>${esc(email)} is not in an allowed domain (${esc(DOMAINS.join(', '))}).</p>`);
    }
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || email;
    const back = ret ? new URL(ret) : new URL(`http://127.0.0.1:${port}/callback`);
    const params = { token: mint(email, name), state: ret ? (url.searchParams.get('state') || '') : state, email };
    for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
    console.log(`[auth] signed in ${email}`);
    res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
    res.end();
  } catch (e) {
    page(res, 500, 'Sign-in failed', `<p>${esc(e.message)}</p>`);
  }
};
