# crm-index sign-in (Catalyst Authentication)

A Catalyst Advanced I/O function that signs developers in to the crm-index service using Catalyst's own
login (Zoho-owned), because Zoho Corp's admin policy blocks self-made OAuth apps ("Access restricted").

Flow: the shim opens `<function>/execute?port=<local>&state=<s>`. If the browser has a Catalyst session, the
function reads the user (`getCurrentUser`), requires an allowed email domain, mints a signed session token
(same format as `server/src/auth.ts`) and redirects to the shim's `127.0.0.1` callback. If not signed in, it
shows a "Sign in required" page linking to Catalyst's hosted login.

## Deploy

```bash
cd catalyst-auth/functions/crm_index_auth && npm install          # installs zcatalyst-sdk-node
cd ../.. && catalyst init --org <orgId> --project <projectId> -ni  # once; creates .catalystrc
```

The function needs `SESSION_SECRET` (identical to the crmindex AppSail variable of the same name) and
optionally `ALLOWED_EMAIL_DOMAINS` (default `zohocorp.com`) and `SESSION_TTL_HOURS` (default 168). Do not
commit the secret: add it to `deployment.env_variables` in `catalyst-config.json` only for the deploy, then
remove it again:

```bash
catalyst deploy --only functions:crm_index_auth -ni
```

Function URL: `https://<project-domain>/server/crm_index_auth/execute`. Set it as `LOGIN_URL` on the
crmindex AppSail so the server tells clients where to sign in.

## Caveats

- Catalyst sign-in applies to project **app users**; public signup is on in this project, so the function's
  email-domain check is what keeps outsiders out. Any `@zohocorp.com` account is accepted, not only people with
  repo access.
- First-ever use for someone without a Catalyst session: the function shows a sign-in page; after signing in
  (Catalyst sends them to the project's app), open the sign-in link again or re-run the tool. Tested only with an
  already signed-in browser.
