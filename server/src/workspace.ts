import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";

export type Selection = { repo: string; branch: string };
export type Caller = { user: string; session?: { repo?: string; branches: Map<string, string> } };
export type WorkspaceArgs = { repo?: string; branch?: string; workspace?: string };

export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Defaults = {
  get(user: string, repo?: string): Promise<Selection | null>;
  put(user: string, context: Selection): Promise<void>;
};

export function localDefaults(db: Db): Defaults {
  const read = db.prepare("SELECT v FROM meta WHERE k=?");
  const write = db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)");
  const get = (key: string) => (read.get(key) as { v: string } | undefined)?.v;
  return {
    async get(user, repo) {
      repo ??= get(`workspace:${user}:repo`);
      if (!repo) return null;
      const branch = get(`workspace:${user}:branch:${repo}`);
      return branch ? { repo, branch } : null;
    },
    async put(user, { repo, branch }) {
      db.transaction(() => {
        write.run(`workspace:${user}:repo`, repo);
        write.run(`workspace:${user}:branch:${repo}`, branch);
      })();
    },
  };
}

export function localSigningKey(db: Db): string {
  db.prepare("INSERT OR IGNORE INTO meta (k,v) VALUES ('workspace-signing-key',?)").run(randomBytes(32).toString("hex"));
  return (db.prepare("SELECT v FROM meta WHERE k='workspace-signing-key'").get() as { v: string }).v;
}

export function validateBranch(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !value || value === "@" ||
      (value.startsWith("commit:") ? !/^commit:[a-f0-9]{7,40}$/i.test(value) :
        /[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|^[-/]|\/$|\/\/|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(value))) {
    throw new RequestError(400, "invalid branch");
  }
  return value;
}

export class Workspaces {
  constructor(private defaults: Defaults, private key: string, private defaultRepo: string) {}

  private subject(caller: Caller) {
    return createHash("sha256").update(caller.user || "anonymous").digest("hex");
  }
  private personal(caller: Caller) { return !!caller.user && caller.user !== "admin"; }

  private signature(payload: string) {
    return createHmac("sha256", this.key).update("crm-workspace-v1." + payload).digest("base64url");
  }

  private decode(caller: Caller, token: string): Selection {
    const parts = token.split(".");
    const [version, payload, sig] = parts;
    const expected = Buffer.from(this.signature(payload ?? ""));
    const got = Buffer.from(sig ?? "");
    if (parts.length === 3 && version === "w1" && expected.length === got.length && timingSafeEqual(expected, got)) {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (data.owner === this.subject(caller)) return { repo: data.repo, branch: data.branch };
    }
    throw new RequestError(403, "invalid workspace for caller");
  }

  async select(caller: Caller, args: WorkspaceArgs, branchRequired = true): Promise<{ repo: string; branch?: string }> {
    const pinned = args.workspace !== undefined ? this.decode(caller, args.workspace) : undefined;
    if (pinned && args.repo && pinned.repo !== args.repo) throw new RequestError(400, "workspace belongs to a different repo");
    const repo = args.repo ?? pinned?.repo ?? caller.session?.repo;
    let branch = args.branch !== undefined ? validateBranch(args.branch) : pinned?.branch;
    branch ??= repo ? caller.session?.branches.get(repo) : undefined;
    const saved = this.personal(caller) && (!repo || !branch) ? await this.defaults.get(this.subject(caller), repo) : null;
    branch ??= saved?.branch;
    if (!branch && (this.personal(caller) || caller.session)) branch = "master";
    if (!branch && branchRequired) throw new RequestError(400, "branch or workspace required for a shared credential");
    return { repo: repo ?? saved?.repo ?? this.defaultRepo, branch };
  }

  async activate(caller: Caller, context: Selection): Promise<string> {
    const owner = this.subject(caller);
    // Record selection at admission. Index completion never writes a selection back.
    if (caller.session) {
      caller.session.repo = context.repo;
      caller.session.branches.set(context.repo, context.branch);
    }
    if (this.personal(caller)) await this.defaults.put(owner, context);
    const payload = Buffer.from(JSON.stringify({ ...context, owner })).toString("base64url");
    return `w1.${payload}.${this.signature(payload)}`;
  }
}
