// The twelve rules of design §5.5, and rule 5b of loop-operator-surface §2.12 (L12), evaluated in
// order over one plan. Every rule runs (so a fixture can prove it fails exactly one); the verdict is
// the first failure, with its rule named.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import { minimatch } from "minimatch";
import { type AlissaPoster, type AlissaReader, AlissaUnavailable, describe, isTransient } from "./alissa.ts";
import { contentsPath, repoPath } from "./github.ts";
import { charLength, level2Sections, listItems, parseFrontmatter, splitFrontmatter } from "./markdown.ts";
import {
  DAG_BEGIN, DAG_END, SUMMARY_BEGIN, SUMMARY_END, isRecord, oneLine, readRegion, renderDag, renderSummary, taskView, type TaskView,
} from "./render.ts";
import {
  EVIDENCE_DIR, FINDINGS_FILE, type IcSource, KB_EVIDENCE_READ_CAP, KB_EVIDENCE_TYPES, type KbSource, type PlanSource, REPORT_FILE, SECURITY_REPORT_DATA_FILE, extensionOf, isKbTextEvidence, isTaskPath,
} from "./source.ts";

/** A §5.5 rule number, or `5b` — the scope-path preflight, which runs with the online rules. */
export type RuleId = number | "5b";

export const RULE_NAMES: Readonly<Record<RuleId, string>> = {
  1: "layout and immutability",
  2: "frontmatter",
  3: "count",
  4: "graph",
  5: "scope",
  "5b": "scope paths",
  6: "class",
  7: "body",
  8: "generated sections",
  9: "sources",
  10: "anchor",
  11: "external edges",
  12: "repositories and off-limits",
};

/** §7.1's severity order, most severe first; a task's `commitClass` draws on the last ten. */
export const CLASS_ORDER = [
  "unanchored", "schema-migration", "auth-secrets", "pricing-billing", "customer-promise", "product-surface",
  "gate-verification", "drift-fix", "flaky-test", "exhaust-followup", "doc-correction",
] as const;

/** Rule 9: the source-key prefixes each exhaust class takes; `doc-correction` takes any. */
export const EXHAUST_SOURCE_PREFIXES: Readonly<Record<string, readonly string[] | null>> = {
  "drift-fix": ["drift"],
  "gate-verification": ["gate"],
  "flaky-test": ["esc"],
  "exhaust-followup": ["later", "minor"],
  "doc-correction": null,
};

/** §5.4. */
export const LIMITS = {
  tasksMin: 1, tasksMax: 8,
  descriptionMin: 400, descriptionMax: 8000,
  definitionOfDoneMin: 40,
  criteriaMin: 1, criteriaMax: 12,
  taskFileBytes: 16 * 1024, planFileBytes: 32 * 1024,
  externalEdgesMax: 1,
} as const;

const TOP_LEVEL_WIDE = /^[^/*?[\]{}]+\/(\*\*|\*)(\/\*\*|\/\*)*$/;
const CLOSED_MILESTONE = new Set(["completed", "missed", "cancelled"]);
const LIVING_TASK = new Set(["pending_validation", "validated"]);

export interface Failure {
  rule: RuleId;
  file?: string;
  message: string;
  /**
   * The rule could not be checked: Alissa stayed unreachable, rate-limited (429) or erroring (5xx)
   * through every retry. Reported as "plan-lint could not run" — retry the run, not fix the plan.
   */
  couldNotRun?: boolean;
}

export interface LintResult {
  plan: string;
  taskCount: number;
  planClass: string | null;
  failures: Failure[];
  rulesRun: RuleId[];
  notes: string[];
  /** Findings that refuse nothing but are never a silent pass — rule 5b's `scope_path_unknown`. */
  warnings: string[];
}

/**
 * What rendering needs from a task file. Schema v1.3 lets a `sources: web` discovery task omit
 * `repo` — it reads pages, not a repository — so the Summary names `web` in its place.
 */
export function planTaskView(fm: unknown): TaskView | null {
  if (isRecord(fm) && fm.repo === undefined && fm.kind === "discovery" && fm.sources === "web") return taskView({ ...fm, repo: "web" });
  return taskView(fm);
}

/** `reader` reads Alissa (rules 10–12); `github` reads the target repositories (rule 5b). */
export type LintOptions = { online: false } | { online: true; reader: AlissaReader; github: AlissaReader };

interface TaskInfo {
  file: string;
  fm: unknown;
  body: string | null;
  /** No rule 2 finding on this file. */
  clean: boolean;
  view: TaskView | null;
}

const Ajv = AjvModule.default;
let validators: { plan: ValidateFunction; task: ValidateFunction } | null = null;

export function schemas(): { plan: ValidateFunction; task: ValidateFunction } {
  if (!validators) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
    const load = (name: string): object => JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")) as object;
    validators = { plan: ajv.compile(load("plan-frontmatter.v1.json")), task: ajv.compile(load("task-frontmatter.v1.json")) };
  }
  return validators;
}

/** A value from the plan, safe to print: one line, bounded. */
export function clean(v: unknown): string {
  const s = oneLine(typeof v === "string" ? v : JSON.stringify(v) ?? String(v));
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function ajvMessage(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
  // Schema v1.2's `kind: discovery` branch: a field the branch forbids is a `false` schema.
  if (e.keyword === "false schema") return `${where} is not allowed on this kind of task (schema v1.3: a discovery task has \`questions\` and no \`scope\` or \`new\`; a code or design task the reverse, and no \`asker\`)`;
  const extra =
    e.keyword === "additionalProperties" ? ` \`${clean((e.params as { additionalProperty: string }).additionalProperty)}\``
    : e.keyword === "enum" ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`
    : "";
  return `${where} ${e.message ?? e.keyword}${extra}`;
}

/** Rule 6 owns the `commitClass` field of the task schema; rule 2 owns the rest of it. */
function isClassError(e: ErrorObject): boolean {
  return e.instancePath === "/commitClass" || (e.keyword === "required" && (e.params as { missingProperty?: string }).missingProperty === "commitClass");
}

export function planClassOf(classes: string[]): string | null {
  let best: number | null = null;
  for (const c of classes) {
    const i = (CLASS_ORDER as readonly string[]).indexOf(c);
    if (i > 0 && (best === null || i < best)) best = i;
  }
  return best === null ? null : (CLASS_ORDER[best] ?? null);
}

/** Rule 5: why a scope entry is too broad, or `null` when it is fine. */
export function scopeProblem(entry: string): string | null {
  const e = entry.replace(/^\.\//, "");
  if (e.trim() === "") return "is empty";
  if (e.startsWith("/") || e.split("/").includes("..")) return "leaves the repository (absolute or `..`)";
  if (e === "**" || e === "*") return "is a bare wildcard over the whole repository";
  const segs = e.split("/");
  if (segs.every((s) => /[*?[\]{}]/.test(s))) return "has no literal path segment — it spans the whole repository";
  if (TOP_LEVEL_WIDE.test(e)) return "is a directory-wide glob over a top-level directory — name files or go two segments deep";
  return null;
}

/** Rule 12: a scope glob and an off-limits glob overlap when either matches the other. */
export function overlaps(scope: string, offLimit: string): boolean {
  const s = scope.replace(/^\.\//, "");
  const o = offLimit.replace(/^\.\//, "");
  if (s === o) return true;
  return minimatch(s, o, { dot: true }) || minimatch(o, s, { dot: true });
}

export async function lint(src: PlanSource, opts: LintOptions): Promise<LintResult> {
  const failures: Failure[] = [];
  const notes = [...src.notes];
  const warnings: string[] = [];
  const fail: Fail = (rule, message, file, couldNotRun = false) => {
    failures.push({ rule, ...(file === undefined ? {} : { file }), message, ...(couldNotRun ? { couldNotRun } : {}) });
  };

  // Rule 1 — layout and immutability (found by the reader).
  for (const m of src.layout) fail(1, m);

  const taskPaths = [...src.sizes.keys()].filter(isTaskPath).sort();
  const result = (planClass: string | null, rulesRun: RuleId[]): LintResult => ({
    plan: src.label, taskCount: taskPaths.length, planClass, failures: sortFailures(failures), rulesRun, notes, warnings,
  });
  if (!src.files.has("plan.md")) {
    if (src.sizes.has("plan.md")) fail(7, `plan.md is ${src.sizes.get("plan.md")} bytes; the limit is ${LIMITS.planFileBytes}`, "plan.md");
    notes.push("rules 2–12 not run: no readable plan.md");
    return result(null, [1]);
  }
  const { plan: validatePlan, task: validateTask } = schemas();

  // Rule 2 — frontmatter: plan.md.
  const planText = src.files.get("plan.md") as string;
  let planFm: Record<string, unknown> | null = null;
  let planBody: string | null = null;
  let planClean = false;
  {
    const split = splitFrontmatter(planText);
    if (!split.ok) fail(2, `plan.md ${split.error}`, "plan.md");
    else {
      planBody = split.body;
      const parsed = parseFrontmatter(split.frontmatter);
      if (!parsed.ok) fail(2, parsed.error, "plan.md");
      else if (!validatePlan(parsed.value)) {
        for (const e of validatePlan.errors ?? []) fail(2, `plan.md frontmatter ${ajvMessage(e)}`, "plan.md");
      } else {
        planFm = parsed.value as Record<string, unknown>;
        planClean = true;
        if (planFm.id !== src.id) {
          fail(2, `plan.md's id \`${clean(planFm.id)}\` is not its directory's name \`${clean(src.id)}\``, "plan.md");
          planClean = false;
        }
      }
    }
  }

  // Rule 2 (task files) and rule 6 (their commitClass).
  const tasks: TaskInfo[] = [];
  for (const file of taskPaths) {
    const text = src.files.get(file);
    if (text === undefined) continue; // over the read cap: rule 7 reports the size
    const info: TaskInfo = { file, fm: null, body: null, clean: false, view: null };
    tasks.push(info);
    const split = splitFrontmatter(text);
    if (!split.ok) {
      fail(2, `${file} ${split.error}`, file);
      continue;
    }
    info.body = split.body;
    const parsed = parseFrontmatter(split.frontmatter);
    if (!parsed.ok) {
      fail(2, parsed.error, file);
      continue;
    }
    info.fm = parsed.value;
    info.view = planTaskView(parsed.value);
    let rule2 = 0;
    if (!validateTask(parsed.value)) {
      // `if` only says which v1.2 branch failed; the branch's own errors say why.
      for (const e of (validateTask.errors ?? []).filter((x) => x.keyword !== "if")) {
        if (isClassError(e)) {
          const refuters = isRecord(info.fm) && info.fm.commitClass === "unanchored" ? " — `unanchored` is the refuter's alone (§4.3)"
            : isRecord(info.fm) && info.fm.kind === "discovery" ? " — a discovery task is always `doc-correction` (schema v1.2)" : "";
          fail(6, `frontmatter ${ajvMessage(e)}${refuters}`, file);
        }
        else {
          fail(2, `frontmatter ${ajvMessage(e)}`, file);
          rule2++;
        }
      }
    }
    if (isRecord(parsed.value) && Array.isArray(parsed.value.new) && Array.isArray(parsed.value.scope)) {
      const scope = new Set(parsed.value.scope);
      for (const n of parsed.value.new) {
        if (!scope.has(n)) {
          fail(2, `frontmatter /new entry \`${clean(n)}\` is not in \`scope\` — every path declared new is also a scope entry (schema v1.1)`, file);
          rule2++;
        }
      }
    }
    if (isRecord(parsed.value) && typeof parsed.value.id === "string" && `tasks/${parsed.value.id}.md` !== file) {
      fail(2, `the file is named \`${clean(file.slice(6))}\` but its id is \`${clean(parsed.value.id)}\` — a task file is \`<id>.md\``, file);
      rule2++;
    }
    info.clean = rule2 === 0;
  }
  const cleanTasks = tasks.filter((t) => t.clean && isRecord(t.fm));
  const fmOf = (t: TaskInfo): Record<string, unknown> => t.fm as Record<string, unknown>;

  // Rule 3 — count.
  if (taskPaths.length < LIMITS.tasksMin || taskPaths.length > LIMITS.tasksMax) {
    fail(3, `the plan has ${taskPaths.length} task files; a plan has ${LIMITS.tasksMin}–${LIMITS.tasksMax} (D7)`);
  }

  // Rule 4 — graph.
  const knownIds = new Set(tasks.map((t) => (isRecord(t.fm) && typeof t.fm.id === "string" ? t.fm.id : null)).filter((x): x is string => x !== null));
  const adjacency = new Map<string, string[]>();
  for (const t of cleanTasks) {
    const fm = fmOf(t);
    const id = fm.id as string;
    const edges = (fm.dependsOn as Array<Record<string, unknown>>) ?? [];
    const seen = new Set<string>();
    let external = 0;
    const ups: string[] = [];
    for (const e of edges) {
      const key = typeof e.id === "string" ? `id:${e.id}` : `task:${String(e.task)}`;
      if (seen.has(key)) fail(4, `dependsOn names \`${clean(key.slice(key.indexOf(":") + 1))}\` twice`, t.file);
      seen.add(key);
      if (typeof e.task === "string") {
        external++;
        continue;
      }
      const up = e.id as string;
      if (up === id) fail(4, `task \`${clean(id)}\` depends on itself`, t.file);
      else if (!knownIds.has(up)) fail(4, `dependsOn.id \`${clean(up)}\` names no task in this plan`, t.file);
      else ups.push(up);
    }
    if (external > LIMITS.externalEdgesMax) fail(4, `dependsOn has ${external} external \`TASK-<n>\` entries; at most ${LIMITS.externalEdgesMax} (§5.4)`, t.file);
    adjacency.set(id, ups);
  }
  const cycle = findCycle(adjacency);
  if (cycle) fail(4, `the dependency graph has a cycle: ${cycle.map(clean).join(" → ")}`);

  // Rule 5 — scope.
  for (const t of cleanTasks) {
    for (const entry of scopeOf(fmOf(t))) {
      const why = scopeProblem(entry);
      if (why) fail(5, `scope entry \`${clean(entry)}\` ${why}`, t.file);
    }
  }

  // Rule 6 — class: the plan's class, most severe of its tasks (§7.1), for the summary.
  const planClass = planClassOf(tasks.map((t) => (isRecord(t.fm) && typeof t.fm.commitClass === "string" ? t.fm.commitClass : "")));

  // Rule 7 — body and sizes (§5.4).
  const planBytes = src.sizes.get("plan.md") ?? 0;
  if (planBytes > LIMITS.planFileBytes) fail(7, `plan.md is ${planBytes} bytes; the limit is ${LIMITS.planFileBytes} (§5.4)`, "plan.md");
  for (const file of taskPaths) {
    const bytes = src.sizes.get(file) ?? 0;
    if (bytes > LIMITS.taskFileBytes) fail(7, `the task file is ${bytes} bytes; the limit is ${LIMITS.taskFileBytes} (§5.4)`, file);
  }
  for (const t of tasks) if (t.body !== null) for (const m of bodyProblems(t.body)) fail(7, m, t.file);

  // Rule 8 — generated sections equal what --write renders.
  const views = tasks.map((t) => t.view);
  if (planBody === null) notes.push("rule 8 not evaluated: plan.md's frontmatter does not split (rule 2)");
  else if (tasks.length !== taskPaths.length || views.some((v) => v === null)) notes.push("rule 8 not evaluated: a task file cannot be rendered (rule 2)");
  else {
    const rendered = views as TaskView[];
    for (const [begin, end, want, what] of [
      [SUMMARY_BEGIN, SUMMARY_END, renderSummary(rendered), "Summary"],
      [DAG_BEGIN, DAG_END, renderDag(rendered), "Dependency graph"],
    ] as const) {
      const region = readRegion(planBody, begin, end);
      if (!region.ok) fail(8, `plan.md's ${what}: ${region.error}`, "plan.md");
      else if (region.inner !== want) {
        fail(8, `plan.md's ${what} is not what \`plan-lint --write\` renders from the task files — run it and commit the result (D17); ${firstDifference(want, region.inner)}`, "plan.md");
      }
    }
  }

  // Rule 9 — sources.
  if (planClean && planFm) {
    const planKeys = new Set(((planFm.sources as Array<{ key: string }>) ?? []).map((s) => s.key));
    for (const t of cleanTasks) {
      // A discovery task's `sources` may name `code | web | both` (schema v1.3) instead of source keys.
      const keys = fmOf(t).sources;
      for (const key of Array.isArray(keys) ? (keys as string[]) : []) {
        if (!planKeys.has(key)) fail(9, `source \`${clean(key)}\` is not one of plan.md's sources`, t.file);
      }
    }
    const anchor = planFm.anchor as Record<string, unknown>;
    if (anchor.kind === "exhaust") {
      const cls = anchor.class as string;
      if (planKeys.size === 0) fail(9, `an exhaust anchor (${cls}) needs at least one source in plan.md`, "plan.md");
      const prefixes = EXHAUST_SOURCE_PREFIXES[cls];
      if (prefixes) {
        for (const key of planKeys) {
          const prefix = key.slice(0, key.indexOf(":"));
          if (!prefixes.includes(prefix)) fail(9, `source \`${clean(key)}\` is not of the anchor's class ${cls} (takes ${prefixes.map((p) => `\`${p}:\``).join(", ")})`, "plan.md");
        }
      }
    }
  } else notes.push("rule 9 not evaluated against plan.md: its frontmatter is not valid (rule 2)");

  const rulesRun: RuleId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  if (!opts.online) {
    notes.push("rules 10–12 and 5b not run (offline)");
    return result(planClass, rulesRun);
  }
  rulesRun.push(10, 11, 12, "5b");
  if (planClean && planFm) {
    await online(planFm, cleanTasks, opts.reader, fail);
  } else {
    notes.push("rules 10 and 12 not evaluated: plan.md's frontmatter is not valid (rule 2)");
    await externalEdges(cleanTasks, opts.reader, fail);
  }
  await scopePaths(cleanTasks, opts.github, fail, (m) => warnings.push(m));
  return result(planClass, rulesRun);
}

type Fail = (rule: RuleId, message: string, file?: string, couldNotRun?: boolean) => void;

/** A task's scope; a discovery task has none (schema v1.2 — feed_plan derives it under knowledge-base/). */
function scopeOf(fm: Record<string, unknown>): string[] {
  return Array.isArray(fm.scope) ? (fm.scope as string[]) : [];
}

/** Rule 5b: the repository path a scope entry names, or `null` for a glob (never checked, D12). */
export function literalScopePath(entry: string): string | null {
  const e = entry.replace(/^\.\//, "").replace(/\/+$/, "");
  return /[*?[\]{}]/.test(e) ? null : e;
}

type Head = { ok: true; branch: string } | { ok: false; why: string };

/**
 * Rule 5b (loop-operator-surface D12, §8.1): every non-glob scope path exists at its repository's
 * default branch or is declared in `new`. Missing is `scope_path_missing`, a refusal; a repository
 * or a path that cannot be read is `scope_path_unknown`, a warning — never a pass, never a refusal.
 */
async function scopePaths(tasks: TaskInfo[], github: AlissaReader, fail: Fail, warn: (m: string) => void): Promise<void> {
  const heads = new Map<string, Promise<Head>>();
  const headOf = (repo: string): Promise<Head> => {
    let h = heads.get(repo);
    if (!h) {
      h = (async (): Promise<Head> => {
        try {
          const res = await github.get(repoPath(repo));
          if (res.status !== 200) return { ok: false, why: `the repository cannot be read (${describe(res)})` };
          const branch = (res.body as { default_branch?: unknown } | null)?.default_branch;
          return typeof branch === "string" && branch !== "" ? { ok: true, branch } : { ok: false, why: "the repository names no default branch" };
        } catch (err) {
          if (err instanceof AlissaUnavailable) return { ok: false, why: err.message };
          throw err;
        }
      })();
      heads.set(repo, h);
    }
    return h;
  };
  const checks: Array<{ t: TaskInfo; repo: string; entry: string; path: string }> = [];
  for (const t of tasks) {
    const fm = t.fm as Record<string, unknown>;
    const declared = new Set(((fm.new as string[] | undefined) ?? []).map((n) => literalScopePath(n) ?? n));
    for (const entry of scopeOf(fm)) {
      if (scopeProblem(entry) !== null) continue; // rule 5's finding
      const path = literalScopePath(entry);
      if (path !== null && !declared.has(path)) checks.push({ t, repo: fm.repo as string, entry, path });
    }
  }
  await Promise.all(checks.map((c) => headOf(c.repo)));
  for (const { t, repo, entry, path } of checks) {
    const unknown = (why: string): void => warn(`rule 5b scope_path_unknown — ${t.file}: \`${clean(path)}\` in ${repo} was not checked: ${why}`);
    const head = await headOf(repo);
    if (!head.ok) {
      unknown(head.why);
      continue;
    }
    try {
      const res = await github.get(contentsPath(repo, path, head.branch));
      if (res.status === 404) {
        fail("5b", `scope entry \`${clean(entry)}\` does not exist at ${repo}'s default branch (\`${clean(head.branch)}\`) and is not declared in \`new\` — scope_path_missing (D12)`, t.file);
      } else if (res.status !== 200) unknown(describe(res));
    } catch (err) {
      if (err instanceof AlissaUnavailable) unknown(err.message);
      else throw err;
    }
  }
}

