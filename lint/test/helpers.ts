// Shared test helpers: a fake Alissa API (and, under /github, a fake GitHub API) served from
// fixtures/alissa-world.json, the CLI as a subprocess, and throwaway git repositories.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { httpPoster, httpReader } from "../alissa.ts";
import { githubReader } from "../github.ts";
import type { KbLintOptions, LintOptions } from "../rules.ts";

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

/**
 * The knowledge-base fixtures' Alissa and code state (K6, K7, an assessment's task). It lives here
 * rather than in fixtures/alissa-world.json, which the plan fixtures own and this lane leaves as is.
 */
export const KB_SHA = "3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4";
export const KB_CREATED = Date.UTC(2026, 9, 14, 9, 30);

export interface KbWorld {
  /**
   * `TASK-<n>` → what `GET /v1/tasks/:id?view=full` answers; `reads` becomes the Alissa-Reads trailer
   * (`none` included), `sources` the Alissa-Sources trailer and `asker` the Alissa-Asker trailer.
   */
  tasks: Record<string, { kind: string; createdAt: number; reads?: string; sources?: string; asker?: string; ownerId?: string }>;
  /** `<repo>@<sha>:<path>` → the blob and line count Studio's verify route reads there. */
  files: Record<string, { blob: string; lines: number }>;
  /** A URL → how the page answers Studio's guarded fetch (K8): a status and its visible text, a timeout, or the guard's refusal. */
  pages?: Record<string, { status: number; text?: string } | "timeout" | "guard">;
}

export const KB_OWNER = "j57owner000000000000000000000001";

export function kbWorld(): KbWorld {
  const discovery = { kind: "discovery", createdAt: KB_CREATED, reads: `example-org/service-b@${KB_SHA}` };
  const tasks: KbWorld["tasks"] = {};
  for (const n of [1234, 1301, 1302, 1303, 1304, 1305, 1307]) tasks[`TASK-${n}`] = { ...discovery };
  tasks["TASK-1306"] = { ...discovery, kind: "code" };
  tasks["TASK-2000"] = { kind: "design", createdAt: KB_CREATED };
  tasks["TASK-2001"] = { kind: "code", createdAt: KB_CREATED };
  // v1.1: the web golden is an ask from TASK-1200 that reads code and pages; each K8 case reads pages only.
  tasks["TASK-1200"] = { kind: "code", createdAt: KB_CREATED };
  tasks["TASK-1240"] = { ...discovery, sources: "both", asker: "TASK-1200" };
  for (const n of [1801, 1802, 1803, 1804, 1805]) tasks[`TASK-${n}`] = { kind: "discovery", createdAt: KB_CREATED, reads: "none", sources: "web" };
  const at = (path: string) => `example-org/service-b@${KB_SHA}:${path}`;
  const docs = "Failed deliveries are retried with exponential backoff for up to three days. After that the event is dropped.";
  return {
    tasks,
    files: {
      [at("src/config/load.ts")]: { blob: "9ad0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c", lines: 900 },
      [at("src/config/keys.ts")]: { blob: "51be2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", lines: 64 },
      [at("config/.env.production")]: { blob: "9ad0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c", lines: 900 },
    },
    pages: {
      "https://docs.example.com/webhooks/retries": { status: 200, text: `Webhooks\n\n${docs}` },
      "https://status.example.com/history": { status: 200, text: "Incident history. Webhook delivery was degraded for 41 minutes on 2026-09-30." },
      "https://docs.example.com/limits": { status: 200, text: "Rate limits. Each account may send 100 requests per second." },
      "https://docs.example.com/removed-page": { status: 404, text: "Not found" },
      "https://docs.example.com/members-only": { status: 403, text: "Sign in to continue" },
      "https://docs.example.com/flaky": { status: 503 },
      "https://docs.example.com/changed": { status: 200, text: "This page has moved on: retries now follow the new policy." },
      "https://web.archive.org/web/20261014100230/https://docs.example.com/changed": { status: 200, text: docs },
    },
  };
}

export interface FakeAlissa {
  base: string;
  /** The fake GitHub API's base URL (GITHUB_API_URL). */
  github: string;
  world: World;
  kb: KbWorld;
  /** How the verify route answers: `up`, an HTTP status, or an answer of the wrong shape. */
  verify: "up" | "bad-shape" | number;
  /** The bodies K7 posted. */
  verifyBodies: unknown[];
  /** How the url-cites route answers (K8): `up`, an HTTP status, or an answer of the wrong shape. */
  urlVerify: "up" | "bad-shape" | number;
  /** The bodies K8 posted. */
  urlVerifyBodies: unknown[];
  requests: string[];
  close(): Promise<void>;
}

/** Studio's `POST /v1/factory/repo-files/verify` (lane DS-3), as the linter expects it to answer. */
function fakeVerify(kb: KbWorld, body: unknown): { status: number; body: unknown } {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return { status: 400, body: { error: "Bad Request", message: "files is required" } };
  const results = files.map((f: { repo: string; sha: string; path: string; blob: string; lines: string }) => {
    const file = kb.files[`${f.repo}@${f.sha}:${f.path}`];
    if (!file) return { ok: false, reason: "path_missing" };
    if (file.blob !== f.blob) return { ok: false, reason: "blob_mismatch", detail: `the blob at ${f.sha.slice(0, 7)} is ${file.blob.slice(0, 7)}` };
    const end = Number(f.lines.split("-").pop());
    if (end > file.lines) return { ok: false, reason: "lines_out_of_range", detail: `the file has ${file.lines} lines` };
    return { ok: true };
  });
  return { status: 200, body: { results } };
}

