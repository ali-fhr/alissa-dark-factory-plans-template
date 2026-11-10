// Where a plan's files come from: a directory on disk (the session's pre-push run, the fixtures)
// or a pull request's diff read straight from git objects (the CI run). In the git mode nothing of
// the pull request is ever written to disk or executed: every file is a blob read as data. A
// knowledge-base finding (design alissa-build-discovery §3.4, §4.2) and an integration-check run
// (design alissa-build-integration-check §3.4, §3.5) are read the same two ways.
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

/** Whether anything (a file, a directory, a dangling symbolic link) sits at `abs`. */
function pathPresent(abs: string): boolean {
  try {
    lstatSync(abs);
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

export type PrRead =
  | { kind: "nothing"; changed: string[] }
  /** `reportData`: the one `report-data.json` a Report plan's PR adds beside its plan (alissa-code-security-reports §4.1). */
  | { kind: "plan"; source: PlanSource; reportData?: KbSource }
  | { kind: "kb"; source: KbSource }
  | { kind: "ic"; source: IcSource };

/**
 * The pull-request mode: what `head` changed against its merge base with `base`, read from the
 * object database of `repo`. Only `plans/**`, `knowledge-base/**` and `integration-check/**` blobs
 * are ever read, and only as data. Any `integration-check/**` change selects the integration-check
 * mode, and otherwise any `knowledge-base/**` change the knowledge-base mode — never "nothing to lint".
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

  if (changes.some((c) => c.path.startsWith(`${IC_ROOT}/`))) return { kind: "ic", source: readIcChanges(repo, base, head, changes) };
  const planChanges = changes.filter((c) => c.path.startsWith("plans/"));
  // A Report plan's PR (alissa-code-security-reports §4.1): a PR that adds a plan and touches a
  // security report's run directory is a plan PR, which may add that directory's report-data.json.
  const reportPlan = planChanges.some((c) => c.status === "A") && changes.some((c) => c.path.startsWith(`${SECURITY_REPORTS_ROOT}/`));
  if (!reportPlan && changes.some((c) => c.path.startsWith(`${KB_ROOT}/`))) return { kind: "kb", source: readKbChanges(repo, base, head, changes) };

  if (planChanges.length === 0) return { kind: "nothing", changed: changes.map((c) => c.path) };

  const layout: string[] = [];
  const outside = changes.filter((c) => !c.path.startsWith("plans/"));
  const reportData = reportPlan ? readReportPlanData(repo, base, head, outside, layout) : undefined;
  for (const c of outside) {
    if (reportPlan && c.path.startsWith(`${SECURITY_REPORTS_ROOT}/`)) continue; // judged by readReportPlanData
    layout.push(`the diff touches \`${c.path}\` outside \`plans/\` — a plan PR touches its own new directory and nothing else`);
  }
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
  return { kind: "plan", source: src, ...(reportData === undefined ? {} : { reportData }) };
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
/**
 * A finding's optional `evidence/` folder (operator decision 2026-10-20, amending §4.2): flat,
 * regular files only. The types K1 admits; the text ones are read for K5's scan (and the svg check).
 */
export const KB_EVIDENCE_TYPES = ["png", "jpg", "jpeg", "webp", "svg", "csv", "json", "mmd", "d2", "txt", "log"] as const;
export const KB_TEXT_EVIDENCE_TYPES = ["svg", "csv", "json", "mmd", "d2", "txt", "log"] as const;
/** The largest evidence file K4 admits (2 MB); a file up to it is read, past it only sized. */
export const KB_EVIDENCE_READ_CAP = 2 * 1024 * 1024;

/** The lower-cased extension of `rel`, or `undefined` when it has none. */
export function extensionOf(rel: string): string | undefined {
  return /\.([^./]+)$/.exec(rel)?.[1]?.toLowerCase();
}

export function isKbTextEvidence(rel: string): boolean {
  const ext = extensionOf(rel);
  return ext !== undefined && (KB_TEXT_EVIDENCE_TYPES as readonly string[]).includes(ext);
}

export interface KbSource {
  /** One discovery task's findings directory, milestone 0's one assessment file, or a security report's run directory. */
  kind: "findings" | "assessment" | "security-report";
  /** `knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>` (findings) or the assessment's path; the given path in the directory mode. */
  label: string;
  /** Findings: the directory's `TASK-<n>`; `null` when the layout does not name one. */
  task: string | null;
  /** Findings: the directory's day, `YYYY-MM-DD`; `null` when the layout does not name one. */
  day: string | null;
  /** Readable text files: `findings.md` and text `evidence/<file>`, or the assessment's file name. */
  files: Map<string, string>;
  /** Byte size of every regular file found (`findings.md`, `evidence/<file>`). */
  sizes: Map<string, number>;
  /** The bytes of every `evidence/<file>` within the read cap, for K1's type check. */
  evidence: Map<string, Buffer>;
  /** K1 findings made while reading the layout. */
  layout: string[];
  notes: string[];
  /** A security report's run directory: the review id its name carries; `null` when the layout does not name one. */
  reviewId?: string | null;
  /** A security report's run directory: `report-data.json` as the base branch holds it (its first commit), when it does. */
  firstData?: string | null;
}

function realDay(y: string, m: string, d: string): boolean {
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)];
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  return date.getUTCFullYear() === yy && date.getUTCMonth() === mm - 1 && date.getUTCDate() === dd;
}