async function online(planFm: Record<string, unknown>, tasks: TaskInfo[], reader: AlissaReader, fail: Fail): Promise<void> {
  const fm = (t: TaskInfo): Record<string, unknown> => t.fm as Record<string, unknown>;
  const guard = async (rule: number, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof AlissaUnavailable) fail(rule, `could not verify: ${err.message}`, undefined, true);
      else throw err;
    }
  };

  // Rule 10 — anchor, program, milestones.
  await guard(10, async () => {
    const program = planFm.program as string;
    const res = await reader.get(`/v1/projects/${encodeURIComponent(program)}`);
    if (res.status === 404) return fail(10, `program \`${program}\` does not resolve to a project the planner can read (${describe(res)})`, "plan.md");
    if (res.status !== 200) return fail(10, `could not read program \`${program}\`: ${describe(res)}`, "plan.md", isTransient(res.status));
    const project = (res.body as { project?: Record<string, unknown> })?.project ?? {};
    if (project.status !== "active") fail(10, `program \`${program}\` is \`${clean(project.status)}\`, not \`active\``, "plan.md");
    const milestones = (Array.isArray(project.milestones) ? project.milestones : []).filter(isRecord);
    const bows = new Set(milestones.map((m) => m.bodyOfWorkId).filter((b): b is string => typeof b === "string"));

    const anchor = planFm.anchor as Record<string, unknown>;
    let anchorBow: string | null = null;
    if (anchor.kind === "milestone" || anchor.kind === "criterion") {
      const mid = anchor.milestoneId as string;
      const m = milestones.find((x) => x._id === mid || x.bodyOfWorkId === mid);
      if (!m) fail(10, `the anchor's milestone \`${mid}\` is not a milestone of program \`${program}\``, "plan.md");
      else {
        if (typeof m.status === "string" && CLOSED_MILESTONE.has(m.status)) fail(10, `the anchor's milestone \`${mid}\` is \`${m.status}\` — an anchor must be open (§4.3)`, "plan.md");
        if (typeof m.bodyOfWorkId !== "string") fail(10, `the anchor's milestone \`${mid}\` has no body of work to land tasks in`, "plan.md");
        else anchorBow = m.bodyOfWorkId;
        if (anchor.kind === "criterion") {
          const crit = (Array.isArray(m.validationCriteria) ? m.validationCriteria : []).filter(isRecord).find((c) => c.id === anchor.criterionId);
          if (!crit) fail(10, `criterion \`${clean(anchor.criterionId)}\` is not one of milestone \`${mid}\`'s criteria`, "plan.md");
          else if (crit.satisfied === true) fail(10, `criterion \`${clean(anchor.criterionId)}\` of milestone \`${mid}\` is already satisfied (§4.3)`, "plan.md");
        }
      }
    } else if (anchor.kind === "objective") {
      const oid = anchor.objectiveId as string;
      const o = await reader.get(`/v1/objectives/${encodeURIComponent(oid)}`);
      if (o.status === 404) fail(10, `the anchor's objective \`${oid}\` does not resolve (${describe(o)})`, "plan.md");
      else if (o.status !== 200) fail(10, `could not read objective \`${oid}\`: ${describe(o)}`, "plan.md", isTransient(o.status));
      else {
        const body = o.body as Record<string, unknown>;
        const obj = isRecord(body?.objective) ? body.objective : body;
        if (obj?.status !== "active") fail(10, `the anchor's objective \`${oid}\` is \`${clean(obj?.status)}\`, not \`active\` (§4.3)`, "plan.md");
      }
    }

    const planMilestone = planFm.milestone as string | undefined;
    if (planMilestone === undefined) {
      if (anchor.kind !== "exhaust") fail(10, `plan.md has no \`milestone\`; it is absent only on an exhaust anchor (§5.2)`, "plan.md");
    } else if (!bows.has(planMilestone)) {
      fail(10, `plan.md's milestone \`${planMilestone}\` is not one of program \`${program}\`'s milestone bodies of work`, "plan.md");
    } else if (anchorBow !== null && planMilestone !== anchorBow) {
      fail(10, `plan.md's milestone \`${planMilestone}\` is not the anchor's (\`${anchorBow}\`)`, "plan.md");
    }
    for (const t of tasks) {
      const tm = fm(t).milestone as string | undefined;
      if (tm === undefined) fail(10, "the task names no `milestone` — schema v1.3 omits it only on a project-less ask (`asker`), which no plan carries (§4.6); a plan's task lands in its milestone", t.file);
      else if (!bows.has(tm)) fail(10, `milestone \`${tm}\` is not one of program \`${program}\`'s milestone bodies of work`, t.file);
      else if (anchorBow !== null && tm !== anchorBow) fail(10, `milestone \`${tm}\` is not the anchor's (\`${anchorBow}\`) — on a ${anchor.kind} anchor every task lands in it`, t.file);
    }
  });

  // Rule 11 — external edges.
  await externalEdges(tasks, reader, fail);

  // Rule 12 — repositories and off-limits.
  await guard(12, async () => {
    const list = await reader.get(`/v1/bodies-of-work?includeShared=true&limit=500`);
    if (list.status !== 200) return fail(12, `could not list the fleet's feed bodies of work: ${describe(list)}`, undefined, isTransient(list.status));
    const feeds = new Set<string>();
    const bodies = (list.body as { bodiesOfWork?: unknown[] })?.bodiesOfWork;
    for (const b of Array.isArray(bodies) ? bodies : []) {
      if (!isRecord(b) || typeof b.title !== "string") continue;
      const m = /^autodev:\s*(\S+)\s*$/i.exec(b.title);
      if (m && m[1]) feeds.add(m[1].toLowerCase());
    }
    for (const t of tasks) {
      // Schema v1.3: a `sources: web` discovery task reads no repository, so it has no feed to check.
      const repo = fm(t).repo as string | undefined;
      if (repo === undefined) continue;
      if (!feeds.has(repo.toLowerCase())) fail(12, `repo \`${repo}\` has no \`autodev: ${repo}\` feed body of work — it is not a fed repository`, t.file);
    }

    const steering = await reader.get(`/v1/factory/steering`);
    if (steering.status === 404) return fail(12, `the steering record cannot be read (${describe(steering)}) — off-limits globs are unknown, so the rule refuses rather than guesses`);
    if (steering.status !== 200) return fail(12, `could not read the steering record: ${describe(steering)}`, undefined, isTransient(steering.status));
    const records = (steering.body as { records?: unknown[] })?.records;
    const globs: Array<{ glob: string; from: string }> = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (!isRecord(r) || !isRecord(r.scope)) continue;
      const scope = r.scope;
      const applies = scope.kind === "fleet" || (scope.kind === "program" && scope.projectId === planFm.program);
      if (!applies) continue;
      for (const g of Array.isArray(r.offLimits) ? r.offLimits : []) {
        if (typeof g === "string" && !g.startsWith("topic:")) globs.push({ glob: g, from: scope.kind === "fleet" ? "the fleet's" : "the program's" });
      }
    }
    for (const t of tasks) {
      for (const entry of scopeOf(fm(t))) {
        for (const g of globs) {
          if (overlaps(entry, g.glob)) fail(12, `scope entry \`${clean(entry)}\` matches \`${clean(g.glob)}\` in ${g.from} steering offLimits`, t.file);
        }
      }
    }
  });
}

async function externalEdges(tasks: TaskInfo[], reader: AlissaReader, fail: Fail): Promise<void> {
  for (const t of tasks) {
    for (const e of ((t.fm as Record<string, unknown>).dependsOn as Array<Record<string, unknown>>) ?? []) {
      if (typeof e.task !== "string") continue;
      try {
        const res = await reader.get(`/v1/tasks/${encodeURIComponent(e.task)}`);
        if (res.status === 404) {
          fail(11, `external edge \`${e.task}\` does not resolve (${describe(res)})`, t.file);
          continue;
        }
        if (res.status !== 200) {
          fail(11, `could not read external edge \`${e.task}\`: ${describe(res)}`, t.file, isTransient(res.status));
          continue;
        }
        const status = (res.body as { task?: { status?: unknown } })?.task?.status;
        if (typeof status !== "string" || !LIVING_TASK.has(status)) {
          fail(11, `external edge \`${e.task}\` is \`${clean(status)}\`; it must be \`pending_validation\` or \`validated\` (§1.3)`, t.file);
        }
      } catch (err) {
        if (err instanceof AlissaUnavailable) fail(11, `could not verify \`${e.task}\`: ${err.message}`, t.file, true);
        else throw err;
      }
    }
  }
}

/** Rule 7's structure: `## Why`, extra sections, `## Definition of done`, `## Criteria` (last). */
export function bodyProblems(body: string): string[] {
  const out: string[] = [];
  const { sections } = level2Sections(body);
  const titles = sections.map((s) => s.title);
  for (const need of ["Why", "Definition of done", "Criteria"]) {
    const n = titles.filter((t) => t === need).length;
    if (n !== 1) out.push(`needs exactly one \`## ${need}\` section (found ${n})`);
  }
  if (out.length > 0) return out;
  const why = titles.indexOf("Why");
  const dod = titles.indexOf("Definition of done");
  const crit = titles.indexOf("Criteria");
  if (why !== 0) out.push("`## Why` must be the first section (extra sections go after it)");
  if (!(why < dod && dod < crit)) out.push("sections must run `## Why`, `## Definition of done`, `## Criteria` in that order");
  else if (crit !== dod + 1) out.push("`## Criteria` must follow `## Definition of done` directly");
  if (crit !== titles.length - 1) out.push("`## Criteria` must be the last section");
  if (out.length > 0) return out;

  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""));
  const dodLine = (sections[dod] as { line: number }).line;
  const description = lines.slice(0, dodLine).join("\n").trim();
  const dLen = charLength(description);
  if (dLen < LIMITS.descriptionMin || dLen > LIMITS.descriptionMax) {
    out.push(`the description (everything above \`## Definition of done\`) is ${dLen} characters; it must be ${LIMITS.descriptionMin}–${LIMITS.descriptionMax} (§5.4)`);
  }
  const dodText = (sections[dod] as { lines: string[] }).lines.join("\n").trim();
  if (charLength(dodText) < LIMITS.definitionOfDoneMin) {
    out.push(`\`## Definition of done\` is ${charLength(dodText)} characters; it must be at least ${LIMITS.definitionOfDoneMin} (§5.4)`);
  }
  const { items, stray } = listItems((sections[crit] as { lines: string[] }).lines);
  if (stray.length > 0) out.push(`\`## Criteria\` holds only list items — one per criterion (found \`${clean(stray[0])}\`)`);
  if (items.some((i) => i === "")) out.push("`## Criteria` has an empty item");
  if (items.length < LIMITS.criteriaMin || items.length > LIMITS.criteriaMax) {
    out.push(`\`## Criteria\` has ${items.length} items; it must have ${LIMITS.criteriaMin}–${LIMITS.criteriaMax} (§5.4)`);
  }
  return out;
}

function findCycle(adjacency: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of [...(adjacency.get(n) ?? [])].sort()) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (state.get(m) === undefined && adjacency.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of [...adjacency.keys()].sort()) {
    if (state.get(n) === undefined) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

function firstDifference(want: string, got: string): string {
  const w = want.split("\n");
  const g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) {
    if (w[i] !== g[i]) {
      return `line ${i + 1} of the section renders as \`${w[i] === undefined ? "(nothing)" : clean(w[i])}\`, plan.md has \`${g[i] === undefined ? "(nothing)" : clean(g[i])}\``;
    }
  }
  return "the sections differ";
}

/** Rule order for the verdict: 5b sorts after 5. */
function ruleRank(r: RuleId): number {
  return r === "5b" ? 5.5 : r;
}

function sortFailures(f: Failure[]): Failure[] {
  return f.map((x, i) => ({ x, i })).sort((a, b) => ruleRank(a.x.rule) - ruleRank(b.x.rule) || a.i - b.i).map(({ x }) => x);
}

// ── The knowledge-base mode: K1–K9 (design alissa-build-discovery §3.4); K10–K14 (SR-2) and K15–K18 (DOC-3) below
// A pull request that changes any `knowledge-base/**` file is linted under these rules, numbered
// apart from §5.5's. K1–K5 need no network; K6 reads the task with the lint token, K7 asks
// Studio's verify route whether each repo cite holds at its pinned SHA, and K8 (v1.1) asks Studio's
// url-cites route whether each URL cite's page, or its archive, still holds the quote. Every rule
// runs; the verdict is the first failure. K7 or K8 with the route unavailable is "plan-lint could
// not run" — a failure, never a pass. The same run classifies the finding for review: its report
// ends with the `Discovery-Review:` line (§3.6). A finding may carry a flat `evidence/` folder
// (operator decision 2026-10-20): K1 types it, K4 caps it, K5 scans its text and K9 — offline, like
// K1–K5 — holds every file and every `evidence:<file>` cite to each other.

export type KRule = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7" | "K8" | "K9" | "K10" | "K11" | "K12" | "K13" | "K14"
  | "K15" | "K16" | "K17" | "K18" | "K19" | "K20" | "K21" | "K22" | "K23";

export const K_RULE_NAMES: Readonly<Record<KRule, string>> = {
  K1: "layout and immutability",
  K2: "frontmatter",
  K3: "completeness",
  K4: "size",
  K5: "hygiene",
  K6: "task",
  K7: "cites resolve",
  K8: "external cites hold",
  K9: "evidence cited",
  K10: "security shape",
  K11: "security key",
  K12: "cited finding",
  K13: "no secrets in scenario",
  K14: "security file",
  K15: "doc shape",
  K16: "doc key",
  K17: "verbatim passage",
  K18: "doc file",
  K19: "report shape",
  K20: "report numbers",
  K21: "report refs",
  K22: "report status",
  K23: "report exposure",
};

/** The rules a run made, as the report names them: `K1–K5, K9`, `K1–K9`, `K1, K5`. */
export function kRulesRan(rules: readonly KRule[]): string {
  const ns = rules.map((r) => Number(r.slice(1)));
  const runs: Array<[number, number]> = [];
  for (const n of ns) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `K${a}` : b === a + 1 ? `K${a}, K${b}` : `K${a}–K${b}`)).join(", ");
}

/** §2.3's limits, and §2.5's for URL cites. */
export const KB_LIMITS = {
  fileBytes: 32 * 1024,
  questionsMin: 1, questionsMax: 12,
  risksMax: 12, suggestedTasksMax: 8, citesMax: 24,
  lineSpanMax: 400,
  summaryChars: 1200, questionSectionChars: 6000,
  urlCitesMax: 48, urlChars: 2048, quoteMin: 20, quoteMax: 300,
  evidenceFileBytes: KB_EVIDENCE_READ_CAP, evidenceBytesMax: 10 * 1024 * 1024, evidenceFilesMax: 20,
} as const;

/** An evidence file's name (K1): lower case, at most 64 characters. */
export const KB_EVIDENCE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An inline evidence cite in findings.md (K9): `evidence:<file>`, not inside a longer word, path or URL. */
const INLINE_EVIDENCE_RE = /(?<![A-Za-z0-9_./:-])evidence:([a-z0-9][a-z0-9._-]{0,63})/g;

