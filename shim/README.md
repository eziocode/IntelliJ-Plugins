# crm-index shim

Local MCP server for the central CRM code index. Your AI client (Claude Code, Cursor, ...) talks MCP to this
small process on your machine; the shim forwards each tool call to the index service over plain HTTPS JSON.
Nothing is indexed locally.

Why a shim: the Catalyst AppSail gateway mishandles MCP's streamable-HTTP session requests (every `/mcp` POST
gets a duplicate empty `400`), while ordinary JSON requests pass cleanly. The shim keeps MCP local.

## Install

```bash
cd shim && npm install
```

Requires Node 20+.

## Add to Claude Code

```bash
claude mcp add crm-index \
  -e CRM_INDEX_URL=https://crmindex.development.catalystappsail.in \
  -- node /absolute/path/to/shim/index.mjs
```

No token is needed. The first time a tool runs, your browser opens the Catalyst sign-in page for the index
(Zoho-owned login). After you sign in, the session is saved in `~/.crm-index/` (readable only by you). When it
expires (7 days by default), the next tool call opens the browser again. Only accounts from the allowed email
domain (default `zohocorp.com`) get in. If the page says "Sign in required", sign in and then open the link again
or re-run the tool.

Run the `login` tool to sign in again or switch accounts. `CRM_INDEX_TOKEN` is an optional admin key that skips
the browser (for automation); do not commit it or paste it into chats.

## Tools

| Tool | What it does |
|---|---|
| `get_code_context` | Ranked symbol cards (id, signature, path:lines) for a query. Bodies are not included. |
| `get_symbol` | Full source of one symbol by id (classes return a member outline). |
| `list_branches` | Branches filtered by substring (the repo has ~18k). `*` = indexed. |
| `switch_branch` | Make a branch active for your session; indexes it on the server if needed. |
| `diff_symbols` | Changed methods/classes between two branches (default: active branch vs master). |
| `login` | Sign in (or re-sign in) with Zoho. Opens a browser. |
| `index_status` | Indexed branches, symbol counts, running jobs, your active branch. |

The active branch is kept in the shim process, per user session.

## Behaviour notes

- If the service is starting (after a restart it re-indexes master, ~2 min), calls are retried briefly, then
  return "starting or unreachable".
- `switch_branch` waits up to ~45 s. Big branches may still be indexing when it returns; searches then warn that
  results may be incomplete.

## Test

```bash
CRM_INDEX_URL=... CRM_INDEX_TOKEN=... node test-client.mjs   # admin key
CRM_INDEX_URL=http://localhost:8787 node test-login.mjs        # sign-in flow, against a server run with DEV_FAKE_LOGIN_EMAIL
```