function emptyKb(kind: KbSource["kind"], label: string): KbSource {
  return { kind, label, task: null, day: null, files: new Map(), sizes: new Map(), evidence: new Map(), layout: [], notes: [] };
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

// ── A Code Security report's run directory (design alissa-code-security-reports §4.1, §4.3, lane CSR-2)

export const SECURITY_REPORTS_ROOT = `${KB_ROOT}/security-reports`;
/** `knowledge-base/security-reports/<yyyy-mm-dd>-<reviewId>`: the review's `createdAt` day (UTC) and its id. */
export const SECURITY_REPORT_DIR_RE = /^knowledge-base\/security-reports\/([0-9]{4})-([0-9]{2})-([0-9]{2})-([a-z0-9]{1,64})$/;
export const SECURITY_REPORT_DATA_FILE = "report-data.json";
const SECURITY_REPORT_HOLDS = "a run directory is flat: `report-data.json`, `summary.md` and `technical-<repo-slug>.md` files, regular files only";

/** K1 over a run directory's repository path; fills `day` and `reviewId` when they are well formed. */
function checkSecurityReportDir(dir: string, src: KbSource): void {
  const m = SECURITY_REPORT_DIR_RE.exec(dir);
  if (!m) {
    src.layout.push(`\`${dir}\` is not \`${SECURITY_REPORTS_ROOT}/<yyyy-mm-dd>-<reviewId>\` — a security report is one run directory per review (alissa-code-security-reports §4.1)`);
    return;
  }
  const [, y, mo, d, id] = m as unknown as [string, string, string, string, string];
  if (!realDay(y, mo, d)) src.layout.push(`\`${dir}\` does not start with a real calendar date`);
  else src.day = `${y}-${mo}-${d}`;
  src.reviewId = id;
}

/**
 * K1 on a pull request that touches `knowledge-base/security-reports/**`: every change is inside one
 * run directory, one level deep, and only adds files — a merged report file is never edited (the
 * record is immutable, §4.4). An edited `report-data.json` is K19's finding ("changed after its
 * first commit"), so its base text is kept. Every regular file of the directory at `head` is read,
 * the ones already merged included: the rules judge the run directory as it will stand.
 */
function readSecurityReportChanges(repo: string, base: string, head: string, kbChanges: Array<{ status: string; path: string }>, layout: string[]): KbSource {
  const dirs = new Set<string>();
  for (const c of kbChanges) {
    const segs = c.path.split("/");
    if (segs[1] !== "security-reports" || segs.length < 4) layout.push(`the diff touches \`${c.path}\` — a security report PR touches one \`${SECURITY_REPORTS_ROOT}/<yyyy-mm-dd>-<reviewId>/\` directory and nothing else`);
    else {
      dirs.add(segs.slice(0, 3).join("/"));
      if (segs.length > 4) layout.push(`\`${c.path}\` is a nested path — ${SECURITY_REPORT_HOLDS}`);
    }
  }
  if (dirs.size !== 1) {
    if (dirs.size > 1) layout.push(`the diff touches ${dirs.size} security report directories (${[...dirs].sort().map((d) => `\`${d}\``).join(", ")}) — exactly one per PR`);
    const src = emptyKb("security-report", `${SECURITY_REPORTS_ROOT}/`);
    src.layout.push(...layout);
    return src;
  }
  const dir = [...dirs][0] as string;
  const src = emptyKb("security-report", dir);
  src.layout.push(...layout);
  checkSecurityReportDir(dir, src);
  for (const c of kbChanges) {
    if (!c.path.startsWith(`${dir}/`) || c.status === "A") continue;
    if (c.path === `${dir}/${SECURITY_REPORT_DATA_FILE}` && c.status.charAt(0) === "M") continue;
    src.layout.push(`\`${c.path}\` is ${statusWord(c.status)} — a merged report file is never edited (alissa-code-security-reports §4.4)`);
  }
  const dataPath = `${dir}/${SECURITY_REPORT_DATA_FILE}`;
  if (gitOk(repo, ["cat-file", "-e", `${base}:${dataPath}`])) src.firstData = git(repo, ["cat-file", "blob", `${base}:${dataPath}`]).toString("utf8");
  const tree = git(repo, ["ls-tree", "-r", "-z", "--full-tree", head, "--", `${dir}/`]).toString("utf8");
  for (const rec of tree.split("\0").filter((r) => r !== "")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const [, mode, type, sha, path] = m as unknown as [string, string, string, string, string];
    const rel = path.slice(`${dir}/`.length);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      src.layout.push(`\`${rel}\` is ${mode === "120000" ? "a symbolic link" : type === "commit" ? "a submodule" : `mode ${mode}`} — ${SECURITY_REPORT_HOLDS}`);
      continue;
    }
    if (rel.includes("/")) continue; // a nested path, already K1's finding when the diff added it
    const size = Number(git(repo, ["cat-file", "-s", sha]).toString("utf8").trim());
    src.sizes.set(rel, size);
    if (size <= READ_CAP_BYTES) src.files.set(rel, git(repo, ["cat-file", "blob", sha]).toString("utf8"));
    else src.layout.push(`\`${rel}\` is ${size} bytes — past the ${READ_CAP_BYTES}-byte read cap`);
  }
  return src;
}