/** Why an image's bytes are not its extension's type (K1), or null. */
function imageMismatch(ext: string, b: Buffer): string | null {
  const is = (sig: number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x);
  const ascii = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));
  if (ext === "png") return is([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : "a PNG";
  if (ext === "jpg" || ext === "jpeg") return is([0xff, 0xd8, 0xff]) ? null : "a JPEG";
  if (ext === "webp") return is(ascii("RIFF")) && is(ascii("WEBP"), 8) ? null : "a WebP image";
  return null;
}

/** An element name, after an optional namespace prefix (`<s:script`, `<script`). */
const svgElement = (name: string): RegExp => new RegExp(`<(?:[\\w.-]+:)?${name}\\b`, "i");
/** One tag, quote-aware, so a `>` inside an attribute value does not end it. Linear: no two branches start alike. */
const SVG_TAG_RE = /<[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
/** One attribute of a tag: its (possibly prefixed) name and its value. */
const SVG_ATTR_RE = /(?<![\w.:-])((?:[\w.-]+:)?[\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
/** SMIL elements that can set another attribute's value. */
const SVG_ANIMATION_RE = /^<(?:[\w.-]+:)?(?:animate|set|animateMotion|animateTransform|animateColor)\b/i;

/**
 * The element names an evidence svg may use (local names, lower case): SVG 1.1/2's drawing, paint, filter,
 * animation and structure elements. An allowlist fails closed: in an svg inlined into HTML, a start tag such as
 * `img`, `meta` or `table` breaks out into an HTML element. `script` and `foreignObject` have their own refusals,
 * and the obsolete font elements stay off, because `<font color|face|size>` is itself a breakout tag.
 */
const SVG_ELEMENTS = new Set([
  "a", "animate", "animatecolor", "animatemotion", "animatetransform", "circle", "clippath", "defs", "desc",
  "discard", "ellipse", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix",
  "fediffuselighting", "fedisplacementmap", "fedistantlight", "fedropshadow", "feflood", "fefunca", "fefuncb",
  "fefuncg", "fefuncr", "fegaussianblur", "feimage", "femerge", "femergenode", "femorphology", "feoffset",
  "fepointlight", "fespecularlighting", "fespotlight", "fetile", "feturbulence", "filter", "g", "image", "line",
  "lineargradient", "marker", "mask", "metadata", "mpath", "path", "pattern", "polygon", "polyline",
  "radialgradient", "rect", "set", "stop", "style", "svg", "switch", "symbol", "text", "textpath", "title",
  "tspan", "use", "view",
  "script", "foreignobject",
]);
/** Every start or end tag's name. Read over the raw text, comments and CDATA included, so no comment rule can hide one. */
const SVG_ELEMENT_NAME_RE = /<\/?([A-Za-z_:][^\s/<>]*)/g;

/** The five references XML defines without a DTD (and a DTD is refused). */
const XML_NAMED_REFS: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** A character reference with a digit run of any length: XML allows any number of leading zeros. */
const CHAR_REF_RE = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi;

/** A reference's code point, or null when it is not an XML Char (NUL, a control, a surrogate, past U+10FFFF). */
function refCodePoint(d: string | undefined, h: string | undefined): number | null {
  const digits = (d ?? h ?? "").replace(/^0+(?=.)/, "");
  if (digits.length > 7) return null;
  const cp = Number.parseInt(digits, d !== undefined ? 10 : 16);
  const xmlChar = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
  return xmlChar ? cp : null;
}

/** Text with its character references decoded, as the XML parser reads it. An undecodable one becomes U+FFFD (and is refused, see badRef). */
function decodeRefs(v: string): string {
  return v.replace(CHAR_REF_RE, (_, d, h, n) => {
    if (n) return XML_NAMED_REFS[n.toLowerCase()] as string;
    const cp = refCodePoint(d, h);
    return cp === null ? "\ufffd" : String.fromCodePoint(cp);
  });
}

/**
 * Whether the text holds a reference that is not a well-formed XML one with a valid code point: an
 * `&#` not closed by `;`, a `;`-closed named reference other than the five (`&colon;`, which HTML decodes), or
 * one decoding to no XML Char. Failing closed keeps every check on the same text a viewer reads.
 */
function badRef(text: string): boolean {
  // A name with no `;` (`R&D`) is left alone: no parser turns one into a letter or a `:`.
  for (const m of text.matchAll(/&(#x?[0-9a-z]*;?|[a-z][a-z0-9]*;)/gi)) {
    const ref = m[1] as string;
    const num = /^#(?:(\d+)|x([0-9a-f]+));$/i.exec(ref);
    if (num) {
      if (refCodePoint(num[1], num[2]) === null) return true;
    } else if (ref.startsWith("#") || !/^(?:amp|lt|gt|quot|apos);$/i.test(ref)) {
      return true;
    }
  }
  return false;
}

/** Each `<style>` element's content (to its close tag, or the end of the text), scanned linearly. */
function styleContents(text: string): string[] {
  const out: string[] = [];
  let open = -1;
  for (const m of text.matchAll(/<(\/?)(?:[\w.-]+:)?style\b[^<>]*>/gi)) {
    const end = (m.index as number) + m[0].length;
    if (m[1] === "" && open < 0) open = end;
    else if (m[1] === "/" && open >= 0) {
      out.push(text.slice(open, m.index));
      open = -1;
    }
  }
  if (open >= 0) out.push(text.slice(open));
  return out;
}

/** A CSS escape (`\75rl(`, `@\69mport`) hides a keyword from every check here; presentation attributes are CSS too. */
const CSS_ESCAPE = "a backslash (CSS escape) in an attribute or a style";

/** Why a (decoded) style is not plain, or null: a CSS escape, or a quoted function argument that may fetch (`image(`, `src(`, …). */
function styleRefusal(css: string): string | null {
  if (css.includes("\\")) return CSS_ESCAPE;
  if (/[\w-]\(\s*["'](?!\s*#)/.test(css)) return "a style function with a quoted argument other than a `#fragment`";
  return null;
}

/**
 * The text with each comment, CDATA section and processing instruction blanked to spaces (same length), so a
 * quote inside one cannot merge the tags after it into one span. Linear: one `indexOf` per carrier; an
 * unterminated one is blanked to the end.
 */
function blankNonMarkup(text: string): string {
  const carriers: [string, string][] = [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<?", "?>"]];
  const parts: string[] = [];
  let kept = 0;
  for (let lt = text.indexOf("<"); lt >= 0; ) {
    const c = carriers.find(([open]) => text.startsWith(open, lt));
    if (!c) {
      lt = text.indexOf("<", lt + 1);
      continue;
    }
    const close = text.indexOf(c[1], lt + c[0].length);
    const end = close < 0 ? text.length : close + c[1].length;
    parts.push(text.slice(kept, lt), " ".repeat(end - lt));
    kept = end;
    lt = text.indexOf("<", end);
  }
  parts.push(text.slice(kept));
  return parts.join("");
}

/**
 * What makes an svg active or a fetch (K1): a DTD, a script, an HTML island, an event handler, an
 * `href`/`src` off the page, a `srcset` or `ping`, an animation that rewrites one, a style that loads. Never the text itself.
 */
export function svgRefusals(text: string): string[] {
  const out = new Set<string>();
  // A DTD can declare entities that expand into elements; evidence never needs one.
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(text)) out.add("a DTD (`<!DOCTYPE` or `<!ENTITY`)");
  if (badRef(text)) out.add("a character reference that is not a well-formed XML one (`&#…;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`)");
  // The parser decodes references everywhere, so the whole-text checks read the decoded text.
  const decoded = decodeRefs(text);
  if (svgElement("script").test(text)) out.add("a `<script>` element");
  if (svgElement("foreignObject").test(text)) out.add("a `<foreignObject>` element");
  if (/http:\/\/www\.w3\.org\/1999\/xhtml/i.test(decoded)) out.add("the XHTML namespace (HTML inside the svg)");
  const foreign = new Set<string>();
  for (const m of text.matchAll(SVG_ELEMENT_NAME_RE)) {
    const name = m[1] as string;
    if (!SVG_ELEMENTS.has(name.slice(name.lastIndexOf(":") + 1).toLowerCase())) foreign.add(name);
  }
  if (foreign.size > 0) {
    const names = [...foreign].slice(0, 5).map((n) => `\`<${n}>\``).join(", ");
    out.add(`an element that is not an SVG element (${names}${foreign.size > 5 ? ", …" : ""})`);
  }
  // `srcset` fetches like `src`; no SVG element takes one.
  if (/(?<![\w.:-])(?:[\w.-]+:)?srcset\s*=/i.test(decoded)) out.add("a `srcset` attribute (a fetch from outside the file)");
  // An animation rewriting an `href`/`src`/`ping` (a relative `ping` passes the URL check, yet still POSTs to the serving host), refused wherever it is named, so no tag-scan state can hide it.
  if (/(?<![\w.:-])attributeName\s*=\s*["']?\s*(?:[\w.-]+:)?(?:href|src|ping)\b/i.test(decoded)) {
    out.add("an animation that rewrites an `href`, `src` or `ping`");
  }
  // Tag by tag (see SVG_TAG_RE), so a hostile 2 MB file stays linear. Twice: over the raw text, and with
  // comments, CDATA and PIs blanked, where a quote in one would otherwise merge the tags after it.
  for (const m of [...text.matchAll(SVG_TAG_RE), ...blankNonMarkup(text).matchAll(SVG_TAG_RE)]) {
    const tag = m[0];
    const animation = SVG_ANIMATION_RE.test(tag);
    for (const a of tag.matchAll(SVG_ATTR_RE)) {
      const name = (a[1] as string).toLowerCase();
      const local = name.slice(name.lastIndexOf(":") + 1);
      const value = decodeRefs(a[2] ?? a[3] ?? a[4] ?? "").trim();
      if (/^on[a-z]+$/.test(local)) out.add("an event-handler attribute (`on…=`)");
      if (local === "srcdoc") out.add("a `srcdoc` attribute (an HTML document inside the svg)");
      // SVG 2's `a` takes `ping`: a click POSTs to every URL in it, a fetch from outside the file like `srcset`.
      if (local === "ping") out.add("a `ping` attribute (a fetch from outside the file)");
      // Presentation attributes (`fill`, `filter`, `mask`, `cursor`, …) are CSS too, so every value gets the style check.
      const why = styleRefusal(value);
      if (why) out.add(why);
      if ((local === "href" || local === "src") && !value.startsWith("#")) {
        out.add("an `href` or `src` that leaves the file (only `#fragment` links are admitted)");
      }
      if (animation && local === "attributename" && /^(?:[\w.-]+:)?(?:href|src|ping)$/i.test(value)) {
        out.add("an animation that rewrites an `href`, `src` or `ping`");
      }
      if (animation && ["values", "to", "from", "by"].includes(local) && /[a-z][a-z0-9+.-]*:|\/\/|url\(/i.test(value)) {
        out.add("an animation whose values hold a URL");
      }
    }
    // `<svg/onload=…>`: in HTML, `/` separates attributes, and a quote may end one.
    if (/[\s/"']on[a-z]+\s*=/i.test(tag)) out.add("an event-handler attribute (`on…=`)");
  }
  // A `<?xml-stylesheet href=…?>` and the like are not tags above; any `href`/`src` outside a `#fragment` is refused.
  for (const m of text.matchAll(/(?<![\w.:-])(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    if (!decodeRefs(m[1] ?? m[2] ?? m[3] ?? "").trim().startsWith("#")) {
      out.add("an `href` or `src` that leaves the file (only `#fragment` links are admitted)");
      break;
    }
  }
  for (const css of styleContents(text)) {
    const why = styleRefusal(decodeRefs(css));
    if (why) out.add(why);
  }
  if (/url\(\s*(?:['"][\s\x00-\x1f]*)?(?!#)[^)'"\s\x00-\x1f]/i.test(decoded) || /@import\b/i.test(decoded) || /image-set\(/i.test(decoded)) {
    out.add("a style that loads from outside the file (`url(…)`, `image-set(…)` or `@import`)");
  }
  return [...out];
}

/** Why a text evidence file's bytes are not plain UTF-8 (K1), or null: a scan of mis-decoded text sees nothing. */
export function notUtf8(b: Buffer): string | null {
  const is = (sig: number[]): boolean => sig.every((x, i) => b[i] === x);
  if (is([0xff, 0xfe]) || is([0xfe, 0xff]) || is([0x00, 0x00, 0xfe, 0xff])) return "starts with a UTF-16 or UTF-32 byte-order mark";
  if (b.includes(0)) return "holds a NUL byte";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return "is not valid UTF-8";
  }
  return null;
}

export const FINDINGS_SCHEMA_V1 = "alissa-findings/v1";
/** v1.1 (§2.5, §4.6): the URL cite, `project | bodyOfWork` with `asker`, `reads` that may be empty. */
export const FINDINGS_SCHEMA_V11 = "alissa-findings/v1.1";
/** v1.2 (operator decision 2026-10-20): the evidence cite, `{ kind: evidence, file }`. */
export const FINDINGS_SCHEMA_V12 = "alissa-findings/v1.2";
/** v1.3 (design alissa-security-review §5.1, lane SR-2): a question's `security` block and the file's `kind: security_review`. */
export const FINDINGS_SCHEMA_V13 = "alissa-findings/v1.3";
/** v1.4 (design alissa-documentation-check §5.1, lane DOC-3): a question's `doc` block and the file's `kind: doc_check`. */
export const FINDINGS_SCHEMA_V14 = "alissa-findings/v1.4";

/** Studio's cite check (lane DS-3), on the lint token. */
export const VERIFY_ROUTE = "/v1/factory/repo-files/verify";
/** Studio's URL cite check (lane DS-11), behind DS-16's guarded fetch, on the same token. */
export const URL_CITES_ROUTE = "/v1/factory/url-cites/verify";

/**
 * K2's archive hosts and K5's URL hygiene, inlined from studio.alissa.app `convex/core/urlCites.ts`
 * at commit 973077759f6fcdac385954e7a32961f27be26edf (lane DS-11; §12 Q13). Each host carries the
 * capture's own date; a `web.archive.org` copy names a 14-digit timestamp. A host is added here and
 * there together.
 */
export const KB_ARCHIVE_HOSTS = ["web.archive.org", "archive.ph"] as const;
const WAYBACK_PATH_RE = /^\/web\/\d{14}(?:[a-z]{2}_)?\/\S+$/;
const TOKEN_PARAM_NAME_RE = /(?:^|[_.-])(?:access[_-]?token|token|secret|password|passwd|signature|sig|api[_-]?key|apikey|key|auth|session(?:id)?|credentials?)$/i;
const OPAQUE_VALUE_RE = /^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9_+/=.-]{40,}$/;
/** A `retrievedAt` a little ahead of the runner's clock is skew, not the future. */
const RETRIEVED_AT_SKEW_MS = 5 * 60_000;
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** Why `raw` is not an `https://` URL §2.5 admits (K2), or null. */
export function urlShapeRefusal(raw: string): string | null {
  if (raw.length > KB_LIMITS.urlChars) return `is ${raw.length} characters; at most ${KB_LIMITS.urlChars}`;
  if (/\s/.test(raw)) return "holds whitespace";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") return "is not https://";
  if (url.hostname === "") return "names no host";
  return null;
}

/** Why `raw` is not a capture on a host K8 trusts (K2, §12 Q13), or null. */
export function archiveRefusal(raw: string): string | null {
  const shape = urlShapeRefusal(raw);
  if (shape) return shape;
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (!(KB_ARCHIVE_HOSTS as readonly string[]).includes(host)) return `is on ${host}, which is not an archive host K8 trusts (${KB_ARCHIVE_HOSTS.join(", ")})`;
  if (host === "web.archive.org" && !WAYBACK_PATH_RE.test(url.pathname + url.search)) return "is not a web.archive.org capture (`/web/<14-digit timestamp>/<url>`)";
  if (host === "archive.ph" && (url.pathname === "/" || url.pathname === "")) return "names no archive.ph capture";
  return null;
}

/** Why `raw` carries a credential (K5: userinfo, or a token-shaped query parameter), or null. Never the value itself. */
export function urlHygieneRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return "carries userinfo";
  for (const [name, value] of url.searchParams) {
    if (TOKEN_PARAM_NAME_RE.test(name)) return `carries a token-shaped query parameter (\`${clean(name.slice(0, 40))}\`)`;
    if (secretShapedLines(value).length > 0 || OPAQUE_VALUE_RE.test(value)) return "carries a token-shaped query parameter value";
  }
  return null;
}

/** `retrievedAt` → epoch ms, or null when it is not RFC 3339 in UTC or not a real time. */
export function retrievedAtMs(s: string): number | null {
  const m = RFC3339_UTC_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const back = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  return Date.parse(s);
}

/**
 * K5's deny-list and token shapes, inlined from studio.alissa.app `convex/core/repoContextFilter.ts`
 * at commit 1f9b7a4bb788f79e7ac36175c5c193b4c2be7dc5 (REPO_CONTEXT_FILTER_VERSION `rcf1-0ebb8c65`):
 * NT-2's list (design factory-new-task.md §4.5 D7) as widened by lane BC1 (alissa-build-code-context
 * §4 C7). The patterns and the segment matcher are copied verbatim — every pattern is matched against
 * each path segment, case-insensitively. A change there is a change here, by a lane that names the
 * new commit and version.
 */
export const KB_DENY_PATTERNS = [
  ".env*", "*.pem", "*.key", "*.p12", "id_rsa*", "*secret*", "*credential*", ".npmrc", ".git/**", "**/node_modules/**",
  ".netrc", ".pypirc", "*.tfstate*", "*.keystore", "*.jks", "*.kdbx", ".aws/**", ".ssh/**", "*.p8",
] as const;

function deniedSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  return (
    s.startsWith(".env") ||
    s.endsWith(".pem") ||
    s.endsWith(".key") ||
    s.endsWith(".p12") ||
    s.startsWith("id_rsa") ||
    s.includes("secret") ||
    s.includes("credential") ||
    s === ".npmrc" ||
    s === ".git" ||
    s === "node_modules" ||
    s === ".netrc" ||
    s === ".pypirc" ||
    s.includes(".tfstate") ||
    s.endsWith(".keystore") ||
    s.endsWith(".jks") ||
    s.endsWith(".kdbx") ||
    s === ".aws" ||
    s === ".ssh" ||
    s.endsWith(".p8")
  );
}

/** Is `path` (repo-relative, `/`-separated) one a finding must never cite? */
export function isDeniedPath(path: string): boolean {
  return path.split("/").some(deniedSegment);
}

/** The same file's REPO_TOKEN_SHAPE_SOURCES, verbatim and in order. */
export const KB_TOKEN_SHAPE_SOURCES = [
  "gh[pousr]_[A-Za-z0-9]{8,}",
  "github_pat_[A-Za-z0-9_]{8,}",
  "alissa_sk_[A-Za-z0-9_-]+",
  "Bearer\\s+[A-Za-z0-9._~+/-]+=*",
  "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[^-]|-(?!----))*-----END [A-Z0-9 ]*PRIVATE KEY-----",
  "sk-ant-[A-Za-z0-9_-]{8,}",
  "sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
  "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
  "AIza[0-9A-Za-z_-]{35}",
  "ya29\\.[0-9A-Za-z_-]{20,}",
  "xox[abposr]-[A-Za-z0-9-]{10,}",
  "hooks\\.slack\\.com/services/[A-Za-z0-9/]+",
  "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}",
  "glpat-[A-Za-z0-9_-]{20,}",
  "npm_[A-Za-z0-9]{36}",
  "pypi-[A-Za-z0-9_-]{50,}",
  "shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}",
  "SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}",
  "(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
  "[a-z][a-z0-9+.-]{0,31}://[^\\s/:@]+:[^\\s/@]+@",
] as const;

const TOKEN_SHAPE_RE = new RegExp(KB_TOKEN_SHAPE_SOURCES.map((s) => `(?:${s})`).join("|"), "g");

/** The 1-based lines of `text` that carry a secret-shaped string (never the string itself). */
export function secretShapedLines(text: string): number[] {
  const lines = new Set<number>();
  for (const m of text.matchAll(TOKEN_SHAPE_RE)) lines.add(text.slice(0, m.index).split("\n").length);
  return [...lines].sort((a, b) => a - b);
}

export interface KbFailure {
  rule: KRule;
  file?: string;
  message: string;
  /** The check could not be made (Alissa or K7's route unavailable): reported as "plan-lint could not run". */
  couldNotRun?: boolean;
}

/** §3.6's classification: `light` for a URL cite or a `high`-impact question, with the reasons. */
export interface DiscoveryReview {
  level: "none" | "light";
  reasons: string[];
}

export interface KbLintResult {
  target: string;
  kind: KbSource["kind"];
  questionCount: number;
  failures: KbFailure[];
  rulesRun: KRule[];
  notes: string[];
  /** The `Discovery-Review:` line's value; `null` for an assessment, or findings too malformed to classify. */
  review: DiscoveryReview | null;
}

/** The machine-read line the report ends with (§3.4, §3.6): devloop, revloop and orcloop read it. */
export function discoveryReviewLine(r: DiscoveryReview): string {
  return r.level === "none" ? "Discovery-Review: none" : `Discovery-Review: light — ${r.reasons.join("; ")}`;
}

/**
 * `reader` reads the task (K6, and K1's design-task check for an assessment); `verifier` posts
 * K7's cites and K8's URL cites to Studio. `prTask` is the pull request's own `TASK-<n>` (its branch), which an
 * assessment PR needs.
 */
export type KbLintOptions =
  | { online: false; prTask?: string | null }
  | { online: true; reader: AlissaReader; verifier: AlissaPoster; prTask?: string | null };

interface Cite {
  repo: string;
  path: string;
  lines: string;
  blob: string;
}

/** A URL cite (v1.1, §2.5): the page, when it was read, the sentence it holds, its archived copy. */
interface UrlCite {
  kind: "url";
  url: string;
  retrievedAt: string;
  quote: string;
  archive?: string;
}

/** An evidence cite (v1.2): a file of the finding's own `evidence/` folder. */
interface EvidenceCite {
  kind: "evidence";
  file: string;
}

let findingsValidator: ValidateFunction | null = null;

export function findingsSchema(): ValidateFunction {
  if (!findingsValidator) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
    findingsValidator = ajv.compile(JSON.parse(readFileSync(new URL("../schema/findings.v1.json", import.meta.url), "utf8")) as object);
  }
  return findingsValidator;
}

/** K4 owns the schema's count limits (§2.3); K2 owns the rest of it. */
function isKbSizeError(e: ErrorObject): boolean {
  return (e.keyword === "maxItems" || e.keyword === "minItems") && /^\/(questions|risks|suggestedTasks)(\/\d+\/cites)?$/.test(e.instancePath);
}

const CITE_PATH_RE = /^\/(questions|risks)\/(\d+)\/cites\/(\d+)/;

/**
 * The schema's errors as K2 reports them. A cite is a `oneOf` of the repo cite and the URL cite,
 * and a v1 file's cites are the v1 repo cite: only the branch the cite's `kind` selects speaks, so
 * a bad cite reads as one shape's complaints, not both. The root `oneOf` is `project | bodyOfWork`.
 */
function kbSchemaErrors(errors: ErrorObject[], fm: unknown): Array<ErrorObject | string> {
  const doc = isRecord(fm) ? fm : {};
  const v1 = doc.schema === FINDINGS_SCHEMA_V1;
  const v12 = doc.schema === FINDINGS_SCHEMA_V12 || doc.schema === FINDINGS_SCHEMA_V13 || doc.schema === FINDINGS_SCHEMA_V14;
  const out: Array<ErrorObject | string> = [];
  const said = new Set<string>();
  const say = (x: ErrorObject | string): void => {
    const key = typeof x === "string" ? x : `${x.instancePath} ${x.message} ${JSON.stringify(x.params)}`;
    if (!said.has(key)) {
      said.add(key);
      out.push(x);
    }
  };
  for (const e of errors) {
    if (e.keyword === "if" || e.schemaPath.startsWith("#/oneOf/")) continue;
    if (e.keyword === "oneOf" && e.instancePath === "") {
      const both = doc.project !== undefined && doc.bodyOfWork !== undefined;
      say(both ? "carries both `project` and `bodyOfWork` — a finding is keyed by exactly one of them (§4.6)" : "carries neither `project` nor `bodyOfWork` — a finding is keyed by exactly one of them (§4.6)");
      continue;
    }
    if (e.keyword === "false schema" && e.instancePath === "/kind") {
      say(`frontmatter carries \`kind\` — it needs \`schema: ${FINDINGS_SCHEMA_V13}\` (alissa-security-review §5.1)${doc.kind === "doc_check" ? ` or, for \`doc_check\`, \`${FINDINGS_SCHEMA_V14}\`` : ""}`);
      continue;
    }
    if (e.keyword === "not" && e.instancePath === "/kind") {
      say(`frontmatter carries \`kind: doc_check\` — it needs \`schema: ${FINDINGS_SCHEMA_V14}\` (alissa-documentation-check §5.1)`);
      continue;
    }
    const m = CITE_PATH_RE.exec(e.instancePath);
    if (m) {
      const list = doc[m[1] as string];
      const entry = Array.isArray(list) ? list[Number(m[2])] : undefined;
      const cites = isRecord(entry) ? entry.cites : undefined;
      const cite = Array.isArray(cites) ? cites[Number(m[3])] : undefined;
      const url = isRecord(cite) && cite.kind === "url";
      const evidence = isRecord(cite) && cite.kind === "evidence";
      if (e.keyword === "oneOf" && e.schemaPath === "#/definitions/cite/oneOf") continue;
      if (url && v1) {
        say(`frontmatter ${e.instancePath.slice(0, m[0].length)} is a URL cite — it needs \`schema: ${FINDINGS_SCHEMA_V11}\` (§2.5)`);
        continue;
      }
      if (evidence && !v12) {
        say(`frontmatter ${e.instancePath.slice(0, m[0].length)} is an evidence cite — it needs \`schema: ${FINDINGS_SCHEMA_V12}\` or later`);
        continue;
      }
      const branch = e.schemaPath.startsWith("#/definitions/urlCite/") ? "url"
        : e.schemaPath.startsWith("#/definitions/evidenceCite/") ? "evidence"
        : e.schemaPath.startsWith("#/definitions/repoCite") ? "repo" : null;
      if (branch !== null && branch !== (url ? "url" : evidence ? "evidence" : "repo")) continue;
    }
    say(e);
  }
  return out;
}

const READS_TRAILER_RE = /^[ \t]*Alissa-Reads[ \t]*:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})[ \t]*$/gim;
const READS_NONE_RE = /^[ \t]*Alissa-Reads[ \t]*:[ \t]*none[ \t]*$/im;
const SOURCES_TRAILER_RE = /^[ \t]*Alissa-Sources[ \t]*:[ \t]*(\S+)[ \t]*$/im;
const ASKER_TRAILER_RE = /^[ \t]*Alissa-Asker[ \t]*:[ \t]*(\S+)[ \t]*$/im;
/** §3.4's K8 verdicts, as Studio's url-cites route answers them. */
const URL_VERDICTS = new Set(["holds", "archived", "refuted", "gone", "blocked", "unavailable"]);
const VERIFY_REASONS: Readonly<Record<string, string>> = {
  path_missing: "does not exist at the pinned SHA",
  blob_mismatch: "has a different blob at the pinned SHA",
  lines_out_of_range: "has a line range that runs past the file's end",
};

/** `TASK-<n>` from a `TASK-<n>-<DESC>` branch name, or `null`. */
export function taskOfBranch(branch: string | undefined): string | null {
  const m = /^TASK-([1-9][0-9]*)-/.exec(branch ?? "");
  return m ? `TASK-${m[1]}` : null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function lintKb(src: KbSource, opts: KbLintOptions): Promise<KbLintResult> {
  const failures: KbFailure[] = [];
  const notes = [...src.notes];
  const fail = (rule: KRule, message: string, file?: string, couldNotRun = false): void => {
    failures.push({ rule, message, ...(file === undefined ? {} : { file }), ...(couldNotRun ? { couldNotRun } : {}) });
  };
  let questionCount = 0;
  let review: DiscoveryReview | null = null;
  const result = (rulesRun: KRule[]): KbLintResult => ({
    target: src.label, kind: src.kind, questionCount, failures: sortKb(failures), rulesRun, notes, review,
  });

  // K1 — layout and immutability (found by the reader).
  for (const m of src.layout) fail("K1", m);

  // K1's online half: an assessment, or a security report's files, are admitted only from a design task
  // (discovery §7.1; alissa-code-security-reports §3.2, §4.3).
  const designTaskCheck = async (what: string, adds: string): Promise<void> => {
    const task = opts.prTask ?? null;
    if (!opts.online) notes.push("K1's design-task check not run (offline)");
    else if (task === null) fail("K1", `${what} is admitted only from a \`kind: design\` task, and this run names none (a \`TASK-<n>-…\` branch or --task)`);
    else {
      try {
        const res = await opts.reader.get(`/v1/tasks/${encodeURIComponent(task)}`);
        if (res.status !== 200) fail("K1", `could not read the PR's task \`${task}\`: ${describe(res)}`);
        else {
          const kind = (res.body as { task?: { kind?: unknown } })?.task?.kind ?? "code";
          if (kind !== "design") fail("K1", `the PR's task \`${task}\` is \`kind: ${clean(kind)}\` — only a design task ${adds}`);
        }
      } catch (err) {
        if (err instanceof AlissaUnavailable) fail("K1", `could not verify the PR's task \`${task}\`: ${err.message}`);
        else throw err;
      }
    }
  };

  if (src.kind === "security-report") {
    await designTaskCheck("a security report", "adds files to a `knowledge-base/security-reports/<yyyy-mm-dd>-<reviewId>/` directory (alissa-code-security-reports §3.2)");
    // K19–K23 — offline, on the run directory as it will stand.
    for (const f of securityReportLint({ files: src.files, firstData: src.firstData ?? null, day: src.day, reviewId: src.reviewId ?? null })) failures.push(f);
    notes.push("a security report: K2–K18 apply to findings only; K19–K23 read the run directory's report-data.json");
    return result(["K1", ...SECURITY_REPORT_RULES]);
  }

  if (src.kind === "assessment") {
    await designTaskCheck("an assessment", "adds a `knowledge-base/assessments/*.md` file (§7.1)");
    // K5 — the assessment's text is scanned like a finding's.
    for (const [file, text] of src.files) {
      const lines = secretShapedLines(text);
      if (lines.length > 0) fail("K5", `secret-shaped text on line(s) ${lines.join(", ")} — the token shapes of repoContextFilter.ts (§10)`, file);
    }
    notes.push("an assessment is a design document: K2–K4 and K6–K8 apply to findings only");
    return result(["K1", "K5"]);
  }

  const evidence = [...src.sizes.keys()].filter((rel) => rel.startsWith(`${EVIDENCE_DIR}/`));
  kbEvidenceShape(src, evidence, fail);

  const text = src.files.get(FINDINGS_FILE);
  const bytes = src.sizes.get(FINDINGS_FILE);
  if (bytes !== undefined && bytes > KB_LIMITS.fileBytes) fail("K4", `findings.md is ${bytes} bytes; the limit is ${KB_LIMITS.fileBytes} (§2.3)`, FINDINGS_FILE);
  if (text === undefined) {
    // K5 still scans the evidence it could read.
    for (const rel of evidence) kbSecretScan(src.files.get(rel), rel, fail);
    notes.push("K2–K9 not run on findings.md: none is readable");
    return result(["K1", "K4", "K5"]);
  }

  // K2 — frontmatter (K4 owns the schema's count limits).
  let fm: Record<string, unknown> | null = null;
  let body: string | null = null;
  let k2 = 0;
  const k2fail = (m: string): void => {
    fail("K2", m, FINDINGS_FILE);
    k2++;
  };
  const split = splitFrontmatter(text);
  if (!split.ok) k2fail(`findings.md ${split.error}`);
  else {
    body = split.body;
    const parsed = parseFrontmatter(split.frontmatter);
    if (!parsed.ok) k2fail(parsed.error);
    else {
      const validate = findingsSchema();
      if (!validate(parsed.value)) {
        for (const e of kbSchemaErrors(validate.errors ?? [], parsed.value)) {
          if (typeof e === "string") k2fail(e);
          else if (SECURITY_PATH_RE.test(e.instancePath)) securitySchemaError(e, parsed.value, fail);
          else if (DOC_PATH_RE.test(e.instancePath)) docSchemaError(e, parsed.value, fail);
          else if (isKbSizeError(e)) fail("K4", `frontmatter ${ajvMessage(e)} (§2.3)`, FINDINGS_FILE);
          else if (e.keyword === "type" && /\/(sha|blob|lines)$/.test(e.instancePath)) k2fail(`frontmatter ${ajvMessage(e)} — YAML reads an all-digit value as a number; quote it`);
          else k2fail(`frontmatter ${ajvMessage(e)}`);
        }
      }
      if (k2 === 0) fm = parsed.value as Record<string, unknown>;
    }
  }
  const questions = fm ? (fm.questions as Array<Record<string, unknown>>) : [];
  const risks = fm ? ((fm.risks as Array<Record<string, unknown>> | undefined) ?? []) : [];
  questionCount = questions.length;
  const { repoCites, urlCites, evidenceCites } = citesOf(questions, risks);
  if (fm) {
    if (src.task !== null && fm.task !== src.task) k2fail(`\`task\` is \`${clean(fm.task)}\` but the directory is \`${src.task}\``);
    const reads = fm.reads as Array<{ repo: string; sha: string }>;
    const readRepos = new Set<string>();
    for (const r of reads) {
      if (readRepos.has(r.repo.toLowerCase())) k2fail(`\`reads\` names \`${clean(r.repo)}\` twice — one pinned SHA per repository`);
      readRepos.add(r.repo.toLowerCase());
    }
    const ids = new Set<string>();
    for (const q of questions) {
      if (ids.has(q.id as string)) k2fail(`question id \`${clean(q.id)}\` appears twice`);
      ids.add(q.id as string);
    }
    for (const c of repoCites) {
      if (!readRepos.has(c.repo.toLowerCase())) k2fail(`a cite names \`${clean(c.repo)}\`, which is not in \`reads\` — every cite is read at a pinned SHA`);
    }
    // v1.1's URL cite (§2.5): an https page, read no later than now and no earlier than the task's
    // creation day — the directory's day, which K6 holds to the task's — and an archive K8 trusts.
    const now = Date.now();
    const dayStart = src.day === null ? null : Date.parse(`${src.day}T00:00:00Z`);
    for (const c of urlCites) {
      const where = `URL cite \`${clean(c.url)}\``;
      const shape = urlShapeRefusal(c.url);
      if (shape) k2fail(`${where} ${shape} (§2.5)`);
      const at = retrievedAtMs(c.retrievedAt);
      if (at === null) k2fail(`${where}: \`retrievedAt\` \`${clean(c.retrievedAt)}\` is not a real RFC 3339 time in UTC (\`YYYY-MM-DDThh:mm:ssZ\`)`);
      else if (at > now + RETRIEVED_AT_SKEW_MS) k2fail(`${where}: \`retrievedAt\` \`${c.retrievedAt}\` is in the future`);
      else if (dayStart !== null && at < dayStart) k2fail(`${where}: \`retrievedAt\` \`${c.retrievedAt}\` is before the task's creation day, ${src.day} (§2.5)`);
      if (c.quote.trim() !== c.quote) k2fail(`${where}: the \`quote\` has leading or trailing whitespace — it is copied verbatim`);
      if (c.archive !== undefined) {
        const refused = archiveRefusal(c.archive);
        if (refused) k2fail(`${where}: the archive \`${clean(c.archive)}\` ${refused} (§12 Q13)`);
      }
    }
    if (k2 > 0) fm = null;
  }

  // K3 — completeness.
  if (fm) {
    for (const q of questions) {
      const id = clean(q.id);
      const has = (k: string): boolean => typeof q[k] === "string" && (q[k] as string).trim() !== "";
      if ((q.status === "answered" || q.status === "partial") && !has("answer")) fail("K3", `question \`${id}\` is \`${q.status}\` but has no \`answer\``, FINDINGS_FILE);
      if (q.status === "unanswerable" && !has("reason")) fail("K3", `question \`${id}\` is \`unanswerable\` but gives no \`reason\``, FINDINGS_FILE);
      if (q.status === "answered" && (!Array.isArray(q.cites) || q.cites.length === 0)) fail("K3", `question \`${id}\` is \`answered\` but cites nothing — an answer is grounded in the code or a page (§2.3, §2.5)`, FINDINGS_FILE);
    }
    const sections = body === null ? [] : level2Sections(body).sections;
    if (!sections.some((s) => s.title === "Summary")) fail("K3", "the body has no `## Summary` — it is what the Findings evidence carries (§2.4)", FINDINGS_FILE);
  }

  // K4 — size: line spans, the file's URL cites and the body's sections (the counts came from the schema above).
  if (fm) {
    for (const c of repoCites) {
      const [a, b] = c.lines.split("-").map(Number) as [number, number | undefined];
      const where = `cite \`${clean(c.path)}\` lines \`${c.lines}\``;
      if (b !== undefined && b < a) fail("K4", `${where} runs backwards`, FINDINGS_FILE);
      else if (b !== undefined && b - a > KB_LIMITS.lineSpanMax) fail("K4", `${where} spans ${b - a} lines; at most ${KB_LIMITS.lineSpanMax} (§2.3)`, FINDINGS_FILE);
    }
    if (urlCites.length > KB_LIMITS.urlCitesMax) fail("K4", `the file carries ${urlCites.length} URL cites; at most ${KB_LIMITS.urlCitesMax}, across questions and risks — K8 fetches each one (§2.5)`, FINDINGS_FILE);
  }
  if (body !== null) {
    for (const s of level2Sections(body).sections) {
      const n = charLength(s.lines.join("\n").trim());
      const max = s.title === "Summary" ? KB_LIMITS.summaryChars : KB_LIMITS.questionSectionChars;
      if (n > max) fail("K4", `\`## ${clean(s.title)}\` is ${n} characters; at most ${max} (§2.3)`, FINDINGS_FILE);
    }
  }

  // K5 — hygiene: no cite to a deny-listed path, no credential in a URL, no secret-shaped text anywhere in the file.
  if (fm) {
    for (const c of repoCites) {
      if (isDeniedPath(c.path)) fail("K5", `a cite names \`${clean(c.path)}\`, a deny-listed path — the worker never opens it (§10)`, FINDINGS_FILE);
    }
    for (const c of urlCites) {
      for (const [what, url] of [["URL cite", c.url], ["archive", c.archive]] as const) {
        const why = url === undefined ? null : urlHygieneRefusal(url);
        if (why) fail("K5", `a${what === "archive" ? "n" : ""} ${what} ${why} — a cite never carries a credential (§3.4 K5)`, FINDINGS_FILE);
      }
    }
  }
  kbSecretScan(text, FINDINGS_FILE, fail);
  // …and every text evidence file, as findings.md is.
  for (const rel of evidence) kbSecretScan(src.files.get(rel), rel, fail);

  // K9 — evidence cited: every evidence file is cited at least once, and every cite names one.
  const held = new Set(evidence.map((rel) => rel.slice(EVIDENCE_DIR.length + 1)));
  // A name K1 refuses cannot be cited (the cite grammar is K1's name); K1 alone reports it.
  const citable = [...held].filter((name) => KB_EVIDENCE_NAME_RE.test(name));
  const cited = new Set<string>();
  for (const m of text.matchAll(INLINE_EVIDENCE_RE)) cited.add((m[1] as string).replace(/\.+$/, ""));
  for (const c of evidenceCites) cited.add(c.file);
  for (const name of [...cited].sort()) {
    if (!held.has(name)) fail("K9", `\`evidence:${clean(name)}\` is cited, but \`${EVIDENCE_DIR}/${clean(name)}\` is not in the folder — a dangling cite`, FINDINGS_FILE);
  }
  // An invalid frontmatter hides its evidence cites; the uncited check then waits for K2's fix.
  if (fm || !rawEvidenceCite(text)) {
    for (const name of citable.sort()) {
      if (!cited.has(name)) fail("K9", `is never cited — findings.md names every evidence file it carries (\`evidence:${clean(name)}\` inline or a \`kind: evidence\` cite)`, `${EVIDENCE_DIR}/${name}`);
    }
  } else notes.push("K9's uncited-file check not run: the frontmatter is not valid (K2), so its evidence cites could not be read");

  // K10–K14 — the security block (v1.3, design alissa-security-review §5.2). A block the schema
  // refused was reported above (K10, or K11 for its key); the rules below read the blocks that parsed.
  if (fm) kbSecurity(fm, questions, fail);
  // K15, K16 and K18 — the doc block (v1.4, design alissa-documentation-check §5.2), offline like
  // K10–K14; K17, its verbatim passage, goes through the verify route with K7 below.
  if (fm) kbDoc(fm, questions, fail);

  // §3.6 — the review line: `light` for any URL cite or any `high`-impact question, else `none`.
  // A `critical` or `high` security block counts as impact `high` (alissa-security-review §5.2), and so
  // does a `wrong` doc verdict whose fix is the code's (alissa-documentation-check §5.2).
  if (fm) {
    const high = questions.filter((q) =>
      ((q.unblocks as Array<{ impact?: unknown }> | undefined) ?? []).some((u) => u.impact === "high") || isHighSecurity(q.security) || isHighDoc(q.doc))
      .map((q) => q.id as string);
    const reasons = [...(urlCites.length > 0 ? [`external cites: ${urlCites.length}`] : []), ...(high.length > 0 ? [`high impact: ${high.join(", ")}`] : [])];
    review = { level: reasons.length > 0 ? "light" : "none", reasons };
  } else notes.push("Discovery-Review: not classified — the frontmatter is not valid (K2); a reader treats a missing line as light");

  if (!opts.online) {
    notes.push("K6–K8 and K17 not run (offline)");
    return result(["K1", "K2", "K3", "K4", "K5", "K9", ...SECURITY_RULES, "K15", "K16", "K18"]);
  }
  const online: KRule[] = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", ...SECURITY_RULES, ...DOC_RULES];
  if (!fm) {
    notes.push("K6–K8 and K17 not evaluated: the frontmatter is not valid (K2)");
    return result(online);
  }
  const reads = fm.reads as Array<{ repo: string; sha: string }>;
  await kbTask(fm, src, urlCites.length, opts.reader, fail);
  await kbCites(repoCites, reads, opts.verifier, fail, notes);
  if (urlCites.length > KB_LIMITS.urlCitesMax) notes.push(`K8 not run: ${urlCites.length} URL cites is past the route's ${KB_LIMITS.urlCitesMax} (K4)`);
  else await kbUrlCites(urlCites, opts.verifier, fail, notes);
  await kbPassages(questions, reads, opts.verifier, fail, notes);
  return result(online);
}

// ── K10–K14: the security block (design alissa-security-review §5.1, §5.2, lane SR-2) ─────────────
// Offline, like K1–K5 and K9. K10 holds the block to the schema and its severity to §5.1's table;
// K11 its key; K12 its question's status and cites; K13 its free text; K14 the file's `kind`.

const SECURITY_RULES: readonly KRule[] = ["K10", "K11", "K12", "K13", "K14"];
/** A schema error inside a question's `security` block. */
const SECURITY_PATH_RE = /^\/questions\/(\d+)\/security(?:\/|$)/;
/** K11's key grammar, the schema's own (§5.1). */
export const SECURITY_KEY_RE = /^[a-z0-9.-]{1,80}$/;
export const SECURITY_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];
/** The hosts a scenario or a fix may link to in full (K13): the code host the repositories live on. */
export const SECURITY_REPOSITORY_HOSTS = ["github.com"] as const;

/**
 * §5.1's table: the severity a consequence calls for when the finding is reachable (`yes` or
 * `unknown`). `security` spans two rows — `critical` with no precondition, `high` behind an
 * authenticated user — and the block does not say which, so either is on the table for it.
 * Unreachable (`reachable: no`) is `low` for every consequence.
 */
const SEVERITY_TABLE: Readonly<Record<string, readonly SecuritySeverity[]>> = {
  money: ["critical"], data: ["critical"], security: ["critical", "high"],
  correctness: ["medium"], leak: ["medium"], alarm: ["medium"], stall: ["medium"], contract: ["medium"],
  cosmetic: ["low"], "redundant-test": ["low"], hypothetical: ["low"],
};

/** The severities §5.1's table gives a consequence at a reachability. */
export function tableSeverities(consequence: string, reachable: string): readonly SecuritySeverity[] {
  if (reachable === "no") return ["low"];
  return SEVERITY_TABLE[consequence] ?? [];
}

/** How many steps `severity` stands from the nearest severity the table gives (K10). */
export function severitySteps(severity: SecuritySeverity, consequence: string, reachable: string): number {
  const at = SECURITY_SEVERITIES.indexOf(severity);
  return Math.min(...tableSeverities(consequence, reachable).map((t) => Math.abs(SECURITY_SEVERITIES.indexOf(t) - at)));
}

/** Does a question's `security` block put it at impact `high` for the review line (§5.2)? */
function isHighSecurity(security: unknown): boolean {
  return isRecord(security) && (security.severity === "critical" || security.severity === "high");
}

/** A schema error inside a `security` block, as K10 (or K11, for the key's grammar) reports it. */
function securitySchemaError(e: ErrorObject, fm: unknown, fail: KbFail): void {
  const m = SECURITY_PATH_RE.exec(e.instancePath) as RegExpExecArray;
  const doc = isRecord(fm) ? fm : {};
  const q = Array.isArray(doc.questions) ? doc.questions[Number(m[1])] : undefined;
  const id = isRecord(q) && typeof q.id === "string" ? q.id : `#${m[1]}`;
  if (e.keyword === "false schema") {
    return fail("K10", `question \`${clean(id)}\` carries a \`security\` block — it needs \`schema: ${FINDINGS_SCHEMA_V13}\` (alissa-security-review §5.1)`, FINDINGS_FILE);
  }
  if (e.instancePath.endsWith("/security/key") && e.keyword === "pattern") {
    const key = isRecord(q) && isRecord(q.security) ? q.security.key : undefined;
    return fail("K11", `question \`${clean(id)}\`: the \`security.key\` \`${clean(key)}\` is not \`[a-z0-9.-]{1,80}\` — a stable slug of repository, category and symbol (§4.2)`, FINDINGS_FILE);
  }
  fail("K10", `question \`${clean(id)}\`: frontmatter ${ajvMessage(e)}`, FINDINGS_FILE);
}

/** The blocks of a schema-valid frontmatter's questions that are well formed (the schema's errors were K10's or K11's). */
function securityBlocks(questions: Array<Record<string, unknown>>): Array<{ q: Record<string, unknown>; id: string; s: Record<string, unknown> }> {
  const out = [];
  for (const q of questions) if (isRecord(q.security)) out.push({ q, id: clean(q.id), s: q.security });
  return out;
}

/** K10–K14 over a frontmatter K2 admitted. */
function kbSecurity(fm: Record<string, unknown>, questions: Array<Record<string, unknown>>, fail: KbFail): void {
  const blocks = securityBlocks(questions);
  const keys = new Map<string, string>();
  for (const { q, id, s } of blocks) {
    // K10 — severity against §5.1's table: more than one step off, with no `calibration` reason.
    const severity = s.severity, consequence = s.consequence, reachable = s.reachable;
    if (typeof severity === "string" && (SECURITY_SEVERITIES as readonly string[]).includes(severity) && typeof consequence === "string" && typeof reachable === "string") {
      const table = tableSeverities(consequence, reachable);
      const calibrated = typeof s.calibration === "string" && s.calibration.trim() !== "";
      if (table.length > 0 && severitySteps(severity as SecuritySeverity, consequence, reachable) > 1 && !calibrated) {
        fail("K10", `question \`${id}\`: \`severity: ${severity}\` is more than one step from §5.1's table (\`${consequence}\`, \`reachable: ${reachable}\` → ${table.map((t) => `\`${t}\``).join(" or ")}) and carries no \`calibration\` reason`, FINDINGS_FILE);
      }
    }
    // K11 — one key per finding in the file (its grammar is the schema's, reported above).
    if (typeof s.key === "string" && SECURITY_KEY_RE.test(s.key)) {
      const first = keys.get(s.key);
      if (first !== undefined) fail("K11", `questions \`${first}\` and \`${id}\` share the \`security.key\` \`${s.key}\` — a key names one finding across runs (§4.2)`, FINDINGS_FILE);
      else keys.set(s.key, id);
    }
    // K12 — a security finding is answered (or partly) and cites the code or its evidence.
    if (q.status !== "answered" && q.status !== "partial") fail("K12", `question \`${id}\` is \`${clean(q.status)}\` but carries a \`security\` block — a finding is \`answered\` or \`partial\``, FINDINGS_FILE);
    const cites = Array.isArray(q.cites) ? (q.cites as unknown[]) : [];
    if (!cites.some((c) => isRecord(c) && c.kind !== "url")) fail("K12", `question \`${id}\` carries a \`security\` block but no repo or evidence cite — a finding is grounded in the code at the pinned SHA`, FINDINGS_FILE);
    // K13 — the free text holds no secret, no link off the code host and no address.
    for (const field of ["scenario", "fix"] as const) {
      const text = s[field];
      if (typeof text !== "string") continue;
      for (const why of securityTextRefusals(text)) fail("K13", `question \`${id}\`: \`security.${field}\` carries ${why}`, FINDINGS_FILE);
    }
  }
  // K14 — a file with a security finding says it is a security review's, so the projection can gate it (§8).
  if (blocks.length > 0 && fm.kind !== "security_review") {
    fail("K14", `${blocks.length} question(s) carry a \`security\` block (${blocks.map((b) => `\`${b.id}\``).join(", ")}) but the frontmatter has no \`kind: security_review\` — the projection gates a security review's findings by it (alissa-security-review §8)`, FINDINGS_FILE);
  }
}

// ── K15–K18: the doc block (design alissa-documentation-check §5.1, §5.2, lane DOC-3) ──────────────
// K15, K16 and K18 are offline, like K10–K14. K15 holds the block to the schema and to its verdict's
// rules; K16 its key; K18 the file's `kind`. K17 — the trust anchor — asks Studio's verify route,
// the one K7 uses, whether each quoted passage is in its doc file at the pinned SHA.

const DOC_RULES: readonly KRule[] = ["K15", "K16", "K17", "K18"];
/** A schema error inside a question's `doc` block. */
const DOC_PATH_RE = /^\/questions\/(\d+)\/doc(?:\/|$)/;
/** K16's key grammar, the schema's own (§5.1 Key convention). */
export const DOC_KEY_RE = /^[a-z0-9.-]{1,80}$/;
/** What K17 posts for a passage, and what Studio compares it against: every whitespace run is one space, trimmed (§5.2). */
export function normalizePassage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Does a question's `doc` block put it at impact `high` for the review line (§5.2: `wrong` with `fixSide: code`)? */
function isHighDoc(doc: unknown): boolean {
  return isRecord(doc) && doc.verdict === "wrong" && doc.fixSide === "code";
}

/** A schema error inside a `doc` block, as K15 (or K16, for the key's grammar) reports it. */
function docSchemaError(e: ErrorObject, fm: unknown, fail: KbFail): void {
  const m = DOC_PATH_RE.exec(e.instancePath) as RegExpExecArray;
  const doc = isRecord(fm) ? fm : {};
  const q = Array.isArray(doc.questions) ? doc.questions[Number(m[1])] : undefined;
  const id = isRecord(q) && typeof q.id === "string" ? q.id : `#${m[1]}`;
  if (e.keyword === "false schema") {
    return fail("K15", `question \`${clean(id)}\` carries a \`doc\` block — it needs \`schema: ${FINDINGS_SCHEMA_V14}\` (alissa-documentation-check §5.1)`, FINDINGS_FILE);
  }
  if (e.instancePath.endsWith("/doc/key") && e.keyword === "pattern") {
    const key = isRecord(q) && isRecord(q.doc) ? q.doc.key : undefined;
    return fail("K16", `question \`${clean(id)}\`: the \`doc.key\` \`${clean(key)}\` is not \`[a-z0-9.-]{1,80}\` — \`<repo>.<doc-stem>.<subject>\`, slugged (§5.1)`, FINDINGS_FILE);
  }
  fail("K15", `question \`${clean(id)}\`: frontmatter ${ajvMessage(e)}`, FINDINGS_FILE);
}

/** The questions that carry a `doc` block. */
function docBlocks(questions: Array<Record<string, unknown>>): Array<{ q: Record<string, unknown>; id: string; d: Record<string, unknown> }> {
  const out = [];
  for (const q of questions) if (isRecord(q.doc)) out.push({ q, id: clean(q.id), d: q.doc });
  return out;
}

/** K15, K16 and K18 over a frontmatter K2 admitted (K17 is online: `kbPassages`). */
function kbDoc(fm: Record<string, unknown>, questions: Array<Record<string, unknown>>, fail: KbFail): void {
  const blocks = docBlocks(questions);
  const keys = new Map<string, string>();
  for (const { q, id, d } of blocks) {
    // K15 — a question is a security finding or a doc verdict, never both.
    if (q.security !== undefined) fail("K15", `question \`${id}\` carries both a \`security\` and a \`doc\` block — a question carries one or the other (§5.1)`, FINDINGS_FILE);
    // K15 — the passage is quoted for every verdict but `missing`, which has none to quote.
    const hasPassage = d.passage !== undefined;
    if (d.verdict === "missing" && hasPassage) fail("K15", `question \`${id}\`: a \`missing\` verdict carries a \`passage\` — a missing passage has nothing to quote; \`docPath\` names where it belongs (§5.1)`, FINDINGS_FILE);
    if (typeof d.verdict === "string" && d.verdict !== "missing" && !hasPassage) fail("K15", `question \`${id}\`: a \`${clean(d.verdict)}\` verdict carries no \`passage\` — the passage it judges is quoted verbatim (§5.1)`, FINDINGS_FILE);
    // K15 — a `right` passage needs no code change and no question: its side is the doc's.
    if (d.verdict === "right" && typeof d.fixSide === "string" && d.fixSide !== "doc") fail("K15", `question \`${id}\`: a \`right\` verdict has \`fixSide: ${clean(d.fixSide)}\` — it is \`doc\` (§5.2)`, FINDINGS_FILE);
    // K15 — an answered verdict cites the code at the pinned SHA; a `missing` one, the uncovered code area.
    const cites = Array.isArray(q.cites) ? (q.cites as unknown[]) : [];
    if ((q.status === "answered" || q.status === "partial") && !cites.some((c) => isRecord(c) && (c.kind === undefined || c.kind === "repo"))) {
      fail("K15", `question \`${id}\` is \`${q.status}\` and carries a \`doc\` block but no repo cite — a verdict cites the code at the pinned SHA (for \`missing\`, the uncovered code area) (§5.1)`, FINDINGS_FILE);
    }
    // K16 — one key per verdict in the file (its grammar is the schema's, reported above).
    if (typeof d.key === "string" && DOC_KEY_RE.test(d.key)) {
      const first = keys.get(d.key);
      if (first !== undefined) fail("K16", `questions \`${first}\` and \`${id}\` share the \`doc.key\` \`${d.key}\` — a key is one passage's identity across runs (§5.1)`, FINDINGS_FILE);
      else keys.set(d.key, id);
    }
  }
  // K18 — a file with a doc verdict says it is a documentation check's.
  if (blocks.length > 0 && fm.kind !== "doc_check") {
    fail("K18", `${blocks.length} question(s) carry a \`doc\` block (${blocks.map((b) => `\`${b.id}\``).join(", ")}) but the frontmatter has no \`kind: doc_check\` (alissa-documentation-check §5.2)`, FINDINGS_FILE);
  }
}

/** Studio's verify route's reasons for a passage (K17). */
const PASSAGE_REASONS: Readonly<Record<string, string>> = {
  path_missing: "does not exist at the pinned SHA",
  passage_missing: "does not hold the passage (whitespace-normalized) — a passage is quoted verbatim, never paraphrased",
};

/**
 * What a 400 to K17's POST most likely means. As of 2026-11-04 Studio's verify route
 * (`convex/buildKnowledge.ts` `validateVerifyFiles`) reads only `{ files }` and refuses `{ passages }`
 * with a 400, so every online doc_check run exits 3 until Studio implements README's K17 contract.
 * The message says so, so that an operator does not mistake the 400 for a defect in the finding.
 */
const PASSAGES_UNSUPPORTED = "Studio's verify route may not read `passages` yet (README, K17: the route contract Studio must implement), so no doc_check finding can pass K17 online until it does";

/**
 * K17: one POST to Studio's verify route — K7's — with every distinct quoted passage, `{ passages:
 * [{ repo, sha, path, passage }] }`, the passage whitespace-normalized and the SHA the `reads` entry
 * of the block's `docRepo` (the task's `Alissa-Reads`, which K6 holds `reads` to). The route answers
 * `{ results: [{ ok, reason?, detail? }] }` in the same order. Anything else — the route down, an
 * error status (a route that does not read `passages` yet answers 400), an answer of the wrong
 * shape — is "could not run": a passage that cannot be checked is never a pass.
 */
async function kbPassages(questions: Array<Record<string, unknown>>, reads: Array<{ repo: string; sha: string }>, verifier: AlissaPoster, fail: KbFail, notes: string[]): Promise<void> {
  const shaOf = new Map(reads.map((r) => [r.repo.toLowerCase(), r.sha]));
  const seen = new Map<string, number>();
  const asked: Array<{ repo: string; sha: string; path: string; passage: string }> = [];
  const askers: string[][] = [];
  for (const { id, d } of docBlocks(questions)) {
    if (typeof d.passage !== "string" || typeof d.docRepo !== "string" || typeof d.docPath !== "string") continue;
    const sha = shaOf.get(d.docRepo.toLowerCase());
    if (sha === undefined) {
      fail("K17", `question \`${id}\`: \`doc.docRepo\` \`${clean(d.docRepo)}\` is not in \`reads\` — a passage is checked at the SHA the task pins (Alissa-Reads)`, FINDINGS_FILE);
      continue;
    }
    const entry = { repo: d.docRepo, sha, path: d.docPath, passage: normalizePassage(d.passage) };
    const key = JSON.stringify([entry.repo.toLowerCase(), entry.sha, entry.path, entry.passage]);
    const at = seen.get(key);
    if (at !== undefined) {
      (askers[at] as string[]).push(id);
      continue;
    }
    seen.set(key, asked.length);
    asked.push(entry);
    askers.push([id]);
  }
  if (asked.length === 0) {
    notes.push("K17: the findings quote no doc passage");
    return;
  }
  const couldNot = (why: string): void => fail("K17", `plan-lint could not run: Studio's verify route (POST ${VERIFY_ROUTE}) ${why} — a passage that cannot be checked is never a pass`, FINDINGS_FILE, true);
  let res;
  try {
    res = await verifier.post(VERIFY_ROUTE, { passages: asked });
  } catch (err) {
    if (err instanceof AlissaUnavailable) return couldNot(`is unreachable: ${err.message}`);
    throw err;
  }
  if (res.status === 400) return couldNot(`answered ${describe(res)}; ${PASSAGES_UNSUPPORTED}`);
  if (res.status !== 200) return couldNot(`answered ${describe(res)}`);
  const results = (res.body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== asked.length || !results.every((r) => isRecord(r) && typeof r.ok === "boolean")) {
    return couldNot("answered in an unexpected shape");
  }
  results.forEach((r, i) => {
    const rr = r as { ok: boolean; reason?: unknown; detail?: unknown };
    if (rr.ok) return;
    const p = asked[i] as (typeof asked)[number];
    const why = typeof rr.reason === "string" ? (PASSAGE_REASONS[rr.reason] ?? `does not hold the passage (${clean(rr.reason)})`) : "does not hold the passage";
    const detail = typeof rr.detail === "string" && rr.detail !== "" ? ` — ${clean(rr.detail)}` : "";
    const ids = (askers[i] as string[]).map((x) => `\`${x}\``).join(", ");
    fail("K17", `question(s) ${ids}: \`${clean(p.repo)}:${clean(p.path)}\` at ${p.sha.slice(0, 7)} ${why}${detail}`, FINDINGS_FILE);
  });
}

const SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`)\]]+/gi;
const IPV4_CANDIDATE_RE = /(?<![0-9.])\d{1,3}(?:\.\d{1,3}){3}(?![0-9]|\.\d)/g;
const IPV6_CANDIDATE_RE = /(?<![0-9A-Za-z:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%[0-9A-Za-z]+)?(?![0-9A-Za-z:])/g;

/**
 * Is a v6 candidate an address rather than a symbol path? `isIP` reads hex-only `::` paths a
 * scenario plausibly names — `db::add`, `be::ef`, `a::b` — as v6, so K13 counts a candidate only
 * when it carries a decimal digit (`::1`, `fe80::`, `2001:db8::1`) or three or more non-empty
 * groups (`dead:beef:cafe::`). The residue it lets through — an all-letter address of at most two
 * groups, like `fd::` or `dead::beef` — is a known false negative (README, K13).
 */
function isIpv6Address(candidate: string): boolean {
  if (isIP(candidate) !== 6) return false;
  return /[0-9]/.test(candidate) || candidate.split(":").filter((g) => g !== "").length >= 3;
}

/** The host of a scheme URL, lower case, or null when it has none. */
function urlHost(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why a `scenario` or a `fix` may not be published as written (K13), never quoting the offending
 * text: a secret-shaped string (K5's token shapes), a full URL to a host other than the code host,
 * or an IP address (v4, or v6 as `node:net` reads it, less hex-only `::` symbol paths like `db::add`).
 */
export function securityTextRefusals(text: string): string[] {
  const out: string[] = [];
  if (secretShapedLines(text).length > 0) out.push("secret-shaped text — the token shapes of repoContextFilter.ts (K5's list)");
  let urls = 0;
  for (const m of text.matchAll(SCHEME_URL_RE)) {
    const host = urlHost(m[0]);
    if (host === null || !(SECURITY_REPOSITORY_HOSTS as readonly string[]).includes(host)) urls++;
  }
  if (urls > 0) out.push(`${urls} full URL(s) to a host other than ${SECURITY_REPOSITORY_HOSTS.join(", ")} — a scenario names the code, never a live endpoint`);
  let ips = 0;
  const bare = text.replace(SCHEME_URL_RE, " ");
  for (const m of bare.matchAll(IPV4_CANDIDATE_RE)) if (isIP(m[0]) === 4) ips++;
  for (const m of bare.matchAll(IPV6_CANDIDATE_RE)) if (isIpv6Address(m[0])) ips++;
  if (ips > 0) out.push(`${ips} IP address(es) — a scenario names the code, never a host`);
  return out;
}

/** K5's token-shape scan over one text file; an unreadable file (past the read cap) is K4's. */
function kbSecretScan(text: string | undefined, file: string, fail: KbFail): void {
  if (text === undefined) return;
  const lines = secretShapedLines(text);
  if (lines.length > 0) fail("K5", `secret-shaped text on line(s) ${lines.join(", ")} — the token shapes of repoContextFilter.ts (§10)`, file);
}

/** Does the raw frontmatter appear to carry a `kind: evidence` cite? */
function rawEvidenceCite(text: string): boolean {
  const split = splitFrontmatter(text);
  return split.ok && /\bkind:\s*["']?evidence\b/.test(split.frontmatter);
}

/** K1's evidence types (by extension; an image by its bytes too; an svg inert) and K4's caps. */
function kbEvidenceShape(src: KbSource, evidence: string[], fail: KbFail): void {
  if (evidence.length > KB_LIMITS.evidenceFilesMax) fail("K4", `the finding carries ${evidence.length} evidence files; at most ${KB_LIMITS.evidenceFilesMax}`);
  const total = evidence.reduce((n, rel) => n + (src.sizes.get(rel) ?? 0), 0);
  if (total > KB_LIMITS.evidenceBytesMax) fail("K4", `the evidence is ${total} bytes in all; at most ${KB_LIMITS.evidenceBytesMax} (10 MB)`);
  for (const rel of evidence) {
    const name = rel.slice(EVIDENCE_DIR.length + 1);
    const size = src.sizes.get(rel) ?? 0;
    if (size > KB_LIMITS.evidenceFileBytes) fail("K4", `is ${size} bytes; an evidence file is at most ${KB_LIMITS.evidenceFileBytes} (2 MB)`, rel);
    if (!KB_EVIDENCE_NAME_RE.test(name)) fail("K1", "is not named `[a-z0-9][a-z0-9._-]{0,63}` — an evidence file's name is lower case, at most 64 characters", clean(rel));
    const ext = extensionOf(name);
    if (ext === undefined || !(KB_EVIDENCE_TYPES as readonly string[]).includes(ext)) {
      fail("K1", `is ${ext === undefined ? "a file with no type" : `a \`.${clean(ext)}\` file`} — evidence is ${KB_EVIDENCE_TYPES.join(", ")} only`, clean(rel));
      continue;
    }
    const bytes = src.evidence.get(rel);
    if (bytes === undefined) continue;
    const not = imageMismatch(ext, bytes);
    if (not) fail("K1", `is named \`.${ext}\`, but its bytes are not ${not}`, rel);
    const enc = isKbTextEvidence(rel) ? notUtf8(bytes) : null;
    if (enc) {
      fail("K1", `${enc} — text evidence is UTF-8, so the svg and secret scans read what a viewer renders`, rel);
      continue;
    }
    if (ext === "svg") {
      const why = svgRefusals(src.files.get(rel) ?? "");
      if (why.length > 0) fail("K1", `is an svg carrying ${why.join(", ")} — an svg is evidence only when it is inert`, rel);
    }
  }
}

