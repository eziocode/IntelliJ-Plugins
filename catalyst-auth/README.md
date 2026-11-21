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

## Snapshot signer: `crm_index_snapshot`

Hands out short-lived (15 min) signed Stratus URLs so the crmindex AppSail can save and restore its index
snapshot (`snapshots/<repo>.sqlite.gz` in bucket `crmindex-snapshots`) without holding Catalyst credentials.

- Call: `GET .../server/crm_index_snapshot/execute?action=get|put&key=snapshots/<name>` with header
  `x-index-auth: <unix ms>.<base64url(HMAC-SHA256(SNAPSHOT_KEY, <unix ms>))>`; the timestamp must be within 5 min.
  (The gateway strips `Authorization`, hence the custom header.)
- Env on the function: `SNAPSHOT_KEY` (shared secret), optional `SNAPSHOT_BUCKET`. Same `SNAPSHOT_KEY` plus
  `SNAPSHOT_URL` (the function's `/execute` URL) go on the crmindex AppSail.
- Deploy with the same scrub-after procedure as the login function (never commit the key).

## Branch indexing jobs

AppSail pins the Git revision, exports a compressed input, and calls `crm_index_jobs` to schedule parsing. The `crm_index_build` Job Function streams its input from the private Stratus bucket, parses it in a temporary directory, and uploads an immutable artifact. The broker exposes that artifact after its Data Store publication succeeds. Only AppSail opens the serving SQLite database.

### Development setup

1. Create a Function job pool with 4096 MB capacity. The worker deploys with 512 MB, allowing up to eight simultaneous jobs subject to platform capacity. Catalyst limits each Job Function invocation to 15 minutes.
2. Create Data Store table `IndexBuildEvents` with mandatory unique `EventKey` (VarChar length 255) and mandatory `Payload` (Text). Add nullable columns `OrderNo` (Int), `Published` (Boolean), `Generation` (VarChar length 36) and `RepoDigest` (VarChar length 64). OrderNo records switch order and build attempt numbers. Generation stores branch-head request UUIDs. RepoDigest filters a user’s context by repository. Restrict table and bucket access to the server components. The standard Catalyst system columns include `ROWID`.
3. Install the worker and broker dependencies and build the worker’s parser package. From repository root run:

   ```sh
   npm ci --prefix catalyst-auth/functions/crm_index_jobs
   npm ci --prefix catalyst-auth/functions/crm_index_build
   npm ci --prefix server
   npm run build --prefix server
   node server/deploy/build-job-parser.mjs catalyst-auth/functions/crm_index_build
   node --test catalyst-auth/test/jobs.test.js
   ```

4. Deploy `crm_index_build` and `crm_index_jobs` to Development. Set `INDEX_JOB_POOL_ID` and `SNAPSHOT_KEY` on the broker. The broker targets the function named `crm_index_build`; set `INDEX_JOB_FUNCTION_ID` to target its ID instead. Both functions accept `SNAPSHOT_BUCKET` (default `crmindex-snapshots`). Set `INDEX_BUILD_POOL=1` on AppSail. Give it the broker’s `/execute` URL as `INDEX_JOB_URL` and the same `SNAPSHOT_KEY`. Inject secrets through the deployment environment.

### Broker requests

POST JSON to `crm_index_jobs/execute` with `x-index-auth` set to `<unix-ms>.<base64url(HMAC-SHA256(SNAPSHOT_KEY, unix-ms + "." + exact-body-bytes))>`. Signatures expire after five minutes. Signed Stratus URLs expire after 15 minutes.

- `prepare`, `submit`, and `status` take `repo`, full Git `revision`, `baseRevision` and parser format `version` (currently 1). The base is a full SHA, manifest digest, or `empty`. Branch aliases sharing the same inputs reuse one build. A preparation winner receives a ticket and a signed PUT URL. After that upload finishes, submit the ticket. Other callers poll status.
- `preparing`, `queued`, and `running` report outstanding work. Call `prepare` on `missing` or `failed` to claim an attempt. A preparation expires after 15 minutes. If scheduler submission loses its acknowledgment, the broker allows 20 minutes for the worker to appear. Known pending jobs use scheduler state and retain their place in the pool. After scheduler success or a missing-job response, allow one minute for its publication to become visible.
- `ready` includes a signed GET `downloadUrl` and the compressed artifact’s `sha256`. New publications include worker `startedAt` and `finishedAt` timestamps in Unix milliseconds, measured from invocation entry through upload completion. Each successful build publishes by unique insert under its exact identity. Repeated deliveries cannot overwrite the artifact chosen by that insert.
- `putContext` takes the user’s identity digest, repo and branch. `getContext` takes the digest plus an optional repo. A unique per-user sequence orders concurrent switches across repositories. The highest matching sequence supplies the selected repo and branch after restarts or replica changes.
- `beginHead` records a refresh generation before indexing. `publishHead` attaches the completed revision and base to its generation. `readHead` returns the newest previously requested generation that has published. A slower older generation cannot replace a newer publication.
- Successful workers remove their uploaded source input. A Stratus lifecycle rule scoped to `branch-inputs/` can expire abandoned uploads after the job queue’s maximum expected delay. Retain objects under `branch-artifacts/` while their publication rows are in use.

### AppSail rollout and rollback

From the server directory run `sh deploy/prepare-bundle.sh <empty-directory> --branch-pool` for the Development release. The service derives the broker URL from its existing snapshot function URL, or accepts `INDEX_JOB_URL`. Set `INDEX_BUILD_POOL=0` to restore local indexing on restart. A bundle prepared without the flag also defaults to local indexing. The HTTP status endpoint reports branch revisions and job phases. Five overlapping worker intervals can be checked with `CRM_TEST_CATALYST=1` and the broker credentials by running `node --import tsx --test test/parallelBuilds.test.ts` from the server directory. Each live test uses its own synthetic repository identifier.
