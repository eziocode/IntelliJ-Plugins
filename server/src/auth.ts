// Zoho sign-in for the index API.
// Flow: shim opens  GET /auth/login?port=<local port>&state=<shim state>
//       -> Zoho consent -> GET /auth/callback (code) -> server exchanges code, reads the user's email,
//       checks the allowed domain, mints a signed session token and redirects to
//       http://127.0.0.1:<port>/callback?token=...&state=<shim state>  (the shim's one-shot local listener).
// Session tokens are HMAC-signed JSON (no server-side storage); they expire after SESSION_TTL_HOURS.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const CLIENT_ID = process.env.ZOHO_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET ?? "";
const ACCOUNTS = (process.env.ZOHO_ACCOUNTS ?? "https://accounts.zoho.com").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.SESSION_SECRET ?? "";
const TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 168) * 3600_000;
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS ?? "zohocorp.com").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
// test-only: skip Zoho and sign in as this email (never set in production)
const FAKE_LOGIN = process.env.DEV_FAKE_LOGIN_EMAIL ?? "";

// External sign-in page (the Catalyst auth function). When set, the shim is sent there instead of /auth/login.
const LOGIN_URL = process.env.LOGIN_URL ?? "";
/** Where clients should sign in: the external page if configured, else this server's own OAuth route. */
export const loginTarget = () => (LOGIN_URL || "/auth/login");

export const loginEnabled = () => !!SECRET && (!!LOGIN_URL || (!!CLIENT_ID && !!CLIENT_SECRET && !!PUBLIC_URL) || !!FAKE_LOGIN);

export interface Session { email: string; name: string; exp: number }

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function mintSession(email: string, name: string): string {
  const body = b64u(JSON.stringify({ email, name, exp: Date.now() + TTL_MS } satisfies Session));
  return `s1.${body}.${sign(body)}`;
}

/** null = not a session token; {expired:true} = valid signature but expired. */
export function verifySession(token: string): { session?: Session; expired?: boolean } | null {
  if (!SECRET || !token.startsWith("s1.")) return null;
  const [, body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (Date.now() > s.exp) return { expired: true };
    return { session: s };
  } catch { return null; }
}

// pending sign-ins: server state -> where to deliver the token. In-memory; a restart just means "retry login".
const pending = new Map<string, { port: number; clientState: string; at: number }>();
const PENDING_TTL = 10 * 60_000;

const page = (res: ServerResponse, code: number, title: string, msg: string) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:40em;margin:4em auto"><h2>${title}</h2><p>${msg}</p></body>`);
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function handleAuth(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);

  if (path === "/auth/login") {
    if (!loginEnabled()) return page(res, 503, "Sign-in not configured", "The index server has no Zoho OAuth client configured.");
    const port = Number(q.get("port"));
    const clientState = q.get("state") ?? "";
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[\w-]{8,128}$/.test(clientState)) {
      return page(res, 400, "Bad sign-in request", "Start sign-in from the crm-index tool.");
    }
    const state = randomBytes(24).toString("base64url");
    pending.set(state, { port, clientState, at: Date.now() });
    if (FAKE_LOGIN) { res.writeHead(302, { location: `/auth/callback?code=fake&state=${state}` }).end(); return; }
    const u = new URL(`${ACCOUNTS}/oauth/v2/auth`);
    u.search = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, scope: "AaaServer.profile.Read",
      redirect_uri: `${PUBLIC_URL}/auth/callback`, access_type: "online", prompt: "consent", state,
    }).toString();
    res.writeHead(302, { location: u.toString() }).end();
    return;
  }

  if (path === "/auth/callback") {
    const state = q.get("state") ?? "";
    const p = pending.get(state);
    if (!p) return page(res, 400, "Sign-in expired", "This sign-in link is no longer valid. Run the crm-index tool again.");
    pending.delete(state);
    if (q.get("error")) return page(res, 403, "Sign-in cancelled", esc(q.get("error") ?? ""));
    let email = "", name = "";
    try {
      if (FAKE_LOGIN) { email = FAKE_LOGIN; name = "Test User"; }
      else {
        // Zoho is multi-DC: the callback names the accounts server that holds this user
        const acct = (q.get("accounts-server") ?? ACCOUNTS).replace(/\/$/, "");
        if (!/^https:\/\/accounts\.zoho\.[a-z.]+$/.test(acct)) throw new Error("unexpected accounts server");
        const tok = await fetch(`${acct}/oauth/v2/token`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${PUBLIC_URL}/auth/callback`, code: q.get("code") ?? "" }),
          signal: AbortSignal.timeout(15_000),
        }).then((r) => r.json() as Promise<{ access_token?: string; error?: string }>);
        if (!tok.access_token) throw new Error(`token exchange failed: ${tok.error ?? "no access_token"}`);
        const info = await fetch(`${acct}/oauth/user/info`, { headers: { authorization: `Zoho-oauthtoken ${tok.access_token}` }, signal: AbortSignal.timeout(15_000) })
          .then((r) => r.json() as Promise<{ Email?: string; Display_Name?: string }>);
        email = (info.Email ?? "").toLowerCase(); name = info.Display_Name ?? email;
      }
    } catch (e) {
      return page(res, 502, "Sign-in failed", esc((e as Error).message));
    }
    const domain = email.split("@")[1] ?? "";
    if (!email || !DOMAINS.includes(domain)) {
      return page(res, 403, "Not allowed", `${esc(email || "This account")} is not in an allowed domain (${esc(DOMAINS.join(", "))}).`);
    }
    const token = mintSession(email, name);
    const back = new URL(`http://127.0.0.1:${p.port}/callback`);
    back.search = new URLSearchParams({ token, state: p.clientState, email }).toString();
    console.error(`[auth] signed in ${email}`);
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  page(res, 404, "Not found", "");
}
