// Shared test helpers: a fake Alissa API (and, under /github, a fake GitHub API) served from
// fixtures/alissa-world.json, the CLI as a subprocess, and throwaway git repositories.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { httpReader } from "../alissa.ts";
import { githubReader } from "../github.ts";
import type { LintOptions } from "../rules.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURES = join(ROOT, "fixtures");
export const CLI = join(ROOT, "lint", "plan-lint.ts");
export const TOKEN = "test-token";

export interface World {
  projects: Record<string, Record<string, unknown>>;
  objectives: Record<string, Record<string, unknown>>;
  tasks: Record<string, string>;
  feeds: string[];
  steering: unknown[] | null;
  /** Rule 5b: per `owner/repo`, its default branch and the paths that exist there. */
  github: Record<string, { defaultBranch: string; paths: string[] }>;
}

export function loadWorld(): World {
  return JSON.parse(readFileSync(join(FIXTURES, "alissa-world.json"), "utf8")) as World;
}

export interface FakeAlissa {
  base: string;
  /** The fake GitHub API's base URL (GITHUB_API_URL). */
  github: string;
  world: World;
  requests: string[];
  close(): Promise<void>;
}

/** Answers GitHub's repository and contents GETs (rule 5b): a path exists when listed or a parent of one. */
function fakeGithub(world: World, seg: string[], ref: string | null): { status: number; body: unknown } {
  const missing = { status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" } };
  if (seg[0] !== "repos" || seg.length < 3) return missing;
  const repo = world.github[`${seg[1]}/${seg[2]}`];
  if (!repo) return missing;
  if (seg.length === 3) return { status: 200, body: { full_name: `${seg[1]}/${seg[2]}`, default_branch: repo.defaultBranch } };
  if (seg[3] !== "contents" || seg.length < 5) return missing;
  if (ref !== repo.defaultBranch) return { status: 404, body: { message: `No commit found for the ref ${ref}` } };
  const path = seg.slice(4).join("/");
  if (repo.paths.includes(path)) return { status: 200, body: { type: "file", path } };
  if (repo.paths.some((p) => p.startsWith(`${path}/`))) return { status: 200, body: [] };
  return missing;
}

/** Answers the five GETs rules 10–12 make, shaped like the real API's answers. */
export async function fakeAlissa(world: World = loadWorld()): Promise<FakeAlissa> {
  const requests: string[] = [];
  const notFound = (what: string) => ({ error: "Not Found", message: `${what} not found or not accessible.` });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/github/")) {
      if (req.method !== "GET") return send(405, { message: "Method Not Allowed" });
      const seg = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
      const out = fakeGithub(world, seg, url.searchParams.get("ref"));
      return send(out.status, out.body);
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "Unauthorized", message: "Invalid or missing token." });
    if (req.method !== "GET") return send(405, { error: "Method Not Allowed" });
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "v1") return send(404, { error: "Not Found", message: "The requested endpoint does not exist." });
    if (seg[1] === "projects" && seg.length === 3) {
      const p = world.projects[seg[2] as string];
      return p ? send(200, { project: { _id: seg[2], ...p } }) : send(404, notFound("Project"));
    }
    if (seg[1] === "objectives" && seg.length === 3) {
      const o = world.objectives[seg[2] as string];
      return o ? send(200, { _id: seg[2], ...o }) : send(404, notFound("Objective"));
    }
    if (seg[1] === "tasks" && seg.length === 3) {
      const s = world.tasks[seg[2] as string];
      return s ? send(200, { task: { taskNumber: Number((seg[2] as string).slice(5)), status: s } }) : send(404, notFound("Task"));
    }
    if (seg[1] === "bodies-of-work" && seg.length === 2) {
      const bodies = [
        { _id: "k0000000000000000000000000000009", title: "Some milestone", status: "active" },
        ...world.feeds.map((f, i) => ({ _id: `k00000000000000000000000000001${String(i).padStart(2, "0")}`, title: `autodev: ${f}`, status: "active" })),
      ];
      return send(200, { bodiesOfWork: bodies });
    }
    if (seg[1] === "factory" && seg[2] === "steering" && seg.length === 3) {
      return world.steering === null
        ? send(404, { error: "Not Found", message: "The requested endpoint does not exist." })
        : send(200, { records: world.steering });
    }
    return send(404, { error: "Not Found", message: "The requested endpoint does not exist." });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    github: `http://127.0.0.1:${port}/github`,
    world,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Online lint options against a fake: rules 10–12 through `api`, rule 5b through its fake GitHub. */
export function onlineAgainst(api: FakeAlissa, token = TOKEN): LintOptions {
  return {
    online: true,
    reader: httpReader({ base: api.base, token, retries: 0 }),
    github: githubReader({ GITHUB_API_URL: api.github }, { retries: 0 }),
  };
}

/** The env for an online CLI run against a fake. */
export function cliEnv(api: FakeAlissa): Record<string, string> {
  return { ALISSA_API_TOKEN: TOKEN, ALISSA_BASE: api.base, GITHUB_API_URL: api.github };
}

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** The CLI in its own process — asynchronously, so an in-process fake API can answer it. */
export async function runCli(args: string[], env: Record<string, string | undefined> = {}, cwd = ROOT): Promise<Run> {
  const { spawn } = await import("node:child_process");
  const clean: Record<string, string> = {};
  // Never the ambient tokens or APIs: an online run reads only the fakes, and GitHub defaults to a
  // closed port so no test ever reaches the real one.
  const inherited = new Set(["ALISSA_API_TOKEN", "ALISSA_BASE", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL"]);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !inherited.has(k)) clean[k] = v;
  clean.GITHUB_API_URL = "http://127.0.0.1:9";
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { cwd, env: clean });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

/** Each fixture case directory holds exactly one plan directory. */
export function fixturePlan(caseName: string): string {
  const dir = join(FIXTURES, caseName);
  const plans = readdirSync(dir);
  if (plans.length !== 1) throw new Error(`${dir} must hold exactly one plan directory, found ${plans.join(", ")}`);
  return join(dir, plans[0] as string);
}

export function caseNames(): string[] {
  return readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `plan-lint-${prefix}-`));
}

export function copyPlan(caseName: string, into: string): string {
  const src = fixturePlan(caseName);
  const dest = join(into, src.split("/").pop() as string);
  cpSync(src, dest, { recursive: true });
  return dest;
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  }).trim();
}

/** A repository with one commit on `main` holding README.md. */
export function initRepo(): string {
  const repo = tempDir("repo");
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "commit.gpgsign", "false");
  execFileSync("sh", ["-c", "printf '# r\\n' > README.md"], { cwd: repo });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

export function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}