/** Every cite of the questions and the risks, split by kind: a repo cite has no `kind`, or `kind: repo`. */
function citesOf(questions: Array<Record<string, unknown>>, risks: Array<Record<string, unknown>>): { repoCites: Cite[]; urlCites: UrlCite[]; evidenceCites: EvidenceCite[] } {
  const repoCites: Cite[] = [];
  const urlCites: UrlCite[] = [];
  const evidenceCites: EvidenceCite[] = [];
  for (const x of [...questions, ...risks]) {
    if (!Array.isArray(x.cites)) continue;
    for (const c of x.cites as Array<Record<string, unknown>>) {
      if (c.kind === "url") urlCites.push(c as unknown as UrlCite);
      else if (c.kind === "evidence") evidenceCites.push(c as unknown as EvidenceCite);
      else repoCites.push(c as unknown as Cite);
    }
  }
  return { repoCites, urlCites, evidenceCites };
}

type KbFail = (rule: KRule, message: string, file?: string, couldNotRun?: boolean) => void;

/**
 * K6: the task resolves, is a discovery task created on the directory's day, and pinned what `reads`
 * says (`Alissa-Reads: none` for no read); v1.1: a URL cite only on a task whose `Alissa-Sources:` is
 * `web` or `both`, and an ask's `asker` resolving to a task of the same owner (§2.5, §3.4, §4.6).
 */
