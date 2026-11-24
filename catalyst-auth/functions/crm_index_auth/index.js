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
// Public path of this function. Inside Catalyst, req.url is relative to the function (/execute...).
const FN_PATH = '/server/crm_index_auth/execute';
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
    // Coming back from the embedded login: Catalyst keeps only the first query param of service_url, so the
    // original query travels packed into a single base64url `r` param.
    const packed = url.searchParams.get('r');
    if (packed) {
      url.search = Buffer.from(packed, 'base64url').toString('utf8');
      url.searchParams.delete('r');
    }
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
    // Polled by the sign-in page below while the Catalyst login popup is open.
    if (url.searchParams.get('check') === '1') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ signedIn: !!(user && user.email_id) }));
    }
    if (!user || !user.email_id) {
      const params = new URLSearchParams(url.searchParams);
      params.delete('check');
      const self = `${url.origin}${FN_PATH}?${params.toString()}`;
      params.set('check', '1');
      const check = `${FN_PATH}?${params.toString()}`;
      // Catalyst's hosted login always lands on the project's app page (qa_automation_audit.html) afterwards.
      // Render the embedded login here instead and tell it to come back to this URL. The session poll is a
      // backstop; the hosted-login popup is the fallback if the embedded SDK fails to load.
      const selfQuery = new URLSearchParams([...params].filter(([k]) => k !== 'check')).toString();
      const selfPath = `${FN_PATH}?r=${Buffer.from(selfQuery).toString('base64url')}`;
      const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
      return page(res, 401, 'Sign in required',
        `<p>Sign in with your Zoho account to connect crm-index.</p>` +
        `<div id="crmindex-login" style="min-height:420px"></div>` +
        `<p id="fallback" style="display:none"><a id="signin" href="/__catalyst/auth/login" target="crmindex_login" style="padding:.6em 1em;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>` +
        `<p id="status" style="color:#666;font-size:.9em"></p>` +
        `<p style="color:#666;font-size:.9em">If nothing happens after signing in, reopen: <a href="${esc(self)}">${esc(self)}</a></p>` +
        `<script src="https://static.zohocdn.com/catalyst/sdk/js/4.5.0/catalystWebSDK.js"></script>` +
        `<script src="/__catalyst/sdk/init.js"></script>` +
        `<script>(function(){` +
        `var self=${js(self)},selfPath=${js(selfPath)},check=${js(check)},pop=null;` +
        `function poll(){fetch(check,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(j){` +
        `if(j&&j.signedIn){clearInterval(timer);try{pop&&pop.close()}catch(e){}location.replace(self)}}).catch(function(){})}` +
        `var timer=setInterval(poll,1500);` +
        `function fallback(){document.getElementById('fallback').style.display='block'}` +
        `try{catalyst.auth.signIn('crmindex-login',{service_url:selfPath,login_redirect:selfPath})}catch(e){fallback()}` +
        `document.getElementById('signin').addEventListener('click',function(ev){` +
        `pop=window.open('/__catalyst/auth/login','crmindex_login','width=520,height=680');` +
        `if(pop)ev.preventDefault();` +
        `document.getElementById('status').textContent='Waiting for sign-in in the other window\\u2026'});` +
        `})();</script>`);
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
