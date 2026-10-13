// Where a plan's files come from: a directory on disk (the session's pre-push run, the fixtures)
// or a pull request's diff read straight from git objects (the CI run). In the git mode nothing of
// the pull request is ever written to disk or executed: every file is a blob read as data. A
// knowledge-base finding (design alissa-build-discovery §3.4, §4.2) is read the same two ways.
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

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

export type PrRead = { kind: "nothing"; changed: string[] } | { kind: "plan"; source: PlanSource } | { kind: "kb"; source: KbSource };

/**
 * The pull-request mode: what `head` changed against its merge base with `base`, read from the
 * object database of `repo`. Only `plans/**` and `knowledge-base/**` blobs are ever read, and only
 * as text. Any `knowledge-base/**` change selects the knowledge-base mode — never "nothing to lint".
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

  if (changes.some((c) => c.path.startsWith(`${KB_ROOT}/`))) return { kind: "kb", source: readKbChanges(repo, base, head, changes) };

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

// ── The knowledge base (design alissa-build-discovery §3.4 K1, §4.2, §7.1) ──────────────────────

export const KB_ROOT = "knowledge-base";
/** `<YYYY>/<MM>/<DD>/TASK-<n>` under `knowledge-base/`: the discovery task's creation day (UTC). */
export const KB_DIR_RE = /^knowledge-base\/([0-9]{4})\/([0-9]{2})\/([0-9]{2})\/TASK-([1-9][0-9]*)$/;
/** Milestone 0's assessment (§7.1): `knowledge-base/assessments/<project-slug>-<yyyy-mm-dd>.md`. */
export const KB_ASSESSMENT_RE = /^knowledge-base\/assessments\/([a-z0-9][a-z0-9-]{0,63})-([0-9]{4})-([0-9]{2})-([0-9]{2})\.md$/;
export const FINDINGS_FILE = "findings.md";

export interface KbSource {
  /** One discovery task's findings directory, or milestone 0's one assessment file. */
  kind: "findings" | "assessment";
  /** `knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>` (findings) or the assessment's path; the given path in the directory mode. */
  label: string;
  /** Findings: the directory's `TASK-<n>`; `null` when the layout does not name one. */
  task: string | null;
  /** Findings: the directory's day, `YYYY-MM-DD`; `null` when the layout does not name one. */
  day: string | null;
  /** Readable files: `findings.md`, or the assessment's file name. */
  files: Map<string, string>;
  sizes: Map<string, number>;
  /** K1 findings made while reading the layout. */
  layout: string[];
  notes: string[];
}

function realDay(y: string, m: string, d: string): boolean {
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)];
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  return date.getUTCFullYear() === yy && date.getUTCMonth() === mm - 1 && date.getUTCDate() === dd;
}

function emptyKb(kind: KbSource["kind"], label: string): KbSource {
  return { kind, label, task: null, day: null, files: new Map(), sizes: new Map(), layout: [], notes: [] };
}

/** K1 over a findings directory's repository path; fills `task` and `day` when they are well formed. */
function checkKbDir(dir: string, src: KbSource): void {
  const m = KB_DIR_RE.exec(dir);
  if (!m) {
    src.layout.push(`\`${dir}\` is not \`knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>\` — a finding is one dated directory per discovery task (§4.2)`);
    return;
  }
  const [, y, mo, d, n] = m as unknown as [string, string, string, string, string];
  if (!realDay(y, mo, d)) src.layout.push(`\`${dir}\` does not name a real calendar date`);
  else src.day = `${y}-${mo}-${d}`;
  src.task = `TASK-${n}`;
}

function checkAssessmentName(path: string, src: KbSource): void {
  const m = KB_ASSESSMENT_RE.exec(path);
  if (!m) {
    src.layout.push(`\`${path}\` is not \`knowledge-base/assessments/<project-slug>-<yyyy-mm-dd>.md\` (§7.1)`);
    return;
  }
  const [, , y, mo, d] = m as unknown as [string, string, string, string, string];
  if (!realDay(y, mo, d)) src.layout.push(`\`${path}\` does not end in a real calendar date`);
}