async function kbTask(fm: Record<string, unknown>, src: KbSource, urlCiteCount: number, reader: AlissaReader, fail: KbFail): Promise<void> {
  const task = fm.task as string;
  let res;
  try {
    res = await reader.get(`/v1/tasks/${encodeURIComponent(task)}?view=full`);
  } catch (err) {
    if (err instanceof AlissaUnavailable) return fail("K6", `plan-lint could not run: could not read \`${task}\`: ${err.message}`, FINDINGS_FILE, true);
    throw err;
  }
  if (res.status === 404) return fail("K6", `\`${task}\` does not resolve (${describe(res)})`, FINDINGS_FILE);
  if (res.status !== 200) return fail("K6", `plan-lint could not run: could not read \`${task}\`: ${describe(res)}`, FINDINGS_FILE, true);
  const t = (res.body as { task?: Record<string, unknown> } | null)?.task ?? {};
  if (t.kind !== "discovery") fail("K6", `\`${task}\` is \`kind: ${clean(t.kind ?? "code")}\`, not \`discovery\``, FINDINGS_FILE);
  if (typeof t.createdAt !== "number") fail("K6", `\`${task}\` carries no creation time to check the directory's date against`, FINDINGS_FILE);
  else if (src.day !== null && utcDay(t.createdAt) !== src.day) {
    fail("K6", `\`${task}\` was created on ${utcDay(t.createdAt)} (UTC), but its directory is dated ${src.day} (§4.2)`, FINDINGS_FILE);
  }
  const description = typeof t.description === "string" ? t.description : "";

  // The sources: absent reads as `code`, which admits no URL cite (§2.2, §2.5).
  const declared = SOURCES_TRAILER_RE.exec(description)?.[1];
  const sources = declared ?? "code";
  if (declared !== undefined && !["code", "web", "both"].includes(declared)) fail("K6", `\`${task}\` carries \`Alissa-Sources: ${clean(declared)}\` — it is \`code\`, \`web\` or \`both\``, FINDINGS_FILE);
  else if (urlCiteCount > 0 && sources !== "web" && sources !== "both") {
    fail("K6", `the findings carry ${urlCiteCount} URL cite(s), but \`${task}\` reads \`sources: ${clean(sources)}\` (no \`Alissa-Sources: web\` or \`both\`) — a code question keeps the strong check (§2.5)`, FINDINGS_FILE);
  }

  // The reads: each pinned by the task's Alissa-Reads; `Alissa-Reads: none` matches an empty `reads`.
  const reads = fm.reads as Array<{ repo: string; sha: string }>;
  const pinned = new Map<string, string>();
  for (const m of description.matchAll(READS_TRAILER_RE)) pinned.set((m[1] as string).toLowerCase(), m[2] as string);
  if (pinned.size === 0 && READS_NONE_RE.test(description)) {
    if (reads.length > 0) fail("K6", `\`${task}\` carries \`Alissa-Reads: none\`, but \`reads\` names ${reads.map((r) => `\`${clean(r.repo)}\``).join(", ")} — a task that reads no repository cites none`, FINDINGS_FILE);
  } else if (pinned.size === 0) {
    fail("K6", `\`${task}\` carries no \`Alissa-Reads: <owner>/<repo>@<sha>\` trailer — its read SHA is unknown, so K6 refuses rather than guesses`, FINDINGS_FILE);
  } else {
    for (const r of reads) {
      const want = pinned.get(r.repo.toLowerCase());
      if (want === undefined) fail("K6", `\`reads\` names \`${clean(r.repo)}\`, which \`${task}\` does not read (its Alissa-Reads: ${[...pinned.keys()].join(", ")})`, FINDINGS_FILE);
      else if (want !== r.sha) fail("K6", `\`reads\` pins \`${clean(r.repo)}\` at \`${r.sha}\`, but \`${task}\`'s Alissa-Reads pins \`${want}\``, FINDINGS_FILE);
    }
  }

  // The asker (§4.6): it resolves to a task of the discovery task's own owner, and agrees with the task's Alissa-Asker.
  const trailerAsker = ASKER_TRAILER_RE.exec(description)?.[1] ?? null;
  const asker = typeof fm.asker === "string" ? fm.asker : null;
  if (trailerAsker !== null && trailerAsker !== asker) {
    fail("K6", `\`${task}\` was asked by \`${clean(trailerAsker)}\` (its Alissa-Asker), but the finding's \`asker\` is ${asker === null ? "absent" : `\`${asker}\``}`, FINDINGS_FILE);
  }
  if (asker === null) return;
  let ask;
  try {
    ask = await reader.get(`/v1/tasks/${encodeURIComponent(asker)}`);
  } catch (err) {
    if (err instanceof AlissaUnavailable) return fail("K6", `plan-lint could not run: could not read the asker \`${asker}\`: ${err.message}`, FINDINGS_FILE, true);
    throw err;
  }
  if (ask.status === 404) return fail("K6", `the asker \`${asker}\` does not resolve (${describe(ask)})`, FINDINGS_FILE);
  if (ask.status !== 200) return fail("K6", `plan-lint could not run: could not read the asker \`${asker}\`: ${describe(ask)}`, FINDINGS_FILE, true);
  const owner = (ask.body as { task?: { ownerId?: unknown } } | null)?.task?.ownerId;
  if (typeof owner !== "string" || typeof t.ownerId !== "string") {
    fail("K6", `the asker \`${asker}\` or \`${task}\` carries no owner to compare — K6 refuses rather than guesses (§4.6)`, FINDINGS_FILE);
  } else if (owner !== t.ownerId) fail("K6", `the asker \`${asker}\` belongs to another owner than \`${task}\` — an ask never crosses owners (§4.6)`, FINDINGS_FILE);
}

