// MCP OAuth (authorization code + PKCE) so clients like Claude Code can connect with just the URL.
// Flow:
//   1. client -> POST /mcp (no token)            -> 401 + WWW-Authenticate resource_metadata
//   2. client -> GET  /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
//   3. client -> POST /oauth/register            -> client_id (stateless: signed list of redirect URIs)
//   4. client -> GET  /oauth/authorize?...       -> redirect to the Catalyst sign-in function (LOGIN_URL)
//   5. sign-in function -> GET /oauth/return?ctx=...&token=<s1 session>&state=...
//   6. /oauth/return verifies the s1 session (company domain), issues an auth code, redirects to the client's redirect_uri
//   7. client -> POST /oauth/token (code + PKCE verifier) -> access_token = per-person key (k1, mintKeyFor)
// Everything is stateless (HMAC-signed with KEY_SECRET) except a short in-memory set of used code ids.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { keysEnabled, mintKeyFor, verifySession } from "./auth.js";

const SIGN_KEY = process.env.KEY_SECRET ?? "";
export const PUBLIC_BASE = (process.env.PUBLIC_URL ?? "https://crmindex.development.catalystappsail.in").replace(/\/$/, "");
const LOGIN_URL = process.env.LOGIN_URL ?? "";
const CODE_TTL_MS = 5 * 60_000;
const CTX_TTL_MS = 10 * 60_000;

export const resourceMetadataUrl = () => `${PUBLIC_BASE}/.well-known/oauth-protected-resource`;

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string) => createHmac("sha256", SIGN_KEY).update(body).digest("base64url");

/** prefix.<b64url JSON>.<hmac> */
function seal(prefix: string, obj: object): string {
  const body = b64u(JSON.stringify(obj));
  return `${prefix}.${body}.${mac(body)}`;
}

function unseal<T extends object>(prefix: string, token: string): T | null {
  if (!SIGN_KEY || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const want = Buffer.from(mac(parts[1]));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const o = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T;
    const exp = (o as { exp?: number }).exp;
    if (exp !== undefined && Date.now() > exp) return null;
    return o;
  } catch { return null; }
}

// Redirect URIs: loopback http (CLI tools), https, or a custom app scheme (desktop IDE clients). PKCE protects the code.
function okRedirect(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
    return x.protocol === "https:" || (x.protocol !== "javascript:" && x.protocol.length > 1);
  } catch { return false; }
}

const usedCodes = new Map<string, number>();
function consumeCode(jti: string, exp: number): boolean {
  const now = Date.now();
  for (const [k, v] of usedCodes) if (v < now) usedCodes.delete(k);
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, exp);
  return true;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (res: ServerResponse, code: number, title: string, msg: string) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:40em;margin:4em auto"><h2>${esc(title)}</h2><p>${esc(msg)}</p></body>`);
};

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 65536) throw new Error("body too large");
  }
  return s;
}