/**
 * K1 on a pull request: the diff touches exactly one new `knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/`
 * directory holding `findings.md` and nothing else — or, for milestone 0's design task, exactly one
 * new `knowledge-base/assessments/*.md` file and nothing else (whether the PR's task is a design
 * task is K1's online half, in rules.ts). A mix with `plans/**` is refused here.
 */
function readKbChanges(repo: string, base: string, head: string, changes: Array<{ status: string; path: string }>): KbSource {
  const kbChanges = changes.filter((c) => c.path.startsWith(`${KB_ROOT}/`));
  const outside = changes.filter((c) => !c.path.startsWith(`${KB_ROOT}/`));
  const assessments = kbChanges.filter((c) => c.path.startsWith(`${KB_ROOT}/assessments/`));
  const layout: string[] = [];
  for (const c of outside) {
    layout.push(
      c.path.startsWith("plans/")
        ? `the diff touches \`${c.path}\` — a knowledge-base PR never carries a plan (a plan and a finding are separate pull requests)`
        : `the diff touches \`${c.path}\` outside \`${KB_ROOT}/\` — a knowledge-base PR touches its one new directory and nothing else`,
    );
  }

  if (assessments.length > 0) {
    const src = emptyKb("assessment", assessments[0]?.path ?? `${KB_ROOT}/assessments/`);
    src.layout.push(...layout);
    if (kbChanges.length !== 1) {
      src.layout.push(`the diff touches ${kbChanges.length} knowledge-base paths — an assessment PR adds exactly one \`${KB_ROOT}/assessments/*.md\` file and nothing else (§7.1)`);
      return src;
    }
    const c = assessments[0] as { status: string; path: string };
    checkAssessmentName(c.path, src);
    if (c.status !== "A") src.layout.push(`\`${c.path}\` is ${statusWord(c.status)} — an assessment is added once and never edited`);
    else readBlob(repo, head, c.path, c.path.slice(`${KB_ROOT}/assessments/`.length), src);
    return src;
  }

  const dirs = new Set<string>();
  for (const c of kbChanges) {
    const segs = c.path.split("/");
    if (segs.length < 6) layout.push(`the diff touches \`${c.path}\` — a finding lives in \`knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/\``);
    else dirs.add(segs.slice(0, 5).join("/"));
  }
  if (dirs.size !== 1) {
    if (dirs.size > 1) layout.push(`the diff touches ${dirs.size} knowledge-base directories (${[...dirs].sort().map((d) => `\`${d}\``).join(", ")}) — exactly one per PR`);
    const src = emptyKb("findings", `${KB_ROOT}/`);
    src.layout.push(...layout);
    return src;
  }
  const dir = [...dirs][0] as string;
  const src = emptyKb("findings", dir);
  src.layout.push(...layout);
  checkKbDir(dir, src);
  if (git(repo, ["ls-tree", base, "--", dir]).length > 0) {
    src.layout.push(`\`${dir}\` already exists on the base branch — a merged finding is never edited (§4.2); a newer finding names it in \`reverifies\``);
  }
  for (const c of kbChanges) {
    if (c.status !== "A") src.layout.push(`\`${c.path}\` is ${statusWord(c.status)} — a knowledge-base PR only adds files`);
  }
  const tree = git(repo, ["ls-tree", "-r", "-z", "--full-tree", head, "--", `${dir}/`]).toString("utf8");
  for (const rec of tree.split("\0").filter((r) => r !== "")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const [, mode, type, , path] = m as unknown as [string, string, string, string, string];
    const rel = path.slice(`${dir}/`.length);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      src.layout.push(`\`${rel}\` is ${mode === "120000" ? "a symbolic link" : type === "commit" ? "a submodule" : `mode ${mode}`} — a finding holds regular files only`);
    } else if (rel !== FINDINGS_FILE) {
      src.layout.push(`\`${rel}\` does not belong in a findings directory — it holds \`${FINDINGS_FILE}\` and nothing else`);
    } else readBlob(repo, head, path, rel, src);
  }
  if (!src.sizes.has(FINDINGS_FILE)) src.layout.push(`\`${FINDINGS_FILE}\` is missing`);
  return src;
}