/**
 * Rule 1 on a Report plan's PR (alissa-code-security-reports §4.1): beside its plan, the PR may add
 * exactly one `knowledge-base/security-reports/<yyyy-mm-dd>-<reviewId>/report-data.json`, so the data
 * file lands before any Report task starts. Every other security-report path is rule 1's finding,
 * pushed into `layout` naming the path; the admitted file is read for K19's data-file checks, which
 * the caller runs beside the plan's rules. A data file the base branch already holds is refused here
 * (rule 1) and its base text kept, so K19 reports it changed after its first commit.
 */
function readReportPlanData(repo: string, base: string, head: string, outside: Array<{ status: string; path: string }>, layout: string[]): KbSource | undefined {
  const reportChanges = outside.filter((c) => c.path.startsWith(`${SECURITY_REPORTS_ROOT}/`));
  const isDataPath = (p: string): boolean => {
    const segs = p.split("/");
    return segs.length === 4 && segs[3] === SECURITY_REPORT_DATA_FILE;
  };
  const admitted = reportChanges.find((c) => isDataPath(c.path));
  const dir = admitted === undefined ? null : admitted.path.slice(0, -`/${SECURITY_REPORT_DATA_FILE}`.length);
  const src = emptyKb("security-report", admitted?.path ?? `${SECURITY_REPORTS_ROOT}/`);
  for (const c of reportChanges) {
    if (c === admitted) continue;
    layout.push(
      isDataPath(c.path)
        ? `the diff touches \`${c.path}\` — a plan PR adds at most one run directory's \`${SECURITY_REPORT_DATA_FILE}\` (alissa-code-security-reports §4.1)`
        : `the diff touches \`${c.path}\` — a plan PR adds only its run directory's \`${SECURITY_REPORT_DATA_FILE}\`; the report files come from the Report tasks' own pull requests (alissa-code-security-reports §4.1)`,
    );
  }
  if (admitted === undefined || dir === null) return undefined;
  checkSecurityReportDir(dir, src);
  if (admitted.status !== "A") layout.push(`\`${admitted.path}\` is ${statusWord(admitted.status)} — a plan PR only adds its run directory's data file, and a data file never changes after its first commit (K19)`);
  if (gitOk(repo, ["cat-file", "-e", `${base}:${admitted.path}`])) {
    src.firstData = git(repo, ["cat-file", "blob", `${base}:${admitted.path}`]).toString("utf8");
    if (admitted.status === "A") layout.push(`\`${admitted.path}\` already exists on the base branch — a data file is committed once (K19)`);
  }
  if (admitted.status.charAt(0) === "D") return src;
  const rec = git(repo, ["ls-tree", "-z", "--full-tree", head, "--", admitted.path]).toString("utf8").split("\0")[0] ?? "";
  const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t/.exec(rec);
  if (!m || m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) {
    src.layout.push(`\`${SECURITY_REPORT_DATA_FILE}\` is ${m?.[1] === "120000" ? "a symbolic link" : m?.[2] === "commit" ? "a submodule" : "not a regular file"} — ${SECURITY_REPORT_HOLDS}`);
    return src;
  }
  const size = Number(git(repo, ["cat-file", "-s", m[3] as string]).toString("utf8").trim());
  src.sizes.set(SECURITY_REPORT_DATA_FILE, size);
  if (size <= READ_CAP_BYTES) src.files.set(SECURITY_REPORT_DATA_FILE, git(repo, ["cat-file", "blob", m[3] as string]).toString("utf8"));
  else src.layout.push(`\`${SECURITY_REPORT_DATA_FILE}\` is ${size} bytes — past the ${READ_CAP_BYTES}-byte read cap`);
  return src;
}