/**
 * K7: one POST to Studio's verify route with every distinct cite, each `{ repo, sha, path, blob,
 * lines }`; the route answers `{ results: [{ ok, reason?, detail? }] }` in the same order. Anything
 * else — the route down, an error status, an answer of the wrong shape — is "could not run".
 */
async function kbCites(cites: Cite[], reads: Array<{ repo: string; sha: string }>, verifier: AlissaPoster, fail: KbFail, notes: string[]): Promise<void> {
  // Every cite is read at its repository's `reads` SHA; K2 checked that each cite's repo is there.
  const shaOf = new Map(reads.map((r) => [r.repo.toLowerCase(), r.sha]));
  const seen = new Set<string>();
  const files: Array<Cite & { sha: string }> = [];
  for (const c of cites) {
    const key = JSON.stringify([c.repo.toLowerCase(), c.path, c.lines, c.blob]);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ ...c, sha: shaOf.get(c.repo.toLowerCase()) as string });
  }
  if (files.length === 0) {
    notes.push("K7: the findings cite no repository file");
    return;
  }
  const couldNot = (why: string): void => fail("K7", `plan-lint could not run: Studio's verify route (POST ${VERIFY_ROUTE}) ${why} — a cite that cannot be checked is never a pass`, FINDINGS_FILE, true);
  let res;
  try {
    res = await verifier.post(VERIFY_ROUTE, { files: files.map(({ repo, sha, path, blob, lines }) => ({ repo, sha, path, blob, lines })) });
  } catch (err) {
    if (err instanceof AlissaUnavailable) return couldNot(`is unreachable: ${err.message}`);
    throw err;
  }
  if (res.status !== 200) return couldNot(`answered ${describe(res)}`);
  const results = (res.body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== files.length || !results.every((r) => isRecord(r) && typeof r.ok === "boolean")) {
    return couldNot("answered in an unexpected shape");
  }
  results.forEach((r, i) => {
    const rr = r as { ok: boolean; reason?: unknown; detail?: unknown };
    if (rr.ok) return;
    const c = files[i] as Cite;
    const why = typeof rr.reason === "string" ? (VERIFY_REASONS[rr.reason] ?? `does not hold (${clean(rr.reason)})`) : "does not hold";
    const detail = typeof rr.detail === "string" && rr.detail !== "" ? ` — ${clean(rr.detail)}` : "";
    fail("K7", `cite \`${clean(c.repo)}:${clean(c.path)}#L${c.lines}\` ${why}${detail}`, FINDINGS_FILE);
  });
}

/**
 * K8 (v1.1): one POST to Studio's url-cites route with every distinct URL cite, each `{ url, quote,
 * archive? }`; the route fetches each page through DS-16's guarded fetch and answers `{ results:
 * [{ verdict, detail?, guard?, archive? }] }` in the same order. `holds` passes; `archived` passes,
 * and the projection marks the cite stale (§4.5); `refuted`, `gone` and `blocked` fail K8;
 * `unavailable` — a 5xx or a timeout — is "could not run", as is anything else the route answers.
 */
async function kbUrlCites(cites: UrlCite[], verifier: AlissaPoster, fail: KbFail, notes: string[]): Promise<void> {
  const seen = new Set<string>();
  const asked: Array<{ url: string; quote: string; archive?: string }> = [];
  for (const c of cites) {
    const key = JSON.stringify([c.url, c.quote, c.archive ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    asked.push({ url: c.url, quote: c.quote, ...(c.archive === undefined ? {} : { archive: c.archive }) });
  }
  if (asked.length === 0) {
    notes.push("K8: the findings cite no page");
    return;
  }
  const couldNot = (why: string): void => fail("K8", `plan-lint could not run: Studio's url-cites route (POST ${URL_CITES_ROUTE}) ${why} — a cite that cannot be checked is never a pass`, FINDINGS_FILE, true);
  let res;
  try {
    res = await verifier.post(URL_CITES_ROUTE, { cites: asked });
  } catch (err) {
    if (err instanceof AlissaUnavailable) return couldNot(`is unreachable: ${err.message}`);
    throw err;
  }
  if (res.status !== 200) return couldNot(`answered ${describe(res)}`);
  const results = (res.body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== asked.length || !results.every((r) => isRecord(r) && typeof r.verdict === "string" && URL_VERDICTS.has(r.verdict))) {
    return couldNot("answered in an unexpected shape");
  }
  results.forEach((r, i) => {
    const rr = r as { verdict: string; detail?: unknown; guard?: unknown; archive?: unknown };
    const c = asked[i] as { url: string; archive?: string };
    const where = `URL cite \`${clean(c.url)}\``;
    const detail = typeof rr.detail === "string" && rr.detail !== "" ? ` — ${clean(rr.detail)}` : "";
    switch (rr.verdict) {
      case "holds":
        return;
      case "archived":
        notes.push(`K8: ${where} holds only in its archive \`${clean(typeof rr.archive === "string" ? rr.archive : c.archive)}\` — it passes, and the projection marks it stale (§4.5)`);
        return;
      case "refuted":
        return fail("K8", `${where} is refuted: the page answers, and neither it nor an archive holds the quote${detail}`, FINDINGS_FILE);
      case "gone":
        return fail("K8", `${where} is gone (404 or 410), and no archive holds the quote${detail}`, FINDINGS_FILE);
      case "blocked": {
        const guard = typeof rr.guard === "string" ? ` (refused by Studio's ${clean(rr.guard)})` : "";
        return fail("K8", `${where} is blocked${guard} — a 401, 403 or 429, a paywall, or a URL the fetch guard refuses — and no archive holds the quote; supply an archive or another source${detail}`, FINDINGS_FILE);
      }
      default:
        return fail("K8", `plan-lint could not run: ${where} is unavailable (a 5xx or a timeout)${detail} — a cite that cannot be checked is never a pass`, FINDINGS_FILE, true);
    }
  });
}

function sortKb(f: KbFailure[]): KbFailure[] {
  return f.map((x, i) => ({ x, i })).sort((a, b) => Number(a.x.rule.slice(1)) - Number(b.x.rule.slice(1)) || a.i - b.i).map(({ x }) => x);
}

// ── K19–K23: a Code Security report's run directory (design alissa-code-security-reports §4.1–§4.4, lane CSR-2)
// A pull request that touches `knowledge-base/security-reports/<yyyy-mm-dd>-<reviewId>/` is a Report
// task's (a `kind: design` task, K1's online half, as for an assessment). Studio's numbers are the
// source of truth: `report-data.json` is Studio's, committed once, and the prose may say less than it
// but never more, and never something else. Offline, every one. These rules are the port of Studio's
// `securityReportLintOf` (studio.alissa.app `convex/core/securityReportData.ts`, lane CSR-1) and are
// tested on its fixtures, copied byte for byte into `fixtures/security-report/`; Studio re-runs the
// same rules before it imports a report (§4.4), so a change here is a change there.

export const SECURITY_REPORT_RULES: readonly KRule[] = ["K19", "K20", "K21", "K22", "K23"];
export const SECURITY_REPORT_DATA_SCHEMA = "alissa-security-report-data/v1";
export const SECURITY_REPORT_FILE_SCHEMA = "alissa-security-report/v1";
const SECURITY_REPORT_SUMMARY_FILE = "summary.md";
const SECURITY_REPORT_CHAINS_FILE = "technical-chains.md";
const SECURITY_REPORT_TECHNICAL_RE = /^technical-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SECURITY_STATUSES = ["new", "still_open", "fixed", "regressed"] as const;
type SecurityStatus = (typeof SECURITY_STATUSES)[number];
type SecurityReportLang = "en" | "es-MX";

interface ReportFinding {
  ref: string; refs: string[]; key: string; title: string; severity: SecuritySeverity; category: string; repos: string[];
  chain: string | null; consequence: string; reachable: string; status: SecurityStatus; verification: "kept" | "not_reverified";
  codeRemoved: boolean; file: string;
}
interface ReportRefuted { ref: string; finding: string; key: string; title: string; severity: SecuritySeverity; reason: string; file: string }
interface ReportData {
  schema: string;
  review: { id: string; projectId: string; day: string; lang: SecurityReportLang; templateVersion: number; previousReviewId: string | null };
  repos: Array<{ repo: string; slug: string; notes: Array<{ kind: "fork"; parent: string } | { kind: "public" }> }>;
  verifyFiles: Array<{ task: string; path: string }>;
  counts: {
    findings: number; kept: number; notReverified: number; refuted: number; couldntVerify: number; notTraced: number; openCriticalHigh: number;
    bySeverity: Record<SecuritySeverity, number>; byStatus: Record<SecurityStatus, number>;
  };
  findings: ReportFinding[];
  refuted: ReportRefuted[];
  couldntVerify: Array<{ ref: string; kind: string; what: string }>;
  notTraced: Array<{ repo: string; reason: string }>;
  diff: { basis: "computed" | "declared" } & Record<SecurityStatus, string[]>;
  files: string[];
}

let reportValidators: { data: ValidateFunction; file: ValidateFunction } | null = null;

/** `schema/security-report-data.v1.json` and `schema/security-report.v1.json`, compiled once. */
export function securityReportSchemas(): { data: ValidateFunction; file: ValidateFunction } {
  if (!reportValidators) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
    const load = (name: string): object => JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")) as object;
    reportValidators = { data: ajv.compile(load("security-report-data.v1.json")), file: ajv.compile(load("security-report.v1.json")) };
  }
  return reportValidators;
}

function reportSchemaMessage(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
  if (e.keyword === "false schema") return `${where} is not allowed on this kind of report file (a summary carries \`links\`; a technical file \`repo\`, \`covers\` and \`suggestedTasks\`)`;
  const extra =
    e.keyword === "additionalProperties" ? ` \`${clean((e.params as { additionalProperty: string }).additionalProperty)}\``
    : e.keyword === "enum" ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`
    : e.keyword === "const" ? `: \`${clean((e.params as { allowedValue: unknown }).allowedValue)}\``
    : "";
  return `${where} ${e.message ?? e.keyword}${extra}`;
}

/** The schema's errors worth saying: an `if` failure only repeats its `then`'s, and a `oneOf`/`anyOf` its branches'. */
function reportSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return [...new Set((errors ?? []).filter((e) => e.keyword !== "if").map(reportSchemaMessage))];
}

/** `owner/name` → `owner-name`, lowercase, every run of `[^a-z0-9]` one `-` (§4.1). */
export const securityReportRepoSlugOf = (repo: string): string => repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const technicalFileOf = (repo: string): string => `technical-${securityReportRepoSlugOf(repo)}.md`;

/** A deep copy whose object keys are in code-unit order; arrays keep their order. */
function sortedKeys<T>(x: T): T {
  if (Array.isArray(x)) return x.map(sortedKeys) as T;
  if (x !== null && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as object).sort()) out[k] = sortedKeys((x as Record<string, unknown>)[k]);
    return out as T;
  }
  return x;
}

/** The data file's canonical bytes, as Studio writes them: sorted keys, two-space indent, a final newline. */
export function securityReportDataJsonOf(data: unknown): string {
  return `${JSON.stringify(sortedKeys(data), null, 2)}\n`;
}

/**
 * The data file's errors beyond its schema, [] when it holds together: `refs` starting with `ref`,
 * every repository a reviewed one with its own slug, every technical file covering a row, and the
 * arithmetic between `counts` and the lists (Studio's `securityReportDataErrors`).
 */
function reportDataArithmetic(x: ReportData): string[] {
  const errors: string[] = [];
  const reviewed = x.repos.map((r) => r.repo);
  x.repos.forEach((r, i) => {
    if (r.slug !== securityReportRepoSlugOf(r.repo)) errors.push(`repos[${i}].slug: must be \`${securityReportRepoSlugOf(r.repo)}\``);
  });
  const files = new Set(x.files);
  const covering = new Set<string>();
  const fileOf = (f: string, at: string): void => {
    covering.add(f);
    if (!files.has(f)) errors.push(`${at}: \`${f}\` is not in \`files\``);
  };
  x.findings.forEach((f, i) => {
    if (f.refs[0] !== f.ref) errors.push(`findings[${i}].refs: must start with \`ref\``);
    f.repos.forEach((r, j) => {
      if (!reviewed.includes(r)) errors.push(`findings[${i}].repos[${j}]: \`${clean(r)}\` is not a reviewed repository`);
    });
    fileOf(f.file, `findings[${i}].file`);
  });
  x.refuted.forEach((r, i) => fileOf(r.file, `refuted[${i}].file`));
  for (const f of files) if (f !== SECURITY_REPORT_SUMMARY_FILE && !covering.has(f)) errors.push(`files: \`${f}\` covers no finding or refuted row`);
  const c = x.counts;
  const notReverified = x.findings.filter((f) => f.verification === "not_reverified").length;
  const eq = (k: keyof ReportData["counts"], want: number): void => {
    if (c[k] !== want) errors.push(`counts.${k}: ${String(c[k])}, but the data holds ${want}`);
  };
  eq("findings", x.findings.length);
  eq("notReverified", notReverified);
  eq("kept", x.findings.length - notReverified);
  eq("refuted", x.refuted.length);
  eq("couldntVerify", x.couldntVerify.length);
  eq("notTraced", x.notTraced.length);
  for (const st of SECURITY_STATUSES) {
    if (c.byStatus[st] !== x.diff[st].length) errors.push(`counts.byStatus.${st}: ${c.byStatus[st]}, but diff.${st} lists ${x.diff[st].length}`);
  }
  const sevSum = SECURITY_SEVERITIES.reduce((n, s) => n + c.bySeverity[s], 0);
  const statusSum = SECURITY_STATUSES.reduce((n, s) => n + c.byStatus[s], 0);
  if (sevSum !== statusSum) errors.push(`counts: bySeverity sums to ${sevSum} and byStatus to ${statusSum}`);
  if (c.openCriticalHigh > c.bySeverity.critical + c.bySeverity.high) errors.push("counts.openCriticalHigh: more than the critical and high findings");
  return errors;
}

// ── Copy (§10), the counts table and the badge: the same renderings as Studio's ──

