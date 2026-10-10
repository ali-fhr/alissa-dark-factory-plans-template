// Where a plan's files come from: a directory on disk (the session's pre-push run, the fixtures)
// or a pull request's diff read straight from git objects (the CI run). In the git mode nothing of
// the pull request is ever written to disk or executed: every file is a blob read as data.
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** The largest file the reader loads at all; the real limits (16 KB / 32 KB, §5.4) are rule 7's. */
export const READ_CAP_BYTES = 1024 * 1024;

export const PLAN_ID_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})-[a-z0-9][a-z0-9-]{2,47}$/;

export interface PlanSource {
  /** The plan directory's name — the plan's id (§5.1). */
  id: string;
  /** How the plan is named in output: `plans/<id>` in the git mode, the given path otherwise. */
  label: string;
  /** Readable files, keyed by their path inside the plan directory (`plan.md`, `tasks/<id>.md`). */
  files: Map<string, string>;
  /** Byte size of every file found, readable or not. */
  sizes: Map<string, number>;
  /** Rule 1 findings made while reading the layout. */
  layout: string[];
  /** Informational notes for the output (never a failure). */
  notes: string[];
}

export function isTaskPath(path: string): boolean {
  return /^tasks\/[^/]+\.md$/.test(path);
}

function checkPlanDirName(id: string, layout: string[]): void {
  const m = PLAN_ID_RE.exec(id);
  if (!m) {
    layout.push(`the plan directory \`${id}\` is not \`<yyyy-mm-dd>-<slug>\` (slug \`[a-z0-9-]{3,48}\`, starting with a letter or digit)`);
    return;
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    layout.push(`the plan directory \`${id}\` does not start with a real calendar date`);
  }
}

function git(repo: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function gitOk(repo: string, args: string[]): boolean {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
}

/** A revision argument must never be mistaken for an option. */
export function assertRev(rev: string, name: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./^~@{}-]*$/.test(rev)) {
    throw new UsageError(`${name} \`${rev}\` is not a git revision`);
  }
}

export class UsageError extends Error {}

/**
 * The directory mode. `base` names the branch the immutability half of rule 1 is checked against
 * (`plans/<id>` must not exist there); `undefined` tries `origin/HEAD`, `null` skips the check.
 */
