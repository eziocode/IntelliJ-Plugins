# Central CRM Index MCP — findings + phased plan (DRAFT, awaiting approval)

## A. Findings from the two coverage tools

### Link 1 — "Coverage report" (crmqa-u24-23 .../coverage/6092/report/8539)
- **Scope: JavaScript (frontend) coverage**, `type: "JS"`, repo `zohocrm`. Build label `APINAME_INCLUSION_MODULE_BUILDER_Nov_16_2026`. Not Java.
- **Granularity: file + line range** (no method/class/package). Page lists files with "Missed Cases": `javascript/CrmModuleBuilder.js (51)` -> `Line (77260 - 77270)` ... Total 92 missed cases.
- Tracks "Modified" lines only (`track_coverage.track = "Modified"`). So it is already a *diff-scoped* report: missed = changed-but-unexecuted ranges.
- QA workflow is baked in: each missed case has `category` (Functional / Other / Not_Related_To_My_Workitem_Code), `status` (Covered / No Need To Cover / null), `description` (QA's manual scenario text), `commits[]` (short commit ids per case), `DI_description` (AI description), `hash_value`, `compressed_file`/`path` (link to annotated HTML).
- **Branch + commit recorded:** `impact_coverage.branch` = `APINAME_INCLUSION_MODULE_BUILDER`, `end_changeset` = full 40-char git SHA, `start_changeset` empty, `compare_branch` null, `master_merged` flag, `modified_lines` 1513, `added_files` 0.
- **API (same origin, JSON, 200):**
  - `GET /api/coverage/{projectId=6092}/report` -> `{status, coverage:{id,type,status,instance,build_id,build_label,impact,track_coverage,impact_coverage:{id,status,branch,compare_branch,start_changeset,end_changeset,master_merged,modified_lines,modified_files,added_files,...}, started_by/on, ...}}`
  - `GET /api/coverage/6092/report/{reportId}` -> `{status, report:{id,status,coverage(number %), generated_on, verified_by/on, coverage_report:{...same as above}}}`
  - `GET /api/coverage/6092/report/{reportId}/case` -> `{status, report:{..., cases:[{id,file,start,end,path,hash_value,compressed_file,category,description,status,comments,hide,DI_description,repo,commits:[{commit_id,user}]}]}}` (92 items)
  - Also `/api/auth/session` (NextAuth-style; browser session cookie). Direct calls worked from the logged-in browser; **not tested without cookie** -> assume SSO/session auth needed. Service account/token needs to be requested from the tool owners.
- Sample case (trimmed): `{file:"webapps/zohocrm/javascript/CrmModuleBuilder.js", start:77260, end:77270, category:"Functional", status:"Covered", description:"Create a MXN field and use an existing apiname ...", repo:"zohocrm", commits:[{commit_id:"b9fba5ee8f"},{commit_id:"b897e35534"}]}`
- Per-test coverage: **no**. Only per-file/line missed ranges + free-text QA scenario.

### Link 2 — Impact code coverage (crmqa19:8085 /codecoverage/#/impactcodecoverage/{A}/{B}/all)
- **Scope: Java backend**, repo `core_library` (header "Repository core_library"). JaCoCo-based.
- Summary for this pair: total changed lines 134, tested 87, not tested 47, coverage 64%, Java files modified 7, new 0.
- **IDs:** `report_202611182138200310` (Nov 18, earlier) = `parentid`; `report_202611201336520228` (Nov 20) = child/current report `id`. Evidence: backend call `getimpactcodecoveragedetails?id,parentid,changeset`; JaCoCo session list for B starts Nov 18 21:41 (matches A's timestamp) and runs to Nov 20, i.e. B is cumulative over the parent's run. Interpretation (**to confirm with owners**): A = baseline/parent run, B = later run on same build; impact view = changed lines (by changeset) x JaCoCo hits in B, with history across earlier reports.
- **Output:** table of *not-tested changed line ranges* per Java class: `S.No | Class file (+History) | Line No. | AI Description | Description` e.g. `MXNUtil.java 1151-1152`, `CustomModuleUtil.java 9833-9834`. 19 rows / 47 lines. Row "Description" holds "Recent API Impacted: Report Id: report_... Code Type: Functional API Code <QA scenario text>" — i.e. a **line range -> API scenario** hint carried over from a prior report that covered that code. Filter by Category (Functional UI/API Code, Testing Not Needed, Exception, Migration, Automation). Per-row "Changeset: <short sha>" is shown.
- **Backend endpoints** (same origin; relative to `/codecoverage/`): `report/getreportstatus?tableid,reoprtid`, `report/getcodecoverageiddetails?id,reportid`, `report/getStats?tableid,reportid`, `report/getstatuscatestats?tableid,reportid`, `report/getimpactcodecoveragedetails?id,parentid,changeset`, `report/getauthors`, `common/getconstants`. **These return `{"response":"Authentication failed","status":"failed"}` when I call them directly** (page attaches auth I did not extract) -> JSON samples for them NOT captured.
- **Static JaCoCo HTML is fetchable** with HTTP 200 even with `credentials: omit`: `/Report/Report_CodeCoverage_{reportId}/index.html` (package table), `.../{pkg}/{Class}.java.html` (per-line `span.fc|pc|nc id="L123"`, branch info in `title`), `.../jacoco-sessions.html` (1137 rows). `jacoco.csv/.xml` = 404 (not published). Sample: `MXNUtil.java.html` fc=566, pc=133, nc=2741 lines. Per-line hit data = best machine-readable source.
- **Per-test coverage: no.** JaCoCo sessions are `<server-ip>-<hash>` with start/dump times (per JVM process), not per test case.
- Branch/commit: link 2 shows changeset short SHA per row, but no branch field visible in UI; backend `getcodecoverageiddetails` probably has it (auth blocked). Link 1's API has branch + full SHA.

### Repo stats (blobless clone of zohocrm, measured)
- Clone URL works: `https://repository.zohocorpcloud.in/zohocorp/CRM/zohocrm.git` (redirects to `zrepository.zohocorpcloud.in`; mirror must follow redirects).
- Blobless clone: **2,776,357 objects, 343 MiB pack, ~268 MiB transfer** (~30 s at 9.7 MiB/s). Cheap to mirror.
- `origin/master`: **33,792 files**. Ext mix: java 17,412 / js 6,036 / html 2,797 / png 1,379 / less 1,325 / jsp 1,078 / css 997 / svg 642 / xml 392 / gif 353 / handlebars 306 / json 277 / md 139 / properties 134.
  - Index targets: ~17.4k java + ~6k js (+ jsp/handlebars/xml/properties as light text). Roughly 24k code files; images/css/less skipped.
- **Remote branches: 17,879.** Huge. Never index all branches. Index master + on-demand branches only (user switch / watch), manifest-per-branch is cheap but blob embedding/indexing must be lazy.
- Not measured: total blob bytes. `ls-tree -l` on a blobless clone lazy-fetches every blob one by one (hangs). Measure instead by fetching master blobs in one batch (`git read-tree` + `git checkout`, or `git fetch --filter=blob:limit=...`) when we do Phase 1 spike.
- Note: JS files are huge (CrmModuleBuilder.js >77k lines) - need size cap / minified detection before chunking.

## B. Impact on design
1. Coverage sources are **two formats**: JS = line-range JSON API (diff-scoped, QA-annotated); Java = JaCoCo static HTML (+ auth'd JSON). `ingest_coverage` needs two adapters behind one internal schema `(repo, branch, commit, file, line, hits|missed, source_report_id)`.
2. Tools already compute "changed + uncovered". Our value-add is: map changed lines to **symbols**, cross-check against **commit descriptions** (ground truth), and link to **tests/APIs**. `coverage_gap` can be computed ourselves from `git diff` x JaCoCo line hits, and *validated* against their report.
3. **No per-test coverage** -> `impact_tests` v1 = lexical/identifier search over test paths + the "Recent API Impacted" scenario text from past reports as a signal. Must state method used.
4. Link-1 per-case `commits[]` (short SHA) and `end_changeset` give a commit mapping for JS; Java needs the auth'd endpoint or a manual `commit` argument.

## C. Phased plan

**Phase 1 — mirror + indexer (no embeddings)**
- Blobless mirror `git clone --filter=blob:none --bare`; `git fetch` per branch; manifest = `ls-tree -r` -> `path->blob`.
- tree-sitter (Java, JS/TS, + config as text) symbol chunks; skip generated/vendored/min/binary.
- SQLite per repo: `symbols(id,path,blob,start,end,kind,name,signature,summary)`, FTS5 with identifier-splitting tokenizer (camelCase/snake), `branch_manifest`. Bodies read via `git cat-file`.
- Exit: index full master; reindex a branch by blob diff; measure time/size.

**Phase 2 — core MCP tools**
- Streamable-HTTP server (TypeScript or Python). `list_branches, switch_branch, reindex, index_status, get_code_context` (ranked cards ~50-100 tok), `get_symbol`. Per-user active branch in session. Job queue with per-branch lock.
- Add embeddings only if lexical eval is weak (see risks).

**Phase 3 — diff / coverage / impact (real formats)**
- `diff_symbols(base,head)`: `git diff -U0` hunks -> symbols via manifest line ranges.
- `change_summary`: files, symbols, modules (path prefixes), tests touched, added/removed public APIs.
- `ingest_coverage(branch, source, report_id)`: adapter A: Link-1 JSON API (needs token); adapter B: JaCoCo HTML scraper (`span.fc/pc/nc#Lnn`) from `/Report/Report_CodeCoverage_{id}/`. Store with `commit` (JS: `end_changeset`; Java: required arg or from auth'd API).
- `coverage_gap`: changed lines x uncovered lines -> symbols; report diff vs the tool's own missed list (sanity check).
- `impact_tests`: identifier search over test dirs + prior "Recent API Impacted" scenario text; response says `method: lexical|scenario-history`.
- `commit_vs_diff`: given check-in description text, compare against `change_summary` facts, flag unmentioned modules/APIs.

**Phase 4 — AppSail, auth, webhooks**
- Docker/AppSail deploy, persistent volume for mirror+SQLite (or rebuild from Stratus snapshot on cold start), Stratus snapshots, Data Store for users/watches.
- Auth: Zoho SSO/OAuth -> map to repo read access; MCP bearer tokens. Webhook from repo host (fallback: fetch poll every N min).
- Service credentials for coverage tool APIs.

## D. Risks / open questions
- **Coverage tool auth:** link-1 uses session cookie; link-2 JSON endpoints need an auth value; need service account/API key from tool owners. HTML under `/Report/` was readable without cookie.
- **Commit mapping:** JaCoCo coverage is for a deployed build/changeset; diff base/head must match that build. Link 1 has `end_changeset` (40-char); link 2 only short SHAs per row. Coverage taken at SHA X is only valid for diff head = X. Need a check: refuse/flag if `head != coverage commit`.
- **Frontend + backend are different repos?** Link 1 repo `zohocrm` (webapps/zohocrm/javascript/...), link 2 repo `core_library`. Index must support **multiple repos** (zohocrm + core_library at least). Confirm.
- **Catalyst:** no native vector DB; AppSail disk size/persistence/instance restarts unverified; Zoho repo host may not be reachable from Catalyst (internal `zohocorpcloud.in`) -> verify network/VPN path first. Biggest go/no-go risk.
- **Embeddings:** CRM JS file sizes huge (CrmModuleBuilder.js >77k lines) and Java classes huge (MXNUtil >3.4k lines). Symbol-level FTS probably enough for v1; add vectors only if an eval set (20 real QA questions) shows lexical recall problems.
- Huge minified/generated JS must be excluded or the index blows up.
- Link-2 ID semantics (parent/child) are inferred, not confirmed.
- Repo-size stats missing (see section A "Not done").

## E. Questions for you
1. Can you run the git commands and paste output? Is `core_library` a separate repo?
2. Can the coverage tool owners give an API token/service account for both tools?
3. Is the Zoho repo host reachable from Catalyst AppSail?

---

# F. REVISION 2 (supersedes conflicting parts of section C)

## F1. Branch scope: master base + per-branch overlay
Problem: 17,879 remote branches, ~34k files on master. Full per-branch index is impossible.
- **Master indexed fully, always.** Refreshed by fetch of `refs/heads/master` only.
- **Branch = overlay**, not a copy. For branch X compute `git diff --raw master...X` (merge-base) -> changed/added/deleted paths. Index only the *new blobs* of those paths into an overlay table keyed `(branch, blob)`.
- **Query on branch X** = overlay(X) UNION master symbols WHERE path NOT IN changed(X) AND path NOT deleted(X). Cost per branch ~ size of its diff (typically tens of files), not 34k.
- **Never fetch all branches.** Narrow refspec: `git fetch origin refs/heads/X:refs/remotes/origin/X` on demand only. `list_branches` queries `git ls-remote --heads` with prefix/user filter, no local fetch.
- **Lifecycle:** overlay created on `switch_branch`/`watch`/`diff_symbols`; LRU + TTL (e.g. 14 d idle) eviction; blobs refcounted so shared blobs across branches are indexed once. Cap overlays (e.g. 200) and overlay size.
- **Stale base:** overlay is against master at time of build; store `master_sha`. If master moves, rebuild overlay manifest (cheap) and reindex only blobs not already known.
- Blob bodies fetched lazily in batches (`git cat-file --batch` with promisor remote), never one-by-one.

## F2. Coverage adapters (concrete)
Internal schema: `coverage_report(report_id, source, repo, branch, commit, kind[js|java], fetched_at, mutable)` + `cov_line(report_id, file, line, state[covered|partial|missed])` + `cov_case(report_id, file, start, end, category, status, description, commits)` (JS only).
- **Adapter JS (link 1):** pull `/api/coverage/{proj}/report/{id}` + `/case`. Gives branch + `end_changeset` + missed ranges + QA annotations. Expand ranges to `cov_line missed`. Auth: session cookie today -> need service token (open item). Report may be `status: Running` => mutable; cache with TTL, re-pull on request.
- **Adapter Java (link 2):** scrape `/Report/Report_CodeCoverage_{id}/{pkg}/{Class}.java.html` (no auth needed in our test). Parse `span.fc|pc|nc#Lnn` + `title` branch info. Fetch only files touched by the diff (from `diff_symbols`), not the whole report -> small. Commit/branch: not in HTML; require `commit` arg or read from authenticated `getcodecoverageiddetails` once a token exists.
- **On-demand, not bulk:** `coverage_gap(base, head, report_id)` fetches only needed files, caches by `(report_id, file)`. No standing ingest job in v1.
- **Commit gate:** if report commit != head (or not an ancestor with no later changes to the touched files) -> return result flagged `commit_mismatch` with the list of files whose blob differs between report commit and head. Never silently trust.
- **Cross-check:** compare our computed uncovered-changed lines against the tool's own missed list (link 1 cases / link 2 table); report diffs.
- Test plan: use the two real reports (8539 JS, report_...0228 Java) as golden fixtures.

## F3. Embeddings: lexical-only v1, vectors gated
- **v1 = no embeddings.** SQLite FTS5 with identifier splitting (camelCase, snake_case, dotted packages), columns: symbol name (boost), signature, path tokens, short doc/comment text. Ranking = bm25 with name/path boosts + exact-identifier fast path.
- Build a **20-30 question eval set** from real QA/dev questions + the two coverage reports' scenarios; track recall@10 / MRR.
- **Gate:** only add vectors (Phase 5) if recall@10 < agreed threshold (e.g. 0.8). If added: embed only `signature + name + summary` per symbol (not bodies), int8, sqlite-vec, master + overlays only. Any provider is fine; run in a background job.
- Saves cost/complexity now; schema keeps a nullable `vec` column so adding later needs no migration of metadata.

## F4. Hosting/infra: spike first, stay portable
- **Phase 0 (new, 1-2 days):** prove on a throwaway AppSail app: (a) outbound reach to `zrepository.zohocorpcloud.in` (+ git auth via secret env var), (b) writable disk size and whether it survives restart/redeploy, (c) memory/CPU limits and long-running process behavior, (d) ability to serve streamable-HTTP MCP behind Catalyst gateway (timeouts, SSE support), (e) reach to the coverage hosts (`*.csez.zohocorpin.com`), which are internal.
- **Go/no-go:** if (a) or (e) fail, host the MCP on an internal Docker/VM instead and use Catalyst only for what it adds (auth/metadata). Coverage hosts are internal-only so internal hosting may be simpler overall.
- **Portability:** everything under one `DATA_DIR` (mirror + `index.sqlite` + overlay files); config via env. No Catalyst SDK in the core.
- **Persistence stance:** index is rebuildable from git (mirror ~30 s, master index time TBD in Phase 1 spike), so disk persistence is a *speed* feature, not a correctness one. Snapshot to Stratus optional, after we know rebuild time.
- Metadata (users, watches, active branch): small; SQLite file in DATA_DIR for v1, move to Data Store/NoSQL only if multi-instance is needed.
- Single instance, single writer for v1 (per-branch locks in-process). Scale-out is out of scope.

## F5. Revised phases
0. Hosting spike (above).
1. Mirror + master index (lexical), measure index time/size, blob bytes, chunk counts.
2. Overlay branches + core tools (`get_code_context`, `get_symbol`, `list_branches`, `switch_branch`, `index_status`) + eval set.
3. `diff_symbols`, `change_summary`, coverage adapters (JS then Java), `coverage_gap` with commit gate, `impact_tests` (lexical + scenario-history, method stated).
4. Auth (Zoho SSO -> repo access), webhooks (fallback polling master + watched branches), deploy.
5. Optional vectors if eval gate fails.

---

# G. PHASE 1 SPIKE RESULTS (code in `server/`)

Stack: Node 26 + TypeScript, better-sqlite3 (FTS5), web-tree-sitter 0.22.6 + tree-sitter-wasms 0.1.13 (newer web-tree-sitter 0.27 cannot load these grammars; keep pair pinned).
Modules: `src/git.ts` (ls-tree, batched `cat-file --batch`), `src/chunker.ts` (symbol extraction), `src/tokens.ts` (identifier splitter), `src/db.ts` (schema), `src/indexer.ts`, `src/cli.ts` (`index | stats | search`).

## Measured on zohocrm master (17879 remote branches exist; only master indexed)
| Metric | Value |
|---|---|
| Java + JS blob bytes | **424 MB** (23.4k files), sparse-fetched in one batch in **29 s** |
| Index build (parse + FTS) | **~41-45 s** single process |
| Symbols | **339k** (methods ~247k, classes ~21k, JS functions/methods ~50k) |
| SQLite size | **150 MB** (no source stored) |
| Search latency | tens of ms in-process (CLI timing dominated by node startup) |
| Skipped | 10 minified files; 1053 JS + 12 Java files produced no symbols (data-only/tiny) |
| Biggest JS | CrmModuleBuilder.js 4.1 MB / 81k lines -> 872 symbols, 96% line coverage, parse 0.35 s |

Consequences:
- Full master rebuild from scratch is under a minute -> **disk persistence is not required**; Stratus snapshot is optional.
- 150 MB per index. Overlays for branches are a small delta on top. Embeddings can wait.
- Blob fetch for a blobless mirror must be batched (sparse-checkout or `fetch` of wanted blobs); lazy per-object fetch is far too slow (observed hang on `ls-tree -l`).

## JS patterns handled (CRM-specific)
- `var X = (function(){ ... })()` module pattern (CrmModuleBuilder.js style)
- `function`, `var f = function`, `X.y = function`, object-literal methods
- Zoho Lyte: `Lyte.Component.register("name", {...})`, `Lyte.Mixin.register(...)` (CRMClient/**), nested `methods:{}`/`actions:{}`
- Ember-style `X.extend({...})`, `export default {...}`

## Known gaps / TODO before Phase 2
- Java fields/constants (e.g. `VCRMConstants`) are not indexed; add `static final` constants only, as they are searchable by name.
- Query uses OR of tokens; add AND-first + phrase/identifier fast-path and path-token boost.
- Class symbols span whole file; `get_symbol` for classes should return an outline, not the body.
- `.jsp`, `.handlebars`, `.xml`, `.properties` not yet chunked (file-level entries only).
- Phase 0 (AppSail spike) NOT done; needs a Catalyst project + decision to deploy something.
- Overlay-branch logic (F1) not yet implemented; manifest table is already per-ref.

---

# H. PHASE 2 RESULTS (code in `server/`)

Run: `REPO_DIR=<mirror> DATA_DIR=data PORT=8787 [MCP_TOKEN=...] npx tsx src/server.ts` (streamable HTTP at `/mcp`, `/health`). Eval: `npx tsx src/cli.ts eval [file] [ref]`.

## Tools (all tested end to end with an MCP SDK client)
`get_code_context`, `get_symbol`, `list_branches`, `switch_branch`, `reindex`, `index_status`. Per-session active branch (Mcp-Session-Id), default `master`; any tool can override with `branch`.

## Design decisions made / changed vs section F
- **Branch = full manifest per ref, not a diff overlay.** Symbols are keyed by blob SHA and shared; a branch only adds its `ref -> path -> blob` rows (~23k rows) plus symbols for blobs not seen before. Search joins `manifest(ref)`, which gives the same semantics as overlay with simpler SQL. Measured cost per branch: a few MB + new-blob symbols. Eviction (LRU/TTL) still TODO.
- **Stable-per-DB symbol ids** like `wse.639a2` (rowid base36 + blob prefix check, ~4 tokens); stale ids give a clear "re-run get_code_context" error.
- **Cards ~65 tokens each**; `get_symbol` prints numbered lines, default cap 150 lines; class/interface/enum return a member outline (capped at 80) instead of a body.
- **Retrieval:** AND of query tokens first; if too few hits, OR over tokens + adjacent-token concatenations, reranked by token coverage then bm25. Name column also indexes adjacent-part concatenations (`pick`+`list` -> `picklist`). Stopwords stripped from queries.
- **Batch blob prefetch**: `git fetch --filter=blob:none --stdin` with missing shas (the host allows fetch by object id). Without it each missing blob = 1 round trip.
- Partial-index warning: searching a branch whose job is still running returns a WARNING line.
- Single index writer (queue); concurrent switches to the same branch dedupe.

## Measured
| Item | Result |
|---|---|
| Seed eval (14 name-derived questions), master | recall@10 **1.00**, MRR **0.87**, p50 **~50 ms**, max ~95 ms (in-process, incl. rerank) |
| Same eval on a branch | recall@10 1.00, MRR 0.87 |
| `switch_branch` small branch (34 changed blobs) | **3.3 s** total (2.1 s index) |
| `switch_branch` worst-ish branch (old base, 4,796 changed blobs, 129k symbols) | **~44 s**; tool returns after 25 s with "still indexing", job continues |
| `reindex` with nothing new | 0.2-1.1 s |
| `list_branches` filter over 17,878 branches | ~200 ms (local refs; `REMOTE_LIST=1` uses cached `ls-remote`) |
| DB after master + 2 branches | 172 MiB |

Caveat: the seed eval was written from symbol names seen in the index, so it is optimistic. Real QA/dev questions needed (Phase 2 exit criterion is on THEIR set).

## Not done / next
- Real eval set from QA questions; threshold decision for vectors.
- No auth beyond optional static `MCP_TOKEN` (Phase 4). No webhooks / watch yet.
- No master auto-refresh job; `reindex` is manual.
- Branch eviction/caps, GC of unreferenced blobs and symbols.
- Mirror here is the full local probe; production mirror = bare blobless clone (`git clone --bare --filter=blob:none`).
- Java constants/fields, JSP/handlebars/XML/properties still not chunked.
- Next: Phase 3 tools (`diff_symbols`, `change_summary`, coverage adapters, `coverage_gap`, `impact_tests`).

---

# I. PHASE 3 RESULTS (diff / coverage / impact; code in `server/`)

New tools (all tested over MCP): `diff_symbols`, `change_summary`, `compare_description`, `ingest_coverage`, `coverage_gap`, `impact_tests`. Server is now multi-repo: `REPOS="zohocrm=/path/mirror[,core_library=/path/mirror2]"`, one SQLite per repo (`data/<repo>.sqlite`), every tool takes optional `repo`. Session keeps an active branch per repo.

Coverage config (env, server-side only; tools never accept URLs): `COVERAGE_JACOCO_BASE` (prefix; `<reportId>/<pkg>/<Class>.java.html` is appended), `COVERAGE_JS_BASE`, `COVERAGE_JS_PROJECT`, `COVERAGE_JS_COOKIE` or `COVERAGE_JS_TOKEN`, `COVERAGE_FIXTURE_DIR` (offline JSON fixtures). Report ids are regex-validated.

## What was verified against real data
- **diff_symbols**: hunks from `git diff -U0 -M` mapped to the innermost symbol of head (and old side to base for removals). Spot-checked against raw hunks (BULKIO_UNDO_ADOPTION: 4 commits, 15 Java files -> 22 added / 16 modified / 4 removed symbols, 11 new public methods).
- **JaCoCo adapter**: for `MXNUtil.java` the tool reports not-tested lines 1151-1152 and `CustomModuleUtil.java` 9833-9834; the adapter returns exactly `1151-1152` and `9833-9834` as missed (9832 partial). 3,440 / 7,716 lines parsed per file; 404 -> "absent"; results cached per (report, file).
- **JS adapter + diff mapping**: using the 92 missed ranges of report 8539 against branch `APINAME_INCLUSION_MODULE_BUILDER`, evaluated at the report's commit: **468 of the tool's 471 missed lines fall inside our independently computed git diff** (3 outside = edge lines of ranges). This validates both line mapping and the commit gate logic.
- **Commit gate caught real drift**: the branch tip (22d7ea779c) is ahead of the report's commit (d5589beb84). Plain mode correctly marks the big `CrmModuleBuilder.js` as *unverifiable* (987 lines) instead of trusting it; `at_report_commit=true` evaluates exactly at the report commit (gate = match).
- Eval/regressions: seed eval unchanged (recall@10 1.0).

## Important limits (stated by the tools themselves)
- **JS report lists only missed ranges.** Lines not listed are shown as `inferred`, never counted as covered (comments/blank lines included). QA annotations (Covered / No Need To Cover) are surfaced separately (`qa_covered`, `qa_waived`).
- **Java**: lines with no JaCoCo span are non-executable and excluded; classes absent from the report are `not_in_report`.
- **impact_tests has no per-test coverage.** Method = lexical identifier match against test files in the repo + QA scenario text from ingested reports. zohocrm contains only ~56-62 test-ish files, none of which referenced the BULKIO changes, so the tool says "none found" and notes QA automation likely lives elsewhere. This is honest but NOT yet useful for QA impact.
- `compare_description` is heuristic (identifier names and module words only).

## Blocked / needs your input
1. **`core_library` repo**: the Java impact report (`report_202611201336520228`, MXNUtil etc.) belongs to `core_library`, which is NOT at `.../zohocorp/CRM/core_library.git` (repo not found). Need its real clone URL; then add it to `REPOS` and the Java path can be tested end to end (adapter and gate are already verified on the report data; only the repo mapping is missing).
2. **QA automation repo**: needed for useful `impact_tests` (pass as another repo + test-path regex via config). Without it only scenario text from past reports is available.
3. **JS coverage API credentials** (token or service account). Today it needs a browser session cookie. Live ingestion was not exercised: the Chrome extension was disconnected, so the JS fixture was rebuilt from the 92 ranges read earlier (statuses unknown except one sample case).
4. Java report -> commit: JaCoCo HTML carries no branch/commit; pass `report_commit` or register via `ingest_coverage(kind=jacoco, commit=...)`, or get the authenticated `getcodecoverageiddetails` endpoint.

## Next
- Phase 4: auth (Zoho SSO -> repo access), webhooks / polling, AppSail or internal-host deploy (Phase 0 spike still outstanding), master auto-refresh, branch eviction.
- Add coverage fixtures to a committed test directory (currently `server/scratch/`, gitignored) and a small automated test suite.

---

# J. PHASE 0 RESULTS: Catalyst AppSail spike (Development env of project CrmQaAutomation, India DC)

Throwaway managed-runtime (node22) app `crmindexspike`, token-protected, probes in `server/spike/appsail-probe.js`. Deployed with the Catalyst CLI (no Docker needed). Baseline from a Mac inside the network: every target reachable.

| Question | Result from AppSail |
|---|---|
| `git` available? | **Yes**, `git 2.43.0` in the managed runtime |
| Runtime | linux/x64, node 22, 2 CPUs, uid 1001 |
| Memory | default **256 MB** (`X_ZOHO_CATALYST_RUNTIME_MEMORY`); configurable up to 2048 MB (docs) |
| Disk | **~250 MB** hard limit (ENOSPC at 242 MB) on both `/catalyst` and `/tmp`. An existing AppSail in this project shows a `disk` setting of 1024 MB, so it is configurable; our need (mirror ~343 MB + blobs ~450 MB + index ~150 MB) is ~1-2 GB |
| Persistence | **Ephemeral.** A redeploy wiped both `/tmp` and `/catalyst` (state from the earlier deploy was gone). Plain-restart behaviour not separately tested; assume ephemeral |
| Repo host `zrepository.zohocorpcloud.in` | **Reachable** (TLS ok, `401` without credentials) |
| Public internet | Reachable |
| JS coverage tool (`crmqa-u24-23...:443`) | DNS resolves to **public** IPs; TCP 443 open; TLS handshake **requires a client certificate** (`CERTIFICATE_REQUIRED`) and the CA is not trusted. **Not callable from AppSail without a client cert** |
| JaCoCo / impact tool (`crmqa19...:8085`) | **TCP timeout** from AppSail (port blocked/unrouted); 80 refused; 443 open but unverified |
| Request duration | Silent long requests get **HTTP 408 at ~33-40 s**; even a streaming (SSE-style, bytes every 5 s) response is **cut at ~46 s**. Every MCP tool call must finish in < ~30 s; our 25 s wait fits. A long-lived SSE GET channel would be cut every ~45 s (we use no server-initiated notifications) |
| Instances | Sequential calls hit one process (same pid, hit counter 1..6): single instance at low load. Autoscaler allows up to 5; pinning to 1 not verified |
| Port | `X_ZOHO_CATALYST_LISTEN_PORT=9000` (server currently reads `PORT`) |

## Verdict
- **AppSail can host the index and MCP server**, if configured with >= 1 GB disk, 1-2 GB memory, a single instance, and every call < 30 s.
- **AppSail cannot reach the coverage tools** (client-cert gate on 443; 8085 blocked). That breaks `coverage_gap` live ingestion from Catalyst. Options: (a) host the MCP on an internal VM that can reach them; (b) have the coverage tool team expose a token-based API through a gateway AppSail can reach / issue a client cert; (c) push coverage reports into the server (an uploader job or the tool's `callback_url` hook) instead of pulling; (d) split: Catalyst hosts search, an internal worker feeds coverage.
- **Cold starts need a restore step**: ephemeral disk means every deploy/restart restores the SQLite + mirror from Stratus (or reclones ~343 MB + re-indexes ~45 s, which also needs repo credentials at runtime and the bigger disk).
- Hardcoded `PORT` -> must honour `X_ZOHO_CATALYST_LISTEN_PORT`.

## Cleanup status
Spike AppSail `crmindexspike` was created in CrmQaAutomation / Development and should be deleted once reviewed (Console -> AppSail), together with the local `.catalystrc` scratch folder.

---

# K. STORAGE COMPRESSION + DYNAMIC DEPLOYMENT (schema v4; code in `server/`)

AppSail config confirmed: **2048 MB memory, 1024 MB disk** (Development, `crmindexspike`).

## K1. Index size, measured on the same refs (master, two branches, one coverage commit)
| Step | Index size | Recall@10 / MRR (seed eval) |
|---|---|---|
| v2 (text SHAs in every row, full FTS incl. paths and docs) | **277 MB** (earlier run, same refs minus the coverage commit) | 1.0 / 0.871 |
| v3: blobs/paths/refs as dictionary tables, `v_manifest` view | 194 MB | 1.0 / 0.871 |
| FTS without doc tokens | 191 MB | 1.0 / 0.893 |
| FTS without path tokens (paths repeat on every symbol row) | 171 MB | 1.0 / **0.901** |
| No `symbols(name)` index (one GROUP BY for impact) | 156 MB | 1.0 / 0.901 |
| Shared zlib dictionary for signatures/docs (`src/zdict.bin`) | **139 MB** | 1.0 / 0.901 |
| + **compressed bodies** (`bodies` table, get_symbol without git) | 285 MB live, incl. ~131 MB bodies for 28k blobs | 1.0 / 0.901 |

Tried and rejected: `detail=none` on FTS (positions gone, bm25 loses term frequency: recall fell to 0.57).

Bodies: all master code bodies are 404 MiB raw and **83 MiB** deflated (ratio 0.21). That is what makes the mirror removable from the serving path.

## K2. Where the disk actually goes (the real constraint on 1 GB)
- Full all-branches blobless mirror: **521 MB** (`.git`). Dominated by 17,879 branches' trees and commits. Not viable on 1 GB.
- **Master-only blobless mirror: 147 MB** (measured, `clone --bare --filter=blob:none --single-branch`). Use this.
- Index: 139 MB (no bodies) to 285 MB (with bodies, 4 refs). Budgeted by `INDEX_BUDGET_MB` (default 500).
- Snapshot: 137 MB raw / 57 MB gz without bodies; **283 MB raw / 190 MB gz with bodies (4 refs)**.
- Peak disk during a cold-start restore is roughly gz + raw index: ~480 MB at 4 refs. Fits 1 GB.
- Pruning a branch's mirror refs reclaims little (17 MB for a 34-blob branch, 30 s gc). It matters only at scale; it also deletes unreferenced commits (e.g. the coverage report commit), which are refetched on demand.

## K3. Deployment strategy (chosen, and why)
1. **Serve from the index, not the mirror.** `get_symbol` reads `bodies`; the mirror is only needed to index new blobs. So a restart needs the snapshot, not a clone.
2. **Cold start = restore, then serve** (`deploy/boot.sh`): if no index, restore from `SNAPSHOT_GZ` (local) or `SNAPSHOT_URL` (signed GET from Stratus); otherwise index master from the mirror. Verified locally: healthy in ~2 s after restore, and results match the pre-restore index.
3. **Periodic snapshot** (`deploy/snapshot.sh`): `VACUUM INTO` (consistent while serving), gzip, optional signed PUT to Stratus, keep last N. Run from a Catalyst cron or after a big reindex.
4. **Dynamic branch residency:** branches are indexed on `switch_branch`; when the index exceeds the budget, the least-recently-used branch is dropped (`enforceBudget`), with its exclusive symbols, FTS rows, bodies and blobs garbage-collected. Verified: FTS rows stay in sync with symbols after each drop. Shared blobs are never removed while another ref uses them.
5. **Preload:** `PRELOAD_REFS=<branch,branch>` indexes a bounded set at boot in the background.
6. **Single instance, single writer.** The AppSail autoscaler can run up to 5; that breaks the per-session branch state and the SQLite single writer. Pin to 1 (not yet verified as configurable).
7. **Mirror policy on the host:** master-only blobless clone. Branch tracking refs are fetched per branch; `PRUNE_MIRROR=1` (and `cli prune`) removes a dropped branch's refs and runs gc.

## K4. Config (env)
| Var | Default | Meaning |
|---|---|---|
| `INDEX_BUDGET_MB` | 500 | used-page budget for the index; LRU branch eviction beyond it |
| `PRELOAD_REFS` | (none) | branches indexed at boot |
| `PRUNE_MIRROR` | 0 | prune mirror refs of evicted branches (gc, slow on big mirrors) |
| `SNAPSHOT_GZ` / `SNAPSHOT_URL` | (none) | cold-start restore source |
| `FTS_DOC`, `FTS_PATH` | 0, 0 | put doc / path tokens into FTS (cost size; off is better for ranking) |
| `DB_FILE`, `REPO_NAME` | `data/zohocrm.sqlite` | index file name (same name in CLI and server) |

## K5. Risks / open items
- **Snapshot size grows with bodies** (190 MB gz at 4 refs). Restore time on AppSail is unmeasured. A master-only snapshot is likely ~110 MB gz (estimated, not measured). Consider compressing bodies with the shared dictionary, or storing bodies only for master + pinned branches.
- **Eviction can drop a branch a session is using.** The session then gets "not indexed yet" and must `switch_branch` again. No in-use tracking yet.
- **Restore peak disk** is roughly gz + raw index. Must be verified on the real 1 GB host.
- **Blocking indexer:** a large branch index still runs on the main thread and can stall requests for ~25-50 s. Move indexing to a worker thread before multi-user use.
- **`commit:` refs** are not in the mirror after a prune; they must be refetched with `ensureIndexed` (verified: `diff_symbols` on a pruned branch re-fetched and re-indexed it in ~3 s).
- Dictionary `zdict.bin` is part of the format: changing it means a full re-index.

## K6. Files
`server/src/db.ts` (v4 schema, packing), `src/indexer.ts`, `src/symbol.ts` (reads bodies), `src/evict.ts` (LRU budget, GC), `src/git.ts` (`pruneRemoteRef`), `src/cli.ts` (`snapshot`, `restore`, `prune`, `mkdict`), `src/zdict.bin`, `deploy/boot.sh`, `deploy/snapshot.sh`.

---

# L. IDLE FLUSH + INDEX WORKER

## L1. Idle policy (committed `5788857`)
Master is always active. Any other branch is indexed on request, kept while used, and dropped after `IDLE_TTL_HOURS` (default 48) without use. An hourly sweep (`SWEEP_MIN`) drops idle refs and garbage-collects rows no other ref uses. Verified on a copy: idle refs dropped, master and the active branch kept.

## L2. Index worker
- Indexing (including `git fetch`) runs in a `worker_threads` worker with its own SQLite connection (`src/indexWorker.ts`, `src/indexPool.ts`). Readers keep working under WAL.
- `busy_timeout` = 30 s, so writers wait for the lock instead of failing.
- Request-path LRU touches are memory-only; persisted every 30 s (`persistTouches`).
- Measured: a 24k-file branch index (805 new blobs, 12.6 s) ran while master searches continued. Worst search latency during the build: **24 ms** (was 967 ms with the index on the main thread, and 1.6 s before the touch and fetch moves).
- Regression: seed eval recall@10 1.0, MRR 0.901; QA end-to-end (diff, summary, coverage gap, impact, error paths) all pass.

## L3. Still on the main thread (known limits)
- Idle flush and budget eviction run on the main thread. A large flush (many GC rows) can block for seconds.
- The 30 s touch persist waits for a worker write lock if one is held (up to one batch).
- A single 2-CPU instance shares CPU between the worker and searches; heavy parsing can slow searches even when the event loop is free.
- Next steps if this shows up: move flush/persist into the worker; add a second worker for parallel branch builds; per-branch overlay files (see the scaling plan).

---

# M. CLOUD DEPLOYMENT + LOCAL SHIM (Catalyst AppSail, Development)

- `crmindex` AppSail (CrmQaAutomation, Development): 2 GB memory, 1 GB disk, pinned to 1 instance.
  Boot: `deploy/start.sh` (POSIX sh: the runtime uses dash) -> unpacks `deps.tgz` (the CLI does not upload
  `node_modules`) -> `deploy/bootstrap.mjs` listens on the public port at once and proxies to the server; its
  `/health` reports boot stage/errors while starting.
- Mirror clone: master-only blobless, HTTP Basic auth with the account login as username (Bearer/Zoho schemes
  are refused; the `repository.` host redirects to `zrepository.` and drops the header, so `GIT_REMOTE` points at
  `zrepository.`). The header is stored in the mirror config so later fetches authenticate. git on AppSail is
  2.43, so the missing-blob pre-check (needs `GIT_NO_LAZY_FETCH`, 2.44+) is skipped.
- Cold start: clone + master index ~2 min (339,447 symbols). Disk is ephemeral; restarts repeat this.
- **Gateway problem:** every `/mcp` POST gets a duplicate empty `400` from the Catalyst gateway (seen in the access
  log, one instance). Plain JSON routes do not. So MCP stays local:
- **REST API** (`/api/status|branches|search|symbol|switch|diff`, bearer `MCP_TOKEN`) + **local stdio shim**
  (`shim/`) that exposes the same tools to AI clients. Verified end to end over stdio against the cloud.

Open: rotate the MCP token (it was pasted in chat); Stratus snapshot restore or a min-1 warm instance to avoid the
2-minute cold rebuild; `smoke.sh` `symbol` step misbehaves under macOS `sh` (endpoint verified directly).
