// Usage: node server/deploy/build-job-parser.mjs FUNCTION_DIRECTORY
// Package only Node built-ins, JS parser bindings, and the three portable WASM files.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../", import.meta.url));
if (!process.argv[2]) throw new Error("Pass the Catalyst Job Function directory");
const dest = resolve(process.argv[2], "parser");
await mkdir(dest, { recursive: true });
execFileSync(join(server, "node_modules/.bin/tsc"), ["--ignoreConfig", "--module", "NodeNext", "--target", "ES2022",
  "--types", "node", "--skipLibCheck", "--strict", "--esModuleInterop", "--outDir", dest,
  "src/branchArtifact.ts"], { cwd: server, stdio: "inherit" });
await writeFile(join(dest, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
const assets = [
  "web-tree-sitter/package.json", "web-tree-sitter/tree-sitter.js", "web-tree-sitter/tree-sitter.wasm", "web-tree-sitter/LICENSE",
  "tree-sitter-wasms/package.json", "tree-sitter-wasms/LICENSE",
  "tree-sitter-wasms/out/tree-sitter-java.wasm", "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
];
for (const asset of assets) {
  const target = join(dest, "node_modules", asset);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(server, "node_modules", asset), target);
}