const REPORT_COPY = {
  en: {
    glance: "At a glance",
    count: "Count",
    findings: "Findings",
    severities: { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as Record<SecuritySeverity, string>,
    openCriticalHigh: "Open critical and high",
    notReverified: "Not re-verified",
    refuted: "Refuted",
    couldntVerify: "Couldn't verify",
    notTraced: "Not traced",
    statusWord: "Status",
    statuses: { new: "New", still_open: "Still open", fixed: "Fixed", regressed: "Regressed" } as Record<SecurityStatus, string>,
    kept: "kept",
    repositoryNotes: "Repository notes",
  },
  "es-MX": {
    glance: "En resumen",
    count: "Cantidad",
    findings: "Hallazgos",
    severities: { critical: "Crítica", high: "Alta", medium: "Media", low: "Baja" } as Record<SecuritySeverity, string>,
    openCriticalHigh: "Críticos y altos abiertos",
    notReverified: "Sin volver a verificar",
    refuted: "Descartados",
    couldntVerify: "No pudimos verificar",
    notTraced: "No rastreado",
    statusWord: "Estado",
    statuses: { new: "Nuevo", still_open: "Sigue abierto", fixed: "Corregido", regressed: "Reapareció" } as Record<SecurityStatus, string>,
    kept: "mantenido",
    repositoryNotes: "Notas de los repositorios",
  },
} as const;

/**
 * §2.1's At a glance table in the data file's language — Studio's `securityReportCountsTableOf`,
 * the one rendering the summary copies verbatim and K20 compares byte for byte. No trailing newline.
 */
export function securityReportCountsTableOf(data: Pick<ReportData, "review" | "counts">): string {
  const c = REPORT_COPY[data.review.lang] ?? REPORT_COPY.en;
  const n = data.counts;
  const rows: Array<[string, number]> = [
    [c.findings, n.findings],
    ...SECURITY_SEVERITIES.map((s): [string, number] => [c.severities[s], n.bySeverity[s]]),
    [c.openCriticalHigh, n.openCriticalHigh],
    [c.notReverified, n.notReverified],
    [c.refuted, n.refuted],
    [c.couldntVerify, n.couldntVerify],
    [c.notTraced, n.notTraced],
  ];
  return [`| ${c.glance} | ${c.count} |`, "|---|---:|", ...rows.map(([label, v]) => `| ${label} | ${v} |`)].join("\n");
}

/** §10's status badge of a finding section (K22): `Status: <status> · <kept / Not re-verified>`. */
export function securityReportBadgeOf(f: Pick<ReportFinding, "status" | "verification">, lang: SecurityReportLang): string {
  const c = REPORT_COPY[lang] ?? REPORT_COPY.en;
  return `${c.statusWord}: ${c.statuses[f.status]} · ${f.verification === "not_reverified" ? c.notReverified : c.kept}`;
}

/** The `TASK-<n>#<question id>` refs a text names, in order, each once (Studio's `refsNamedIn`). */
const REPORT_REF_RE = /TASK-\d+#[A-Za-z0-9][A-Za-z0-9._-]*/g;
export const refsNamedIn = (text: string): string[] => [...new Set((text.match(REPORT_REF_RE) ?? []).map((m) => m.replace(/[._-]+$/, "")))];

// K20's count nouns (§10), each with the counts a numeral beside it may state. A severity noun reads
// that severity's table count or its open count (the data file's `findings` with that severity): the
// table counts diff entries, a re-run's fixed and absent ones included, so "1 critical finding is
// open" is true when one critical is open and another was fixed.
type CountKey = "findings" | "kept" | "notReverified" | SecuritySeverity | `open:${SecuritySeverity}` | "refuted" | "open" | "openCriticalHigh" | "repositories";
type NounKind = "severity" | "open" | "refuted" | "findings" | "repositories";
const sevNoun = (s: SecuritySeverity, words: string): [RegExp, readonly CountKey[], NounKind] => [new RegExp(`^(${s}(-severity)?|${words})$`), [s, `open:${s}`], "severity"];
const COUNT_NOUNS: ReadonlyArray<[RegExp, readonly CountKey[], NounKind]> = [
  [/^(findings?|hallazgos?)$/, ["findings", "kept", "notReverified"], "findings"],
  sevNoun("critical", "cr[ií]tic[oa]s?"),
  sevNoun("high", "alt[oa]s?"),
  sevNoun("medium", "medi[oa]s?"),
  sevNoun("low", "baj[oa]s?"),
  [/^(refuted|descartad[oa]s?)$/, ["refuted"], "refuted"],
  [/^(open|abiert[oa]s?)$/, ["open", "openCriticalHigh"], "open"],
  [/^(repositor(y|ies)|repositorios?)$/, ["repositories"], "repositories"],
];
// In a count-noun phrase ("open critical findings", "hallazgos críticos"), the qualifier decides.
const NOUN_PRECEDENCE: readonly NounKind[] = ["severity", "open", "refuted", "findings", "repositories"];
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.fromEntries([
  ..."zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ").map((w, i) => [w, i]),
  ..."cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte".split(" ").map((w, i) => [w, i]),
]);
const K20_WINDOW = 4;
const stripToken = (t: string): string => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * K20 on one prose line. A numeral within four words of a count noun, in the same clause (`,` `;`
 * `:` `.` `!` `?` `(` `)` and dashes end one), is read against the NEAREST such noun (the following
 * one on a tie) and the count nouns right next to it on the same side (its phrase); the phrase's
 * qualifier decides — a severity, then open, then refuted, then the noun itself — in either word
 * order: "two critical findings" and "dos hallazgos críticos" read critical, "5 findings across 2
 * repositories" reads findings, then repositories. A clause naming both critical and high also
 * admits the open critical and high count. "one of the …", "2 de los …" is a part, which says less.
 */
function k20Line(line: string, counts: Record<CountKey, number>): string | null {
  const raw = line.split(/\s+/).filter(Boolean);
  const words = raw.map(stripToken);
  const clause: number[] = [];
  let c = 0;
  raw.forEach((t, i) => {
    if (/^[(—–-]/.test(t) || /^[—–-]+$/.test(t)) c += 1;
    clause[i] = c;
    if (/[,;:.!?)—–]$/.test(t)) c += 1;
  });
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
    if (n === undefined) continue;
    if (words[i + 1] === "of" || words[i + 1] === "de") continue;
    const nounAt = (j: number): (typeof COUNT_NOUNS)[number] | undefined =>
      j >= 0 && j < words.length && j !== i && clause[j] === clause[i] ? COUNT_NOUNS.find(([re]) => re.test(words[j] as string)) : undefined;
    let best: { d: number; j: number } | null = null;
    const inWindow = new Set<CountKey>();
    for (let j = Math.max(0, i - K20_WINDOW); j <= Math.min(words.length - 1, i + K20_WINDOW); j += 1) {
      const hit = nounAt(j);
      if (!hit) continue;
      hit[1].forEach((k) => inWindow.add(k));
      const d = Math.abs(j - i);
      if (!best || d < best.d || (d === best.d && j > i)) best = { d, j };
    }
    if (!best) continue;
    const nearest = best;
    // The phrase: the count nouns adjacent to the nearest one, never across the numeral.
    const phrase = [nounAt(nearest.j) as (typeof COUNT_NOUNS)[number]];
    for (const step of [-1, 1]) {
      for (let j = nearest.j + step; (j - i) * (nearest.j - i) > 0; j += step) {
        const hit = nounAt(j);
        if (!hit) break;
        phrase.push(hit);
      }
    }
    const head = NOUN_PRECEDENCE.map((kind) => phrase.find((p) => p[2] === kind)).find((p) => p !== undefined) as (typeof COUNT_NOUNS)[number];
    const read: CountKey[] = [...head[1], ...(inWindow.has("critical") && inWindow.has("high") ? (["openCriticalHigh"] as const) : [])];
    if (!read.some((k) => counts[k] === n)) return `"${clean(w)}" beside ${read.join(" / ")} is not the data file's count (${read.map((k) => `${k} ${counts[k]}`).join(", ")})`;
  }
  return null;
}

const NOTES_HEADING = new RegExp(`^#{1,6}\\s+(${REPORT_COPY.en.repositoryNotes}|${REPORT_COPY["es-MX"].repositoryNotes})\\s*$`, "i");
const NOT_REVERIFIED_WORDS = /not re-verified|sin volver a verificar/gi;
const UPGRADE_WORDS = /(?<![\p{L}-])(kept|confirmed|verified|confirmad[oa]s?|verificad[oa]s?|mantenid[oa]s?)(?![\p{L}-])/iu;
const OPEN_WORDS = /(?<![\p{L}-])(open|still open|abiert[oa]s?|sigue abiert[oa])(?![\p{L}-])/iu;
const CODE_FENCE = /^\s*(```|~~~)/;
// `<file>.<ext>:<line>`: a path before it adds nothing to whether a line holds a cite, and leaving it
// (and a lookbehind) out keeps the match linear, even on a 160k-character `a.a.a.` line.
const PATH_LINE_CITE = /\w\.[A-Za-z0-9]+:\d+/;
const CODE_REPO_LINK = /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//i;
const EXPOSURE_HEADING = /^#{1,6}\s+(scenario|fix|escenario|correcci[oó]n)\s*$/i;
const SECURITY_BLOCK = /^\s*security\s*:/;
const PUBLIC_ACK = /Alissa-Public-Ack/i;
// K5's token shapes (Studio's REPO_TOKEN_SHAPE_SOURCES, inlined above), plus a password assignment.
const CREDENTIAL = new RegExp([...KB_TOKEN_SHAPE_SOURCES, "(?:password|passwd|contraseña)\\s*[:=]\\s*\\S+"].map((s) => `(?:${s})`).join("|"), "i");

export interface SecurityReportLintInput {
  /** The run directory's files by bare name (`report-data.json`, `summary.md`, `technical-*.md`), their committed text. */
  files: ReadonlyMap<string, string>;
  /** `report-data.json` as its first commit holds it; absent when this is that commit. */
  firstData?: string | null;
  /** The run directory's `<yyyy-mm-dd>` and `<reviewId>`, when its name is well formed (K1). */
  day?: string | null;
  reviewId?: string | null;
}

/** K19's frontmatter check of one report file: the parsed frontmatter, or null when it fails. */
function reportFrontmatterOf(name: string, text: string, data: ReportData, dataSha: string, k19: (m: string) => void): Record<string, unknown> | null {
  let failed = false;
  const fail = (m: string): void => {
    failed = true;
    k19(m);
  };
  const split = splitFrontmatter(text);
  if (!split.ok) {
    fail(`the file ${split.error}`);
    return null;
  }
  const parsed = parseFrontmatter(split.frontmatter);
  if (!parsed.ok) {
    fail(parsed.error);
    return null;
  }
  const fm = parsed.value;
  const validate = securityReportSchemas().file;
  if (!validate(fm)) {
    for (const m of reportSchemaErrors(validate.errors)) fail(`frontmatter ${m} (schema/security-report.v1.json)`);
    return null;
  }
  const doc = fm as Record<string, unknown>;
  const summary = name === SECURITY_REPORT_SUMMARY_FILE;
  if (doc.kind !== (summary ? "summary" : "technical")) fail(`\`kind\` is \`${clean(doc.kind)}\`, must be \`${summary ? "summary" : "technical"}\` for \`${name}\``);
  if (doc.review !== data.review.id) fail(`\`review\` is \`${clean(doc.review)}\`, must be the data file's \`${data.review.id}\``);
  if (doc.lang !== data.review.lang) fail(`\`lang\` is \`${clean(doc.lang)}\`, must be the data file's \`${data.review.lang}\``);
  if (doc.dataSha256 !== dataSha) fail(`\`dataSha256\` is not the sha256 of the committed report-data.json (${dataSha})`);
  if (!summary) {
    const repo = name === SECURITY_REPORT_CHAINS_FILE ? "chains" : data.repos.find((r) => technicalFileOf(r.repo) === name)?.repo;
    if (repo === undefined) fail(`no reviewed repository's slug names \`${name}\``);
    else if (doc.repo !== repo) fail(`\`repo\` is \`${clean(doc.repo)}\`, must be \`${repo}\``);
    const covers = new Set((doc.covers as string[]).map(String));
    ((doc.suggestedTasks ?? []) as Array<Record<string, unknown>>).forEach((s, i) => {
      if (!refsNamedIn(`${String(s.title)} ${String(s.why)}`).some((r) => covers.has(r))) fail(`suggested task ${i + 1} names no ref this file covers`);
    });
  }
  return failed ? null : doc;
}

/**
 * K19–K23 over a run directory's files (§4.3). Files are checked in name order; a data file that is
 * missing, not JSON or not well formed stops the lint at K19 (the other rules read it).
 *
 * K20's prose numerals are read in `summary.md` only, outside its tables and frontmatter: technical
 * sections quote scenarios, where a numeral beside "high" is not a count claim.
 */