/**
 * Studio's `POST /v1/factory/url-cites/verify` (lane DS-11), modelled on its verify core: the live
 * page, then the archive, each `holds`, `missing` (it answered without the quote), `gone`, `blocked`
 * or `unavailable`; the verdict is §3.4's. The match folds case and whitespace only.
 */
function fakeUrlVerify(kb: KbWorld, body: unknown): { status: number; body: unknown } {
  const cites = (body as { cites?: unknown } | null)?.cites;
  if (!Array.isArray(cites)) return { status: 400, body: { error: "Bad Request", message: "cites is required" } };
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  const copy = (url: string, quote: string): { kind: string; guard?: boolean } => {
    const page = kb.pages?.[url];
    if (page === "guard") return { kind: "blocked", guard: true };
    if (page === "timeout") return { kind: "unavailable" };
    const status = page?.status ?? 404;
    if (status >= 500) return { kind: "unavailable" };
    if (status === 404 || status === 410) return { kind: "gone" };
    if (status >= 400) return { kind: "blocked" };
    return { kind: norm(page?.text ?? "").includes(norm(quote)) ? "holds" : "missing" };
  };
  const results = cites.map((c: { url: string; quote: string; archive?: string }) => {
    const live = copy(c.url, c.quote);
    if (live.kind === "holds") return { verdict: "holds" };
    const archive = c.archive === undefined ? null : copy(c.archive, c.quote);
    if (archive?.kind === "holds") return { verdict: "archived", archive: c.archive, detail: "the live page does not hold the quote; the archive does" };
    const copies = archive ? [live, archive] : [live];
    if (copies.some((x) => x.kind === "unavailable")) return { verdict: "unavailable", detail: `${c.url} answered 503` };
    if (copies.some((x) => x.kind === "missing")) return { verdict: "refuted", detail: "the quote is in neither copy" };
    if (live.kind === "gone" && archive === null) return { verdict: "gone", detail: `${c.url} answered 404` };
    return { verdict: "blocked", ...(copies.some((x) => x.guard) ? { guard: "fetchGuard" } : {}), detail: `${c.url} answered 403` };
  });
  return { status: 200, body: { results } };
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
export async function fakeAlissa(world: World = loadWorld(), kb: KbWorld = kbWorld()): Promise<FakeAlissa> {
  const requests: string[] = [];
  let api: FakeAlissa | null = null;
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
    if (req.method === "POST" && url.pathname === "/v1/factory/url-cites/verify") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        api?.urlVerifyBodies.push(parsed);
        const mode = api?.urlVerify ?? "up";
        if (typeof mode === "number") return send(mode, { error: "Unavailable", message: "The url-cites route is down." });
        if (mode === "bad-shape") return send(200, { results: [{ ok: true }] });
        const out = fakeUrlVerify(kb, parsed);
        send(out.status, out.body);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/factory/repo-files/verify") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        api?.verifyBodies.push(parsed);
        const mode = api?.verify ?? "up";
        if (typeof mode === "number") return send(mode, { error: "Unavailable", message: "The verify route is down." });
        if (mode === "bad-shape") return send(200, { verified: true });
        const out = fakeVerify(kb, parsed);
        send(out.status, out.body);
      });
      return;
    }
    if (req.method !== "GET") return send(405, { error: "Method Not Allowed" });
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] === "v1" && seg[1] === "tasks" && seg.length === 3 && kb.tasks[seg[2] as string]) {
      const k = kb.tasks[seg[2] as string] as KbWorld["tasks"][string];
      const full = url.searchParams.get("view") === "full";
      const trailers = [`Alissa-Kind: ${k.kind}`, ...(k.reads ? [`Alissa-Reads: ${k.reads}`] : []), ...(k.sources ? [`Alissa-Sources: ${k.sources}`] : []), ...(k.asker ? [`Alissa-Asker: ${k.asker}`] : [])];
      const description = `A discovery task of the fixtures.\n\n${trailers.join("\n")}\nAutonomous-Dev: example-org/plans`;
      const task = { taskNumber: Number((seg[2] as string).slice(5)), status: "in_progress", kind: k.kind, createdAt: k.createdAt, ownerId: k.ownerId ?? KB_OWNER };
      return send(200, { task: { ...task, ...(full ? { description } : {}) } });
    }
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
  api = {
    base: `http://127.0.0.1:${port}`,
    github: `http://127.0.0.1:${port}/github`,
    world,
    kb,
    verify: "up",
    verifyBodies: [],
    urlVerify: "up",
    urlVerifyBodies: [],
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return api;
}

/** Online knowledge-base options against a fake: K6 through `api`'s tasks, K7 through its verify route. */
export function kbOnlineAgainst(api: FakeAlissa, prTask: string | null = null, token = TOKEN): KbLintOptions {
  return { online: true, reader: httpReader({ base: api.base, token, retries: 0 }), verifier: httpPoster({ base: api.base, token, retries: 0 }), prTask };
}

/** A knowledge-base fixture case: its one findings directory, or its one assessment file. */
export function kbFixture(caseName: string): string {
  const kb = join(FIXTURES, caseName, "knowledge-base");
  const assessments = join(kb, "assessments");
  try {
    const files = readdirSync(assessments);
    if (files.length !== 1) throw new Error(`${assessments} must hold exactly one assessment`);
    return join(assessments, files[0] as string);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let dir = kb;
  for (let depth = 0; depth < 4; depth++) {
    const entries = readdirSync(dir);
    if (entries.length !== 1) throw new Error(`${dir} must hold exactly one entry, found ${entries.join(", ")}`);
    dir = join(dir, entries[0] as string);
  }
  return dir;
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
  const inherited = new Set(["ALISSA_API_TOKEN", "ALISSA_BASE", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL", "GITHUB_HEAD_REF"]);
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