/** `--kb <run-dir>`: the directory's regular files, flat. */
function readSecurityReportDir(abs: string, label: string, repoPath: string): KbSource {
  const src = emptyKb("security-report", label);
  checkSecurityReportDir(repoPath, src);
  for (const name of readdirSync(abs).sort()) {
    const entry = lstatSync(join(abs, name));
    if (entry.isSymbolicLink()) src.layout.push(`\`${name}\` is a symbolic link — ${SECURITY_REPORT_HOLDS}`);
    else if (entry.isDirectory()) src.layout.push(`\`${name}/\` is a directory — ${SECURITY_REPORT_HOLDS}`);
    else if (!entry.isFile()) src.layout.push(`\`${name}\` is not a regular file — ${SECURITY_REPORT_HOLDS}`);
    else {
      src.sizes.set(name, entry.size);
      if (entry.size <= READ_CAP_BYTES) src.files.set(name, readFileSync(join(abs, name), "utf8"));
      else src.layout.push(`\`${name}\` is ${entry.size} bytes — past the ${READ_CAP_BYTES}-byte read cap`);
    }
  }
  return src;
}

/**
 * The directory mode's immutability for a run directory: a file the base branch holds must be
 * present and byte-equal here (a report file merged by an earlier task's PR); `report-data.json`'s
 * base text is kept for K19. `where` is the run directory itself.
 */