export function securityReportLint(input: SecurityReportLintInput): KbFailure[] {
  const out: KbFailure[] = [];
  const push = (rule: KRule, file: string, message: string): void => void out.push({ rule, file, message });
  const raw = input.files.get(SECURITY_REPORT_DATA_FILE);
  if (raw === undefined) {
    push("K19", SECURITY_REPORT_DATA_FILE, `the run directory has no ${SECURITY_REPORT_DATA_FILE}`);
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    push("K19", SECURITY_REPORT_DATA_FILE, `not JSON: ${clean((e as Error).message)}`);
    return out;
  }
  const validate = securityReportSchemas().data;
  const shape = validate(parsed) ? reportDataArithmetic(parsed as ReportData) : reportSchemaErrors(validate.errors).map((m) => `${m} (schema/security-report-data.v1.json)`);
  for (const m of shape) push("K19", SECURITY_REPORT_DATA_FILE, m);
  if (shape.length > 0) return out;
  const data = parsed as ReportData;
  if (securityReportDataJsonOf(data) !== raw) push("K19", SECURITY_REPORT_DATA_FILE, "not in canonical form (sorted keys, two-space indent, final newline) — Studio writes it, nobody edits it");
  if (input.firstData != null && input.firstData !== raw) push("K19", SECURITY_REPORT_DATA_FILE, "changed after its first commit — the data file is Studio's, committed once");
  if (input.day != null && input.reviewId != null && (input.day !== data.review.day || input.reviewId !== data.review.id)) {
    push("K19", SECURITY_REPORT_DATA_FILE, `the run directory is \`${input.day}-${input.reviewId}\`, but the data file's review is \`${data.review.day}-${data.review.id}\` (§4.1)`);
  }
  const dataSha = createHash("sha256").update(raw, "utf8").digest("hex");

  const known = new Set<string>([
    ...data.findings.flatMap((f) => [f.ref, ...f.refs]),
    ...data.refuted.flatMap((r) => [r.ref, r.finding]),
    ...data.couldntVerify.map((c) => c.ref),
    ...SECURITY_STATUSES.flatMap((st) => data.diff[st]),
  ]);
  const notReverified = new Set(data.findings.filter((f) => f.verification === "not_reverified").flatMap((f) => [f.ref, ...f.refs]));
  const titlesByRef = new Map<string, string[]>();
  for (const [refs, title] of [...data.findings.map((f): [string[], string] => [[f.ref, ...f.refs], f.title]), ...data.refuted.map((r): [string[], string] => [[r.ref, r.finding], r.title])]) {
    for (const r of refs) titlesByRef.set(r, [...(titlesByRef.get(r) ?? []), title]);
  }
  const refutedRefs = new Set(data.refuted.flatMap((r) => [r.ref, r.finding]));
  const technicalFiles = data.files.filter((f) => f !== SECURITY_REPORT_SUMMARY_FILE);
  const counts = {
    findings: data.counts.findings,
    kept: data.counts.kept,
    notReverified: data.counts.notReverified,
    ...data.counts.bySeverity,
    ...(Object.fromEntries(SECURITY_SEVERITIES.map((s) => [`open:${s}`, data.findings.filter((f) => f.severity === s).length])) as Record<`open:${SecuritySeverity}`, number>),
    refuted: data.counts.refuted,
    open: data.counts.byStatus.new + data.counts.byStatus.still_open + data.counts.byStatus.regressed,
    openCriticalHigh: data.counts.openCriticalHigh,
    repositories: data.repos.length,
  } satisfies Record<CountKey, number>;

  for (const name of [...input.files.keys()].sort()) {
    if (name === SECURITY_REPORT_DATA_FILE) continue;
    const text = input.files.get(name) as string;
    const summary = name === SECURITY_REPORT_SUMMARY_FILE;
    if (!(summary || SECURITY_REPORT_TECHNICAL_RE.test(name))) {
      push("K19", name, "not a report file name (report-data.json, summary.md, technical-<repo-slug>.md, technical-chains.md)");
      continue;
    }
    if (!data.files.includes(name)) {
      push("K19", name, "not in the data file's `files`");
      continue;
    }
    const fm = reportFrontmatterOf(name, text, data, dataSha, (m) => push("K19", name, m));
    const split = splitFrontmatter(text);
    const body = split.ok ? split.body : text;
    const lines = body.split("\n");

    // ── K23 exposure ──
    for (const line of text.split("\n")) {
      if (PUBLIC_ACK.test(line)) push("K23", name, "an `Alissa-Public-Ack` line");
      if (CREDENTIAL.test(line)) push("K23", name, "a credential-shaped string (named, never quoted)");
    }
    if (summary) {
      let fenced = false;
      for (const line of lines) {
        if (CODE_FENCE.test(line)) {
          if (!fenced) push("K23", name, "a code fence in the summary");
          fenced = true;
        }
        if (PATH_LINE_CITE.test(line)) push("K23", name, `a \`path:line\` cite in the summary: ${clean(line.trim())}`);
        if (CODE_REPO_LINK.test(line)) push("K23", name, `a link to a code repository in the summary: ${clean(line.trim())}`);
        if (EXPOSURE_HEADING.test(line)) push("K23", name, `the heading "${clean(line.trim())}" in the summary`);
        if (SECURITY_BLOCK.test(line)) push("K23", name, "a `security:` block in the summary");
      }
    }

    // ── K21 refs ──
    for (const r of refsNamedIn(text)) if (!known.has(r)) push("K21", name, `${clean(r)} is not in the data file`);
    if (fm && !summary) {
      const want = [...data.findings.filter((f) => f.file === name).map((f) => f.ref), ...data.refuted.filter((r) => r.file === name).map((r) => r.finding)];
      const got = (fm.covers as string[]).map(String);
      if (got.join("\n") !== want.join("\n")) push("K21", name, `\`covers\` is [${clean(got.join(", "))}], the data file assigns [${want.join(", ")}] in this order`);
    }
    if (fm && summary) {
      const links = (fm.links as string[]).map(String);
      if ([...links].sort().join("\n") !== [...technicalFiles].sort().join("\n")) push("K21", name, `\`links\` is [${clean(links.join(", "))}], must be every technical file [${technicalFiles.join(", ")}]`);
      for (const m of body.matchAll(/\]\(\s*<?([^)\s#>]+)/g)) {
        const target = m[1] as string;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (!links.includes(target)) push("K21", name, `links \`${clean(target)}\`, which is not in \`links\``);
      }
      // The notes are read in the Repository notes section only (§2.1 item 6).
      const head = lines.findIndex((l) => NOTES_HEADING.test(l));
      const end = head < 0 ? -1 : lines.findIndex((l, i) => i > head && /^#{1,6}\s/.test(l));
      const notesLines = head < 0 ? [] : lines.slice(head + 1, end < 0 ? lines.length : end);
      for (const r of data.repos) {
        for (const n of r.notes) {
          const ok = notesLines.some((l) => l.includes(r.repo) && (n.kind === "public" || l.includes(n.parent)));
          if (!ok) push("K21", name, `the ${n.kind} note of ${r.repo} is missing`);
        }
      }
    }

    // ── K20 numbers (summary) ──
    if (summary) {
      if (!body.includes(securityReportCountsTableOf(data))) push("K20", name, "the At a glance table is not the data file's rendering, byte for byte");
      for (const line of lines) {
        if (line.trimStart().startsWith("|")) continue;
        const why = k20Line(line, counts);
        if (why) push("K20", name, why);
      }
    }

    // ── K22 status ──
    for (const line of lines) {
      const named = refsNamedIn(line);
      if (named.some((r) => notReverified.has(r))) {
        const stripped = line.replace(NOT_REVERIFIED_WORDS, "");
        if (summary && stripped === line) push("K22", name, `a Not re-verified ref without the Not re-verified words: ${clean(line.trim())}`);
        // The titles of the rows the line names are Studio's (§2.2 headings carry them): a title's own words upgrade nothing.
        const titles = [...new Set(named.flatMap((r) => titlesByRef.get(r) ?? []))].sort((x, y) => y.length - x.length);
        const untitled = titles.reduce((l, t) => l.split(t).join(" "), stripped);
        if (UPGRADE_WORDS.test(untitled)) push("K22", name, `a Not re-verified ref called kept or verified: ${clean(line.trim())}`);
      }
      if (named.some((r) => refutedRefs.has(r)) && !named.some((r) => notReverified.has(r) || data.findings.some((f) => f.ref === r)) && OPEN_WORDS.test(line)) {
        push("K22", name, `a refuted ref listed as open: ${clean(line.trim())}`);
      }
    }
    if (!summary) {
      for (const f of data.findings.filter((x) => x.file === name)) {
        const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && refsNamedIn(l).includes(f.ref));
        if (at < 0) {
          push("K22", name, `no section heading names ${f.ref}`);
          continue;
        }
        const badge = lines.slice(at + 1).find((l) => l.trim() !== "")?.trim();
        const want = securityReportBadgeOf(f, data.review.lang);
        if (badge !== want) push("K22", name, `${f.ref}'s badge line is "${clean(badge ?? "")}", the data file says "${want}"`);
      }
    }
  }
  return out;
}

/**
 * A Report plan's data file (alissa-code-security-reports §4.1): the one `report-data.json` a plan PR
 * may add beside its plan, linted with K19's data-file checks — the schema, its arithmetic, canonical
 * form, the run directory's name against its review and day, and never changed after its first
 * commit — in the same run as the plan's rules. K1 here is the file's own layout (its run directory's
 * name, a regular file); the plan PR's other paths are rule 1's. No report file rides with it, so
 * K20–K23 have nothing to read; the Report tasks' later PRs run the whole of K1, K19–K23.
 */
export function lintReportData(src: KbSource): KbLintResult {
  const failures: KbFailure[] = src.layout.map((message) => ({ rule: "K1" as KRule, message }));
  const data = src.files.get(SECURITY_REPORT_DATA_FILE);
  if (src.sizes.has(SECURITY_REPORT_DATA_FILE) || src.layout.length === 0) {
    const only = data === undefined ? new Map<string, string>() : new Map([[SECURITY_REPORT_DATA_FILE, data]]);
    for (const f of securityReportLint({ files: only, firstData: src.firstData ?? null, day: src.day, reviewId: src.reviewId ?? null })) failures.push(f);
  }
  const notes = [...src.notes, "a Report plan's data file: K19's data-file checks; the report files come from the Report tasks' pull requests (K1, K19–K23)"];
  return { target: src.label, kind: "security-report", questionCount: 0, failures: sortKb(failures), rulesRun: ["K1", "K19"], notes, review: null };
}

// ── The integration-check mode: I1–I9 (design alissa-build-integration-check §3.5) ───────────────
// A pull request that changes any `integration-check/**` file is linted under these rules, numbered
// apart from §5.5's and the K rules. I1, I2 and I4–I8 need no network; I3 reads the milestone's
// criteria and I9 the task, both with the lint token. Every rule runs; the verdict is the first
// failure. Alissa unavailable is "plan-lint could not run" — a failure, never a pass.

export type IRule = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8" | "I9";

export const I_RULE_NAMES: Readonly<Record<IRule, string>> = {
  I1: "layout and immutability",
  I2: "frontmatter",
  I3: "every criterion has a verdict",
  I4: "every verdict cites evidence that exists",
  I5: "every unverified item is honest",
  I6: "the status follows the rules",
  I7: "size and types",
  I8: "hygiene",
  I9: "task",
};

/** I7's caps (§3.5). */
export const IC_LIMITS = {
  reportBytes: 48 * 1024,
  evidenceFilesMax: 60,
  evidenceBytesMax: 25 * 1024 * 1024,
  evidenceFileBytes: 2 * 1024 * 1024,
} as const;

/** I7: the evidence types a run may hold. */
export const IC_EVIDENCE_TYPES = ["png", "jpg", "webp", "log", "txt", "json", "yml"] as const;

/** §5.2: a variable name — what a `notes` entry is, and all it is (I8). */
export const NOTE_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const COULDNT_VERIFY_HEADING = "Couldn't verify";

export type Verdict = "pass" | "fail" | "unverified" | "skipped";
export type IntegrationStatus = "SUCCESS" | "UNCERTAIN" | "FAILED";
export interface IcFailureDetail {
  what: string;
  suggestedFix: string;
  paths: string[];
}

/** §3.4's frontmatter, as far as the rules read it (the schema holds the whole shape). */
export interface IntegrationReport {
  schema: "alissa-integration-check/v1";
  task: string;
  check: string;
  project: string;
  milestone: { id: string; n: number; title: string };
  run: number;
  previous: string | null;
  notes: string[];
  reads: Array<{ repo: string; sha: string }>;
  recipe: Array<{ repo: string; state: "confirmed" | "draft" | "none"; path: string }>;
  status: IntegrationStatus;
  couldntVerify: Array<{ id: string; kind: string; what: string; why?: string; howToCheck?: string; criterion?: string }>;
  steps: Array<{ id: "build" | "tests" | "start" | "routes" | "screens" | "contracts"; verdict: Verdict; evidence: string[]; detail: string }>;
  criteria: Array<{ id: string; verdict: Verdict; evidence: string[]; detail: string; failure?: IcFailureDetail; unverified?: string }>;
  neighbours: Array<{ id: string; kind: "route" | "screen"; target: string; verdict: Verdict; evidence: string[]; detail: string; failure?: IcFailureDetail }>;
  scope: { prs: string[]; paths: string[]; oneHop: string[]; contracts: string[]; cut: string[] };
}

/**
 * §4.1's rules, verbatim. Studio's `convex/core/integrationReport.ts` (IC-2) is the one place they
 * live; this is I6's mirror of it, and `lint/test/ic.test.ts` pins the two together.
 */
export function statusOf(r: IntegrationReport): "SUCCESS" | "UNCERTAIN" | "FAILED" {
  const verdicts = [...r.steps, ...r.criteria, ...r.neighbours].map((x) => x.verdict);
  if (verdicts.includes("fail")) return "FAILED";
  const started = r.steps.find((s) => s.id === "start")?.verdict === "pass";
  if (!started || r.criteria.some((c) => c.verdict !== "pass")) return "UNCERTAIN";
  return "SUCCESS";
}

export interface IcFailure {
  rule: IRule;
  file?: string;
  message: string;
  /** The check could not be made (Alissa unavailable): reported as "plan-lint could not run". */
  couldNotRun?: boolean;
}

export interface IcLintResult {
  target: string;
  /** The report's declared status, when its frontmatter validates. */
  status: IntegrationStatus | null;
  criteriaCount: number;
  failures: IcFailure[];
  rulesRun: IRule[];
  notes: string[];
}

/** `reader` reads the milestone (I3) and the task (I9); `prTask` is the PR's own `TASK-<n>` (I2). */
export type IcLintOptions = { online: false; prTask?: string | null } | { online: true; reader: AlissaReader; prTask?: string | null };

let reportValidator: ValidateFunction | null = null;

export function integrationCheckSchema(): ValidateFunction {
  if (!reportValidator) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
    reportValidator = ajv.compile(JSON.parse(readFileSync(new URL("../schema/integration-check.v1.json", import.meta.url), "utf8")) as object);
  }
  return reportValidator;
}

type IcFail = (rule: IRule, message: string, file?: string, couldNotRun?: boolean) => void;

const OFFLINE_I_RULES: IRule[] = ["I1", "I2", "I4", "I5", "I6", "I7", "I8"];
const ALL_I_RULES: IRule[] = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"];

export async function lintIc(src: IcSource, opts: IcLintOptions): Promise<IcLintResult> {
  const failures: IcFailure[] = [];
  const notes = [...src.notes];
  const fail: IcFail = (rule, message, file, couldNotRun = false) => {
    failures.push({ rule, message, ...(file === undefined ? {} : { file }), ...(couldNotRun ? { couldNotRun } : {}) });
  };
  let fm: IntegrationReport | null = null;
  const result = (rulesRun: IRule[]): IcLintResult => ({
    target: src.label, status: fm?.status ?? null, criteriaCount: fm?.criteria.length ?? 0, failures: sortIc(failures), rulesRun, notes,
  });

  // I1 — layout and immutability (found by the reader).
  for (const m of src.layout) fail("I1", m);

  // I7 — size and types, over every file the run holds.
  const reportBytes = src.sizes.get(REPORT_FILE);
  if (reportBytes !== undefined && reportBytes > IC_LIMITS.reportBytes) fail("I7", `report.md is ${reportBytes} bytes; the limit is ${IC_LIMITS.reportBytes} (§3.5)`, REPORT_FILE);
  const evidence = [...src.sizes.entries()].filter(([rel]) => rel.startsWith(`${EVIDENCE_DIR}/`));
  if (evidence.length > IC_LIMITS.evidenceFilesMax) fail("I7", `the run holds ${evidence.length} evidence files; at most ${IC_LIMITS.evidenceFilesMax} (§3.5)`);
  const total = evidence.reduce((n, [, size]) => n + size, 0);
  if (total > IC_LIMITS.evidenceBytesMax) fail("I7", `the evidence is ${total} bytes in all; at most ${IC_LIMITS.evidenceBytesMax} (§3.5)`);
  for (const [rel, size] of evidence) {
    if (size > IC_LIMITS.evidenceFileBytes) fail("I7", `is ${size} bytes; an evidence file is at most ${IC_LIMITS.evidenceFileBytes} (§3.5)`, rel);
    const ext = /\.([^./]+)$/.exec(rel)?.[1];
    if (ext === undefined || !(IC_EVIDENCE_TYPES as readonly string[]).includes(ext)) {
      fail("I7", `is ${ext === undefined ? "a file with no type" : `a \`.${clean(ext)}\` file`} — evidence is ${IC_EVIDENCE_TYPES.join(", ")} only (§3.5)`, rel);
    }
  }

  // I8 — hygiene, part one: no secret-shaped text in the report or a text evidence file.
  for (const [rel, text] of src.files) {
    const lines = secretShapedLines(text);
    if (lines.length > 0) fail("I8", `secret-shaped text on line(s) ${lines.join(", ")} — K5's token shapes (§9)`, rel);
  }

  const text = src.files.get(REPORT_FILE);
  if (text === undefined) {
    notes.push("I2–I6 and I9 not run: no readable report.md");
    return result(["I1", "I7", "I8"]);
  }

  // I2 — frontmatter.
  let body: string | null = null;
  let i2 = 0;
  const i2fail = (m: string): void => {
    fail("I2", m, REPORT_FILE);
    i2++;
  };
  const split = splitFrontmatter(text);
  if (!split.ok) i2fail(`report.md ${split.error}`);
  else {
    body = split.body;
    const parsed = parseFrontmatter(split.frontmatter);
    if (!parsed.ok) i2fail(parsed.error);
    else {
      const validate = integrationCheckSchema();
      if (!validate(parsed.value)) {
        for (const e of validate.errors ?? []) {
          if (e.keyword === "type" && /\/sha$/.test(e.instancePath)) i2fail(`frontmatter ${ajvMessage(e)} — YAML reads an all-digit value as a number; quote it`);
          else i2fail(`frontmatter ${ajvMessage(e)}`);
        }
      }
      if (i2 === 0) fm = parsed.value as IntegrationReport;
    }
  }
  if (fm) {
    const r = fm;
    const task = opts.prTask ?? null;
    if (task === null) notes.push("I2: the report's `task` not checked against the branch's (no `TASK-<n>-…` branch or --task)");
    else if (r.task !== task) i2fail(`\`task\` is \`${clean(r.task)}\` but the pull request's branch is \`${task}\``);
    if (src.milestoneN !== null && r.milestone.n !== src.milestoneN) i2fail(`\`milestone.n\` is ${r.milestone.n} but the directory names \`m${src.milestoneN}\``);
    const repeated = (what: string, ids: string[]): void => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) i2fail(`${what} \`${clean(id)}\` appears twice`);
        seen.add(id);
      }
    };
    repeated("`reads` repository", r.reads.map((x) => x.repo.toLowerCase()));
    repeated("`recipe` repository", r.recipe.map((x) => x.repo.toLowerCase()));
    repeated("Couldn't verify id", r.couldntVerify.map((x) => x.id));
    repeated("step id", r.steps.map((x) => x.id));
    repeated("criterion id", r.criteria.map((x) => x.id));
    repeated("neighbour id", r.neighbours.map((x) => x.id));
    if (i2 > 0) fm = null;
  }

  // I8 — hygiene, part two: `notes` keeps variable names only (§5.2).
  if (fm) {
    for (const [i, n] of fm.notes.entries()) {
      if (!NOTE_NAME_RE.test(n)) fail("I8", `\`notes[${i}]\` is not a variable name (\`^[A-Z][A-Z0-9_]{1,63}$\`) — notes name variables, never values (§5.2)`, REPORT_FILE);
    }
  }

  if (fm) {
    icEvidence(fm, src, fail);
    icUnverified(fm, body ?? "", fail);
    icStatus(fm, fail);
  } else notes.push("I3–I6 and I9 not evaluated: the frontmatter is not valid (I2)");

  if (!opts.online) {
    notes.push("I3 and I9 not run (offline)");
    return result(OFFLINE_I_RULES);
  }
  if (fm) {
    await icCriteria(fm, opts.reader, fail);
    await icTask(fm, opts.reader, fail);
  }
  return result(ALL_I_RULES);
}

/** Everything that carries a verdict: a step, a criterion, a neighbour. */
function verdicts(r: IntegrationReport): Array<{ where: string; verdict: Verdict; evidence: string[] }> {
  return [
    ...r.steps.map((s) => ({ where: `step \`${s.id}\``, verdict: s.verdict, evidence: s.evidence })),
    ...r.criteria.map((c) => ({ where: `criterion \`${clean(c.id)}\``, verdict: c.verdict, evidence: c.evidence })),
    ...r.neighbours.map((n) => ({ where: `neighbour \`${clean(n.id)}\``, verdict: n.verdict, evidence: n.evidence })),
  ];
}

/** I4: a `pass` or `fail` cites evidence; every cite is a file under the run's `evidence/`; every evidence file is cited. */
function icEvidence(r: IntegrationReport, src: IcSource, fail: IcFail): void {
  const files = new Set([...src.sizes.keys()].filter((rel) => rel.startsWith(`${EVIDENCE_DIR}/`)));
  const cited = new Set<string>();
  const check = (where: string, path: string): void => {
    cited.add(path);
    if (!path.startsWith(`${EVIDENCE_DIR}/`)) fail("I4", `${where} cites \`${clean(path)}\`, which is not under the run's \`${EVIDENCE_DIR}/\``, REPORT_FILE);
    else if (!files.has(path)) fail("I4", `${where} cites \`${clean(path)}\`, which is not a file of the run`, REPORT_FILE);
  };
  for (const v of verdicts(r)) {
    if ((v.verdict === "pass" || v.verdict === "fail") && v.evidence.length === 0) fail("I4", `${v.where} is \`${v.verdict}\` but cites no evidence`, REPORT_FILE);
    for (const e of v.evidence) check(v.where, e);
  }
  for (const rc of r.recipe) {
    if (rc.state === "draft") check(`the draft recipe of \`${clean(rc.repo)}\``, rc.path);
    else if (rc.path.startsWith(`${EVIDENCE_DIR}/`)) check(`the recipe of \`${clean(rc.repo)}\``, rc.path);
  }
  for (const f of [...files].sort()) {
    if (!cited.has(f)) fail("I4", `\`${f}\` is cited by no verdict, step, item or recipe — evidence that nothing cites does not belong in the run`, f);
  }
}

/** I5: every `unverified` has its Couldn't verify item; every item says why and how to check; the body opens with the list. */
function icUnverified(r: IntegrationReport, body: string, fail: IcFail): void {
  const items = new Map(r.couldntVerify.map((u) => [u.id, u]));
  const criteria = new Set(r.criteria.map((c) => c.id));
  for (const u of r.couldntVerify) {
    const has = (k: "why" | "howToCheck"): boolean => typeof u[k] === "string" && (u[k] as string).trim() !== "";
    if (!has("why")) fail("I5", `Couldn't verify item \`${u.id}\` gives no \`why\` — why the fleet could not check it`, REPORT_FILE);
    if (!has("howToCheck")) fail("I5", `Couldn't verify item \`${u.id}\` gives no \`howToCheck\` — how the user can check it`, REPORT_FILE);
    if (u.criterion !== undefined && !criteria.has(u.criterion)) fail("I5", `Couldn't verify item \`${u.id}\` names criterion \`${clean(u.criterion)}\`, which the report gives no verdict`, REPORT_FILE);
  }
  for (const c of r.criteria) {
    if (c.unverified !== undefined && !items.has(c.unverified)) fail("I5", `criterion \`${clean(c.id)}\` names Couldn't verify item \`${c.unverified}\`, which the report does not list`, REPORT_FILE);
    if (c.verdict !== "unverified") continue;
    const linked = (c.unverified !== undefined && items.has(c.unverified)) || r.couldntVerify.some((u) => u.criterion === c.id);
    if (!linked) fail("I5", `criterion \`${clean(c.id)}\` is \`unverified\` but no Couldn't verify item names it (its \`unverified\`, or an item's \`criterion\`)`, REPORT_FILE);
  }
  if (r.couldntVerify.length === 0) {
    for (const v of verdicts(r).filter((x) => x.verdict === "unverified" && !x.where.startsWith("criterion"))) {
      fail("I5", `${v.where} is \`unverified\` but the Couldn't verify list is empty`, REPORT_FILE);
    }
  }
  const first = level2Sections(body).sections[0];
  if (first?.title !== COULDNT_VERIFY_HEADING) {
    fail("I5", `the body's first section is ${first ? `\`## ${clean(first.title)}\`` : "missing"} — every report opens with \`## ${COULDNT_VERIFY_HEADING}\` (§4.5)`, REPORT_FILE);
  }
}

/** I6: the declared status is statusOf's, and every `fail` says what failed. */
function icStatus(r: IntegrationReport, fail: IcFail): void {
  const want = statusOf(r);
  if (r.status !== want) fail("I6", `\`status\` is \`${r.status}\` but the verdicts make it \`${want}\` (statusOf, §4.1)`, REPORT_FILE);
  for (const x of [...r.criteria.map((c) => ({ where: `criterion \`${clean(c.id)}\``, ...c })), ...r.neighbours.map((n) => ({ where: `neighbour \`${clean(n.id)}\``, ...n }))]) {
    if (x.verdict === "fail" && x.failure === undefined) fail("I6", `${x.where} is \`fail\` but carries no \`failure\` (what happened, a suggested fix, the paths)`, REPORT_FILE);
  }
}

/** I3: one verdict for each of the milestone's criteria, none for a criterion it does not have. */
async function icCriteria(r: IntegrationReport, reader: AlissaReader, fail: IcFail): Promise<void> {
  let res;
  try {
    res = await reader.get(`/v1/projects/${encodeURIComponent(r.project)}`);
  } catch (err) {
    if (err instanceof AlissaUnavailable) return fail("I3", `plan-lint could not run: could not read project \`${r.project}\`: ${err.message}`, REPORT_FILE, true);
    throw err;
  }
  if (res.status === 404) return fail("I3", `project \`${r.project}\` does not resolve (${describe(res)})`, REPORT_FILE);
  if (res.status !== 200) return fail("I3", `plan-lint could not run: could not read project \`${r.project}\`: ${describe(res)}`, REPORT_FILE, true);
  const project = (res.body as { project?: Record<string, unknown> } | null)?.project ?? {};
  const milestones = (Array.isArray(project.milestones) ? project.milestones : []).filter(isRecord);
  const m = milestones.find((x) => x._id === r.milestone.id || x.bodyOfWorkId === r.milestone.id);
  if (!m) return fail("I3", `milestone \`${r.milestone.id}\` is not a milestone of project \`${r.project}\``, REPORT_FILE);
  const want = (Array.isArray(m.validationCriteria) ? m.validationCriteria : []).filter(isRecord).map((c) => c.id).filter((id): id is string => typeof id === "string");
  const got = r.criteria.map((c) => c.id);
  for (const id of want) {
    const n = got.filter((g) => g === id).length;
    if (n === 0) fail("I3", `the milestone's criterion \`${clean(id)}\` has no verdict`, REPORT_FILE);
    else if (n > 1) fail("I3", `the milestone's criterion \`${clean(id)}\` has ${n} verdicts — exactly one each`, REPORT_FILE);
  }
  for (const id of new Set(got)) {
    if (!want.includes(id)) fail("I3", `a verdict for criterion \`${clean(id)}\`, which milestone \`${r.milestone.id}\` does not have`, REPORT_FILE);
  }
}

/** I9: the task resolves, is an integration check, and its Alissa-Reads lines are exactly `reads`. */
async function icTask(r: IntegrationReport, reader: AlissaReader, fail: IcFail): Promise<void> {
  let res;
  try {
    res = await reader.get(`/v1/tasks/${encodeURIComponent(r.task)}?view=full`);
  } catch (err) {
    if (err instanceof AlissaUnavailable) return fail("I9", `plan-lint could not run: could not read \`${r.task}\`: ${err.message}`, REPORT_FILE, true);
    throw err;
  }
  if (res.status === 404) return fail("I9", `\`${r.task}\` does not resolve (${describe(res)})`, REPORT_FILE);
  if (res.status !== 200) return fail("I9", `plan-lint could not run: could not read \`${r.task}\`: ${describe(res)}`, REPORT_FILE, true);
  const t = (res.body as { task?: Record<string, unknown> } | null)?.task ?? {};
  if (t.kind !== "integration_check") fail("I9", `\`${r.task}\` is \`kind: ${clean(t.kind ?? "code")}\`, not \`integration_check\``, REPORT_FILE);
  const pinned = new Map<string, string>();
  for (const m of (typeof t.description === "string" ? t.description : "").matchAll(READS_TRAILER_RE)) pinned.set((m[1] as string).toLowerCase(), m[2] as string);
  if (pinned.size === 0) return fail("I9", `\`${r.task}\` carries no \`Alissa-Reads: <owner>/<repo>@<sha>\` line — its pinned SHAs are unknown, so I9 refuses rather than guesses`, REPORT_FILE);
  const declared = new Set<string>();
  for (const rd of r.reads) {
    declared.add(rd.repo.toLowerCase());
    const want = pinned.get(rd.repo.toLowerCase());
    if (want === undefined) fail("I9", `\`reads\` names \`${clean(rd.repo)}\`, which \`${r.task}\` does not read (its Alissa-Reads: ${[...pinned.keys()].join(", ")})`, REPORT_FILE);
    else if (want !== rd.sha) fail("I9", `\`reads\` pins \`${clean(rd.repo)}\` at \`${rd.sha}\`, but \`${r.task}\`'s Alissa-Reads pins \`${want}\``, REPORT_FILE);
  }
  for (const repo of pinned.keys()) {
    if (!declared.has(repo)) fail("I9", `\`${r.task}\`'s Alissa-Reads names \`${repo}\`, which \`reads\` leaves out`, REPORT_FILE);
  }
}

function sortIc(f: IcFailure[]): IcFailure[] {
  return f.map((x, i) => ({ x, i })).sort((a, b) => Number(a.x.rule.slice(1)) - Number(b.x.rule.slice(1)) || a.i - b.i).map(({ x }) => x);
}