export function readPlanDir(dir: string, base?: string | null): PlanSource {
  const abs = resolve(dir);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new UsageError(`${dir}: no such directory`);
  }
  if (!st.isDirectory()) throw new UsageError(`${dir}: not a directory`);
  const id = basename(abs);
  const src: PlanSource = { id, label: dir.replace(/\/+$/, ""), files: new Map(), sizes: new Map(), layout: [], notes: [] };
  checkPlanDirName(id, src.layout);

  const load = (rel: string, full: string, size: number): void => {
    src.sizes.set(rel, size);
    if (size <= READ_CAP_BYTES) src.files.set(rel, readFileSync(full, "utf8"));
  };

  for (const name of readdirSync(abs).sort()) {
    const full = join(abs, name);
    const entry = lstatSync(full);
    if (entry.isSymbolicLink()) {
      src.layout.push(`\`${name}\` is a symbolic link — a plan holds regular files only`);
    } else if (name === "plan.md" && entry.isFile()) {
      load("plan.md", full, entry.size);
    } else if (name === "tasks" && entry.isDirectory()) {
      for (const tname of readdirSync(full).sort()) {
        const tfull = join(full, tname);
        const tentry = lstatSync(tfull);
        const rel = `tasks/${tname}`;
        if (tentry.isSymbolicLink()) src.layout.push(`\`${rel}\` is a symbolic link — a plan holds regular files only`);
        else if (!tentry.isFile()) src.layout.push(`\`${rel}\` is not a file — \`tasks/\` holds \`<id>.md\` files only`);
        else if (!isTaskPath(rel)) src.layout.push(`\`${rel}\` is not a \`.md\` file — \`tasks/\` holds \`<id>.md\` files only`);
        else load(rel, tfull, tentry.size);
      }
    } else {
      src.layout.push(`\`${name}\` does not belong in a plan directory — it holds \`plan.md\` and \`tasks/<id>.md\`, nothing else`);
    }
  }
  if (!src.sizes.has("plan.md")) src.layout.push("`plan.md` is missing");

  if (base === null) {
    src.notes.push("immutability not checked (--no-base)");
  } else {
    const inRepo = gitOk(abs, ["rev-parse", "--is-inside-work-tree"]);
    let ref = base;
    if (ref === undefined && inRepo && gitOk(abs, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"])) {
      ref = "refs/remotes/origin/HEAD";
    }
    if (ref === undefined) {
      src.notes.push("immutability not checked: no base branch found (pass --base <ref>)");
    } else {
      assertRev(ref, "--base");
      if (!inRepo) throw new UsageError(`${dir} is not inside a git work tree, so --base cannot be read`);
      if (!gitOk(abs, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) throw new UsageError(`--base ${ref} does not resolve to a commit`);
      if (gitOk(abs, ["cat-file", "-e", `${ref}:plans/${id}`])) {
        src.layout.push(`\`plans/${id}\` already exists on the base branch (${ref}) — a merged plan is never edited (D20)`);
      }
    }
  }
  return src;
}

export type PrRead = { kind: "nothing"; changed: string[] } | { kind: "plan"; source: PlanSource };

/**
 * The pull-request mode: what `head` changed against its merge base with `base`, read from the
 * object database of `repo`. Only `plans/**` blobs are ever read, and only as text.
 */
export function readPlanFromGit(repo: string, base: string, head: string): PrRead {
  assertRev(base, "--base");
  assertRev(head, "--head");
  for (const [name, rev] of [["--base", base], ["--head", head]] as const) {
    if (!gitOk(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])) throw new UsageError(`${name} ${rev} is not a commit in ${repo}`);
  }
  const raw = git(repo, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-status", "-z", `${base}...${head}`, "--"]).toString("utf8");
  const parts = raw.split("\0").filter((p) => p !== "");
  const changes: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i] ?? "", path: parts[i + 1] ?? "" });

  const planChanges = changes.filter((c) => c.path.startsWith("plans/"));
  if (planChanges.length === 0) return { kind: "nothing", changed: changes.map((c) => c.path) };

  const layout: string[] = [];
  const outside = changes.filter((c) => !c.path.startsWith("plans/"));
  for (const c of outside) layout.push(`the diff touches \`${c.path}\` outside \`plans/\` — a plan PR touches its own new directory and nothing else`);
  const dirs = new Set<string>();
  for (const c of planChanges) {
    const segs = c.path.split("/");
    if (segs.length < 3) layout.push(`the diff touches \`${c.path}\` directly under \`plans/\` — a plan is a directory`);
    else dirs.add(segs[1] ?? "");
  }
  if (dirs.size !== 1) {
    if (dirs.size > 1) layout.push(`the diff touches ${dirs.size} plan directories (${[...dirs].sort().map((d) => `\`plans/${d}\``).join(", ")}) — exactly one per PR`);
    return { kind: "plan", source: { id: [...dirs][0] ?? "", label: "plans/", files: new Map(), sizes: new Map(), layout, notes: [] } };
  }
  const id = [...dirs][0] ?? "";
  const src: PlanSource = { id, label: `plans/${id}`, files: new Map(), sizes: new Map(), layout, notes: [] };
  checkPlanDirName(id, layout);

  if (git(repo, ["ls-tree", base, "--", `plans/${id}`]).length > 0) {
    layout.push(`\`plans/${id}\` already exists on the base branch — a merged plan is never edited (D20); propose a new plan with \`supersedes: plans/${id}\``);
  }
  for (const c of planChanges) {
    if (c.status !== "A") layout.push(`\`${c.path}\` is ${statusWord(c.status)} — a plan PR only adds files`);
  }

  const tree = git(repo, ["ls-tree", "-r", "-z", "--full-tree", head, "--", `plans/${id}/`]).toString("utf8");
  for (const rec of tree.split("\0").filter((r) => r !== "")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const [, mode, type, sha, path] = m as unknown as [string, string, string, string, string];
    const rel = path.slice(`plans/${id}/`.length);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      layout.push(`\`${rel}\` is ${mode === "120000" ? "a symbolic link" : type === "commit" ? "a submodule" : `mode ${mode}`} — a plan holds regular files only`);
      continue;
    }
    if (rel !== "plan.md" && !isTaskPath(rel)) {
      layout.push(`\`${rel}\` does not belong in a plan directory — it holds \`plan.md\` and \`tasks/<id>.md\`, nothing else`);
      continue;
    }
    const size = Number(git(repo, ["cat-file", "-s", sha]).toString("utf8").trim());
    src.sizes.set(rel, size);
    if (size <= READ_CAP_BYTES) src.files.set(rel, git(repo, ["cat-file", "blob", sha]).toString("utf8"));
  }
  if (!src.sizes.has("plan.md")) layout.push("`plan.md` is missing");
  return { kind: "plan", source: src };
}

function statusWord(status: string): string {
  switch (status.charAt(0)) {
    case "M": return "modified";
    case "D": return "deleted";
    case "T": return "changed in type";
    default: return `changed (${status})`;
  }
}