function checkSecurityReportBase(where: string, ref: string, repoPath: string, src: KbSource): void {
  if (gitOk(where, ["cat-file", "-e", `${ref}:${repoPath}`])) {
    const merged = git(where, ["ls-tree", "--full-tree", "--name-only", "-z", `${ref}:${repoPath}`]).toString("utf8").split("\0").filter((n) => n !== "");
    for (const name of merged.sort()) {
      if (!src.sizes.has(name) && !pathPresent(join(where, name))) {
        src.layout.push(`\`${repoPath}/${name}\` exists on the base branch (${ref}) but not here — a merged report file is never deleted (alissa-code-security-reports §4.4)`);
      }
    }
  }
  for (const [name, text] of src.files) {
    const spec = `${ref}:${repoPath}/${name}`;
    if (!gitOk(where, ["cat-file", "-e", spec])) continue;
    const merged = git(where, ["cat-file", "blob", spec]).toString("utf8");
    if (name === SECURITY_REPORT_DATA_FILE) src.firstData = merged;
    else if (merged !== text) src.layout.push(`\`${repoPath}/${name}\` already exists on the base branch (${ref}) with other content — a merged report file is never edited (alissa-code-security-reports §4.4)`);
  }
}

/**
 * K1 on a pull request: the diff touches exactly one new `knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/`
 * directory holding `findings.md` and, optionally, a flat `evidence/` folder — or, for milestone 0's design task, exactly one
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

  if (kbChanges.some((c) => c.path.startsWith(`${SECURITY_REPORTS_ROOT}/`))) return readSecurityReportChanges(repo, base, head, kbChanges, layout);

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
    const [, mode, type, sha, path] = m as unknown as [string, string, string, string, string];
    const rel = path.slice(`${dir}/`.length);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      src.layout.push(`\`${rel}\` is ${mode === "120000" ? "a symbolic link" : type === "commit" ? "a submodule" : `mode ${mode}`} — a finding holds regular files only`);
    } else if (rel === FINDINGS_FILE) readBlob(repo, head, path, rel, src);
    else if (!kbMember(rel, src)) continue;
    else {
      const size = Number(git(repo, ["cat-file", "-s", sha]).toString("utf8").trim());
      keepEvidence(rel, size, () => git(repo, ["cat-file", "blob", sha]), src);
    }
  }
  if (!src.sizes.has(FINDINGS_FILE)) src.layout.push(`\`${FINDINGS_FILE}\` is missing`);
  return src;
}

const KB_HOLDS = `it holds \`${FINDINGS_FILE}\` and, optionally, \`evidence/<file>\` (flat), nothing else`;

/**
 * Is `rel` (inside a findings directory, not `findings.md`) a place a finding may hold a file —
 * `evidence/<file>`, one level deep? If not, K1's finding is recorded and the answer is no.
 */
function kbMember(rel: string, src: KbSource): boolean {
  const segs = rel.split("/");
  if (segs[0] === EVIDENCE_DIR && segs.length === 2 && segs[1] !== "") return true;
  if (segs[0] === EVIDENCE_DIR && segs.length > 2) {
    src.layout.push(`\`${rel.replace(/\/$/, "")}\` is a nested path — \`${EVIDENCE_DIR}/\` is flat: \`${EVIDENCE_DIR}/<file>\`, no subfolders`);
  } else src.layout.push(`\`${rel}\` does not belong in a findings directory — ${KB_HOLDS}`);
  return false;
}

