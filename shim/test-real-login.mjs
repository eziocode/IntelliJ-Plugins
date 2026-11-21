// Real Zoho sign-in test: prints the sign-in URL (no browser opened), waits for the callback, then calls tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
const transport = new StdioClientTransport({ command: "node", args: ["index.mjs"], env: { ...process.env, CRM_INDEX_NO_BROWSER: "1" }, stderr: "pipe" });
transport.stderr.on("data", (d) => { const m = /sign in at (\S+)/.exec(String(d)); if (m) { writeFileSync(process.env.URL_FILE, m[1]); console.log("sign-in URL written"); } });
const c = new Client({ name: "real-login", version: "0" });
await c.connect(transport);
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 240_000 }); console.log(`### ${name}${r.isError ? " ERROR" : ""}\n${r.content[0].text.split("\n").slice(0, 3).join("\n")}`); };
await call("login", {}); // waits up to ~50 s for the browser step
await call("index_status", {});
await call("get_code_context", { query: "validate api name for custom button", limit: 2 });
await c.close();
