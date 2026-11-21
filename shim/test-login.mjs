// End-to-end sign-in test against a server running with DEV_FAKE_LOGIN_EMAIL (no real Zoho involved).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: "node", args: ["index.mjs"], env: { ...process.env, CRM_INDEX_NO_BROWSER: "1" }, stderr: "pipe" });
// act as the browser: when the shim prints its sign-in URL, follow it through the redirects
transport.stderr.on("data", async (d) => {
  const m = /sign in at (\S+)/.exec(String(d));
  if (m) { const r = await fetch(m[1], { redirect: "follow" }); console.log(`[browser] followed sign-in -> ${r.status} ${(await r.text()).includes("Signed in") ? "signed-in page" : "?"}`); }
});
const c = new Client({ name: "login-test", version: "0" });
await c.connect(transport);
const call = async (name, args) => { const t0 = Date.now(); const r = await c.callTool({ name, arguments: args }); console.log(`\n### ${name} (${Date.now() - t0}ms)${r.isError ? " ERROR" : ""}\n${r.content[0].text.split("\n").slice(0, 3).join("\n")}`); };
await call("get_code_context", { query: "validate api name for custom button", limit: 2 }); // triggers sign-in, then retries
await call("index_status", {});
await c.close();