/** One regular blob at `head:path`, as `rel`; a symlink or a submodule is K1's finding. */
function readBlob(repo: string, head: string, path: string, rel: string, src: KbSource): void {
  const rec = git(repo, ["ls-tree", "-z", "--full-tree", head, "--", path]).toString("utf8").split("\0")[0] ?? "";
  const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t/.exec(rec);
  if (!m || m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) {
    src.layout.push(`\`${rel}\` is not a regular file`);
    return;
  }
  const size = Number(git(repo, ["cat-file", "-s", m[3] as string]).toString("utf8").trim());
  src.sizes.set(rel, size);
  if (size <= READ_CAP_BYTES) src.files.set(rel, git(repo, ["cat-file", "blob", m[3] as string]).toString("utf8"));
}

/**
 * The directory mode for `--kb <path>`: a findings directory (`…/knowledge-base/<YYYY>/<MM>/<DD>/
 * TASK-<n>/`) or one assessment file (`…/knowledge-base/assessments/<slug>-<date>.md`). The path's
 * last segments name it, wherever the checkout lives. `base` works as `readPlanDir`'s does.
 */
export function readKbDir(path: string, base?: string | null): KbSource {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new UsageError(`${path}: no such file or directory`);
  }
  const segs = abs.split(sep);
  const label = path.replace(/\/+$/, "");
  let src: KbSource;
  let repoPath: string;
  if (st.isFile() && segs.at(-2) === "assessments") {
    repoPath = segs.slice(-3).join("/");
    src = emptyKb("assessment", label);
    checkAssessmentName(repoPath, src);
    const name = segs.at(-1) as string;
    src.sizes.set(name, st.size);
    if (st.size <= READ_CAP_BYTES) src.files.set(name, readFileSync(abs, "utf8"));
  } else if (st.isDirectory()) {
    repoPath = segs.slice(-5).join("/");
    src = emptyKb("findings", label);
    checkKbDir(repoPath, src);
    for (const name of readdirSync(abs).sort()) {
      const entry = lstatSync(join(abs, name));
      if (entry.isSymbolicLink()) src.layout.push(`\`${name}\` is a symbolic link — a finding holds regular files only`);
      else if (name !== FINDINGS_FILE || !entry.isFile()) src.layout.push(`\`${name}\` does not belong in a findings directory — it holds \`${FINDINGS_FILE}\` and nothing else`);
      else {
        src.sizes.set(name, entry.size);
        if (entry.size <= READ_CAP_BYTES) src.files.set(name, readFileSync(join(abs, name), "utf8"));
      }
    }
    if (!src.sizes.has(FINDINGS_FILE)) src.layout.push(`\`${FINDINGS_FILE}\` is missing`);
  } else {
    throw new UsageError(`${path}: --kb takes a knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/ directory or a knowledge-base/assessments/*.md file`);
  }

  if (base === null) {
    src.notes.push("immutability not checked (--no-base)");
    return src;
  }
  const where = st.isDirectory() ? abs : dirname(abs);
  const inRepo = gitOk(where, ["rev-parse", "--is-inside-work-tree"]);
  let ref = base;
  if (ref === undefined && inRepo && gitOk(where, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"])) ref = "refs/remotes/origin/HEAD";
  if (ref === undefined) {
    src.notes.push("immutability not checked: no base branch found (pass --base <ref>)");
    return src;
  }
  assertRev(ref, "--base");
  if (!inRepo) throw new UsageError(`${path} is not inside a git work tree, so --base cannot be read`);
  if (!gitOk(where, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) throw new UsageError(`--base ${ref} does not resolve to a commit`);
  if (gitOk(where, ["cat-file", "-e", `${ref}:${repoPath}`])) {
    src.layout.push(`\`${repoPath}\` already exists on the base branch (${ref}) — a merged ${src.kind === "findings" ? "finding" : "assessment"} is never edited (§4.2)`);
  }
  return src;
}