/** Returns true if the path was an OAuth/metadata route (and a response was written). */
export async function handleOAuth(path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    json(res, 200, { resource: `${PUBLIC_BASE}/mcp`, authorization_servers: [PUBLIC_BASE], bearer_methods_supported: ["header"] });
    return true;
  }
  if (path === "/.well-known/oauth-authorization-server") {
    json(res, 200, {
      issuer: PUBLIC_BASE,
      authorization_endpoint: `${PUBLIC_BASE}/oauth/authorize`,
      token_endpoint: `${PUBLIC_BASE}/oauth/token`,
      registration_endpoint: `${PUBLIC_BASE}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    return true;
  }
  if (!path.startsWith("/oauth/")) return false;

  if (!SIGN_KEY || !keysEnabled()) return (json(res, 503, { error: "server_error", error_description: "OAuth not configured (KEY_SECRET missing)" }), true);

  // Dynamic client registration (RFC 7591)
  if (path === "/oauth/register" && req.method === "POST") {
    let meta: { redirect_uris?: unknown; client_name?: unknown };
    try { meta = JSON.parse(await readBody(req)); } catch { return (json(res, 400, { error: "invalid_client_metadata" }), true); }
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) return (json(res, 400, { error: "invalid_redirect_uri" }), true);
    const issued = Date.now();
    const client_id = seal("c1", { ru: uris, iat: issued });
    json(res, 201, {
      client_id, client_id_issued_at: Math.floor(issued / 1000), client_name: typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined,
      redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
    });
    return true;
  }

  // Authorization request: send the browser to the company sign-in, carrying the client's request sealed in `ctx`
  if (path === "/oauth/authorize" && req.method === "GET") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const client = unseal<{ ru: string[] }>("c1", q.get("client_id") ?? "");
    const ru = q.get("redirect_uri") ?? "";
    // Never redirect to an unvalidated URI: errors go to a page, not to the client.
    if (!client || !client.ru.includes(ru)) return (page(res, 400, "Bad request", "Unknown client or redirect URI."), true);
    const cc = q.get("code_challenge") ?? "";
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(cc)) {
      return (page(res, 400, "Bad request", "Expected response_type=code with PKCE (S256)."), true);
    }
    if (!LOGIN_URL) return (page(res, 503, "Sign-in not configured", "LOGIN_URL is not set on the server."), true);
    const ctx = seal("x1", { ru, st: q.get("state") ?? "", cc, exp: Date.now() + CTX_TTL_MS });
    const ret = `${PUBLIC_BASE}/oauth/return?ctx=${encodeURIComponent(ctx)}`;
    const u = new URL(LOGIN_URL);
    u.searchParams.set("state", randomBytes(16).toString("hex"));
    u.searchParams.set("return", ret);
    res.writeHead(302, { location: u.toString(), "cache-control": "no-store" }).end();
    return true;
  }

  // Back from the sign-in function with a company session (s1 token)
  if (path === "/oauth/return" && req.method === "GET") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const ctx = unseal<{ ru: string; st: string; cc: string }>("x1", q.get("ctx") ?? "");
    if (!ctx) return (page(res, 400, "Sign-in expired", "Start the connection again from your AI tool."), true);
    const s = verifySession(q.get("token") ?? "");
    if (!s?.session) return (page(res, 401, "Sign-in failed", s?.expired ? "Session expired; sign in again." : "No valid company session."), true);
    const jti = randomBytes(16).toString("hex");
    const code = seal("a1", { email: s.session.email, ru: ctx.ru, cc: ctx.cc, jti, exp: Date.now() + CODE_TTL_MS });
    const back = new URL(ctx.ru);
    back.searchParams.set("code", code);
    if (ctx.st) back.searchParams.set("state", ctx.st);
    console.error(`[oauth] authorized ${s.session.email}`);
    res.writeHead(302, { location: back.toString(), "cache-control": "no-store" }).end();
    return true;
  }

  // Token exchange (PKCE). Access token = the person's own key, so revocation by kid still applies.
  if (path === "/oauth/token" && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req));
    const fail = (error: string) => (json(res, 400, { error }), true);
    if (f.get("grant_type") !== "authorization_code") return fail("unsupported_grant_type");
    const code = unseal<{ email: string; ru: string; cc: string; jti: string; exp: number }>("a1", f.get("code") ?? "");
    if (!code) return fail("invalid_grant");
    if (f.get("redirect_uri") !== code.ru) return fail("invalid_grant");
    const verifier = f.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return fail("invalid_grant");
    if (b64u(createHash("sha256").update(verifier).digest()) !== code.cc) return fail("invalid_grant");
    if (!consumeCode(code.jti, code.exp)) return fail("invalid_grant");
    const key = mintKeyFor(code.email);
    json(res, 200, { access_token: key.token, token_type: "Bearer", expires_in: Math.floor((key.exp - Date.now()) / 1000) });
    return true;
  }

  page(res, 404, "Not found", "");
  return true;
}