/** Records an evidence file's size and, within the read cap, its bytes (and its text, for a text type). */
function keepEvidence(rel: string, size: number, read: () => Buffer, src: KbSource): void {
  src.sizes.set(rel, size);
  if (size > KB_EVIDENCE_READ_CAP) return;
  const bytes = read();
  src.evidence.set(rel, bytes);
  if (isKbTextEvidence(rel)) src.files.set(rel, bytes.toString("utf8"));
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
 * TASK-<n>/`), one assessment file (`…/knowledge-base/assessments/<slug>-<date>.md`) or a security
 * report's run directory (`…/knowledge-base/security-reports/<yyyy-mm-dd>-<reviewId>/`). The path's
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
  if (st.isDirectory() && segs.at(-2) === "security-reports") {
    repoPath = segs.slice(-3).join("/");
    src = readSecurityReportDir(abs, label, repoPath);
  } else if (st.isFile() && segs.at(-2) === "assessments") {
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
      else if (name === EVIDENCE_DIR && entry.isDirectory()) {
        for (const ev of readdirSync(join(abs, name)).sort()) {
          const rel = `${EVIDENCE_DIR}/${ev}`;
          const f = join(abs, name, ev);
          const e = lstatSync(f);
          if (e.isSymbolicLink()) src.layout.push(`\`${rel}\` is a symbolic link — a finding holds regular files only`);
          else if (e.isDirectory()) kbMember(`${rel}/`, src);
          else if (!e.isFile()) src.layout.push(`\`${rel}\` is not a regular file — a finding holds regular files only`);
          else keepEvidence(rel, e.size, () => readFileSync(f), src);
        }
      } else if (name !== FINDINGS_FILE || !entry.isFile()) src.layout.push(`\`${name}\` does not belong in a findings directory — ${KB_HOLDS}`);
      else {
        src.sizes.set(name, entry.size);
        if (entry.size <= READ_CAP_BYTES) src.files.set(name, readFileSync(join(abs, name), "utf8"));
      }
    }
    if (!src.sizes.has(FINDINGS_FILE)) src.layout.push(`\`${FINDINGS_FILE}\` is missing`);
  } else {
    throw new UsageError(`${path}: --kb takes a knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/ directory, a knowledge-base/assessments/*.md file or a knowledge-base/security-reports/<yyyy-mm-dd>-<reviewId>/ directory`);
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
  if (src.kind === "security-report") checkSecurityReportBase(where, ref, repoPath, src);
  else if (gitOk(where, ["cat-file", "-e", `${ref}:${repoPath}`])) {
    src.layout.push(`\`${repoPath}\` already exists on the base branch (${ref}) — a merged ${src.kind === "findings" ? "finding" : "assessment"} is never edited (§4.2)`);
  }
  return src;
}

// ── The integration check (design alissa-build-integration-check §3.4, §3.5 I1) ───────────────────

export const IC_ROOT = "integration-check";
/** `<YYYY>/<MM>/<DD>/<milestone>` under `integration-check/`: the run's start day (UTC) and its milestone. */
export const IC_DIR_RE = /^integration-check\/([0-9]{4})\/([0-9]{2})\/([0-9]{2})\/([^/]+)$/;
/** `<project-slug>-m<n>`, the slug at most 32 characters, and `-r<k>` for a same-day re-run (§3.4, Q1). */
export const IC_MILESTONE_RE = /^([a-z0-9][a-z0-9-]{0,31})-m(0|[1-9][0-9]*)(?:-r([2-9]|[1-9][0-9]+))?$/;
export const REPORT_FILE = "report.md";
export const EVIDENCE_DIR = "evidence";
/** Evidence types read as text (I8 scans them); the rest of I7's types are binary and only sized. */
export const IC_TEXT_TYPES = ["log", "txt", "json", "yml"] as const;
/** The largest evidence file I7 admits (2 MB); a text file up to it is read for I8. */
export const IC_TEXT_READ_CAP = 2 * 1024 * 1024;

export interface IcSource {
  /** `integration-check/<YYYY>/<MM>/<DD>/<milestone>`; the given path in the directory mode. */
  label: string;
  /** The run directory's day, `YYYY-MM-DD`; `null` when the layout does not name one. */
  day: string | null;
  /** The `m<n>` of the directory's `<milestone>`; `null` when the layout does not name one. */
  milestoneN: number | null;
  /** Readable text files, keyed by their path inside the run directory (`report.md`, `evidence/<file>`). */
  files: Map<string, string>;
  /** Byte size of every regular file found (`report.md`, `evidence/**`). */
  sizes: Map<string, number>;
  /** I1 findings made while reading the layout. */
  layout: string[];
  notes: string[];
}

function emptyIc(label: string): IcSource {
  return { label, day: null, milestoneN: null, files: new Map(), sizes: new Map(), layout: [], notes: [] };
}

export function isTextEvidence(rel: string): boolean {
  const ext = /\.([^./]+)$/.exec(rel)?.[1];
  return ext !== undefined && (IC_TEXT_TYPES as readonly string[]).includes(ext);
}

/** I1 over a run directory's repository path; fills `day` and `milestoneN` when they are well formed. */
function checkIcDir(dir: string, src: IcSource): void {
  const m = IC_DIR_RE.exec(dir);
  if (!m) {
    src.layout.push(`\`${dir}\` is not \`integration-check/<YYYY>/<MM>/<DD>/<milestone>\` — a run is one dated directory per milestone (§3.4)`);
    return;
  }
  const [, y, mo, d, name] = m as unknown as [string, string, string, string, string];
  if (!realDay(y, mo, d)) src.layout.push(`\`${dir}\` does not name a real calendar date`);
  else src.day = `${y}-${mo}-${d}`;
  const mm = IC_MILESTONE_RE.exec(name);
  if (!mm) src.layout.push(`\`${name}\` is not \`<project-slug>-m<n>\` (slug \`[a-z0-9-]{1,32}\`, \`-r<k>\` for a same-day re-run, §3.4)`);
  else src.milestoneN = Number(mm[2]);
}

/** Is `rel` (inside the run directory) a file the run may hold: `report.md` or `evidence/<path>`? */
function icMember(rel: string): boolean {
  return rel === REPORT_FILE || (rel.startsWith(`${EVIDENCE_DIR}/`) && rel.length > EVIDENCE_DIR.length + 1);
}

/**
 * I1 on a pull request: the diff adds exactly one new `integration-check/<YYYY>/<MM>/<DD>/<milestone>/`
 * directory holding `report.md` and `evidence/**`, and nothing else — a mix with `plans/**` or
 * `knowledge-base/**` included.
 */
function readIcChanges(repo: string, base: string, head: string, changes: Array<{ status: string; path: string }>): IcSource {
  const icChanges = changes.filter((c) => c.path.startsWith(`${IC_ROOT}/`));
  const layout: string[] = [];
  for (const c of changes.filter((x) => !x.path.startsWith(`${IC_ROOT}/`))) {
    layout.push(
      c.path.startsWith("plans/") ? `the diff touches \`${c.path}\` — an integration-check PR never carries a plan`
      : c.path.startsWith(`${KB_ROOT}/`) ? `the diff touches \`${c.path}\` — an integration-check PR never carries a finding`
      : `the diff touches \`${c.path}\` outside \`${IC_ROOT}/\` — an integration-check PR touches its one new run directory and nothing else`,
    );
  }
  const dirs = new Set<string>();
  for (const c of icChanges) {
    const segs = c.path.split("/");
    if (segs.length < 6) layout.push(`the diff touches \`${c.path}\` — a run lives in \`${IC_ROOT}/<YYYY>/<MM>/<DD>/<milestone>/\``);
    else dirs.add(segs.slice(0, 5).join("/"));
  }
  if (dirs.size !== 1) {
    if (dirs.size > 1) layout.push(`the diff touches ${dirs.size} integration-check directories (${[...dirs].sort().map((d) => `\`${d}\``).join(", ")}) — exactly one per PR`);
    const src = emptyIc(`${IC_ROOT}/`);
    src.layout.push(...layout);
    return src;
  }
  const dir = [...dirs][0] as string;
  const src = emptyIc(dir);
  src.layout.push(...layout);
  checkIcDir(dir, src);
  if (git(repo, ["ls-tree", base, "--", dir]).length > 0) {
    src.layout.push(`\`${dir}\` already exists on the base branch — a merged run is never edited (§3.4); a new run is a new directory that names it in \`previous\``);
  }
  for (const c of icChanges) {
    if (c.status !== "A") src.layout.push(`\`${c.path}\` is ${statusWord(c.status)} — an integration-check PR only adds files`);
  }
  const tree = git(repo, ["ls-tree", "-r", "-z", "--full-tree", head, "--", `${dir}/`]).toString("utf8");
  for (const rec of tree.split("\0").filter((r) => r !== "")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const [, mode, type, sha, path] = m as unknown as [string, string, string, string, string];
    const rel = path.slice(`${dir}/`.length);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      src.layout.push(`\`${rel}\` is ${mode === "120000" ? "a symbolic link" : type === "commit" ? "a submodule" : `mode ${mode}`} — a run holds regular files only`);
      continue;
    }
    if (!icMember(rel)) {
      src.layout.push(`\`${rel}\` does not belong in a run directory — it holds \`${REPORT_FILE}\` and \`${EVIDENCE_DIR}/**\`, nothing else`);
      continue;
    }
    const size = Number(git(repo, ["cat-file", "-s", sha]).toString("utf8").trim());
    src.sizes.set(rel, size);
    const cap = rel === REPORT_FILE ? READ_CAP_BYTES : isTextEvidence(rel) ? IC_TEXT_READ_CAP : -1;
    if (size <= cap) src.files.set(rel, git(repo, ["cat-file", "blob", sha]).toString("utf8"));
  }
  if (!src.sizes.has(REPORT_FILE)) src.layout.push(`\`${REPORT_FILE}\` is missing`);
  return src;
}

/**
 * The directory mode for `--ic <dir>`: one run directory (`…/integration-check/<YYYY>/<MM>/<DD>/
 * <milestone>/`), named by the path's last segments wherever the checkout lives. `base` works as
 * `readPlanDir`'s does.
 */
export function readIcDir(path: string, base?: string | null): IcSource {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new UsageError(`${path}: no such directory`);
  }
  if (!st.isDirectory()) throw new UsageError(`${path}: --ic takes an integration-check/<YYYY>/<MM>/<DD>/<milestone>/ directory`);
  const repoPath = abs.split(sep).slice(-5).join("/");
  const src = emptyIc(path.replace(/\/+$/, ""));
  checkIcDir(repoPath, src);

  const walk = (full: string, rel: string): void => {
    for (const name of readdirSync(full).sort()) {
      const f = join(full, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const entry = lstatSync(f);
      if (entry.isSymbolicLink()) src.layout.push(`\`${r}\` is a symbolic link — a run holds regular files only`);
      else if (entry.isDirectory() && (r === EVIDENCE_DIR || r.startsWith(`${EVIDENCE_DIR}/`))) walk(f, r);
      else if (!entry.isFile() || !icMember(r)) src.layout.push(`\`${r}\` does not belong in a run directory — it holds \`${REPORT_FILE}\` and \`${EVIDENCE_DIR}/**\`, nothing else`);
      else {
        src.sizes.set(r, entry.size);
        const cap = r === REPORT_FILE ? READ_CAP_BYTES : isTextEvidence(r) ? IC_TEXT_READ_CAP : -1;
        if (entry.size <= cap) src.files.set(r, readFileSync(f, "utf8"));
      }
    }
  };
  walk(abs, "");
  if (!src.sizes.has(REPORT_FILE)) src.layout.push(`\`${REPORT_FILE}\` is missing`);

  // CI lints the commit, this mode the file system: a file git will not push passes here and fails there.
  const inRepo = gitOk(abs, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo) {
    const others = (ignored: boolean): string[] =>
      git(abs, ["ls-files", "-z", "--others", "--exclude-standard", ...(ignored ? ["--ignored"] : []), "--", "."])
        .toString("utf8")
        .split("\0")
        .filter((r) => r !== "");
    for (const r of others(true)) src.layout.push(`\`${r}\` is ignored by git, so it never reaches the commit CI lints — commit it with \`git add -f\` or un-ignore it`);
    for (const r of others(false)) src.notes.push(`\`${r}\` is not tracked by git yet — stage it before pushing`);
  }

  if (base === null) {
    src.notes.push("immutability not checked (--no-base)");
    return src;
  }
  let ref = base;
  if (ref === undefined && inRepo && gitOk(abs, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"])) ref = "refs/remotes/origin/HEAD";
  if (ref === undefined) {
    src.notes.push("immutability not checked: no base branch found (pass --base <ref>)");
    return src;
  }
  assertRev(ref, "--base");
  if (!inRepo) throw new UsageError(`${path} is not inside a git work tree, so --base cannot be read`);
  if (!gitOk(abs, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) throw new UsageError(`--base ${ref} does not resolve to a commit`);
  if (gitOk(abs, ["cat-file", "-e", `${ref}:${repoPath}`])) {
    src.layout.push(`\`${repoPath}\` already exists on the base branch (${ref}) — a merged run is never edited (§3.4)`);
  }
  return src;
}
