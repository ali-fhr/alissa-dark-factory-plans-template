// The twelve rules of design §5.5, and rule 5b of loop-operator-surface §2.12 (L12), evaluated in
// order over one plan. Every rule runs (so a fixture can prove it fails exactly one); the verdict is
// the first failure, with its rule named.
import { readFileSync } from "node:fs";
import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import { minimatch } from "minimatch";
import { type AlissaPoster, type AlissaReader, AlissaUnavailable, describe } from "./alissa.ts";
import { contentsPath, repoPath } from "./github.ts";
import { charLength, level2Sections, listItems, parseFrontmatter, splitFrontmatter } from "./markdown.ts";
import {
  DAG_BEGIN, DAG_END, SUMMARY_BEGIN, SUMMARY_END, isRecord, oneLine, readRegion, renderDag, renderSummary, taskView, type TaskView,
} from "./render.ts";
import { FINDINGS_FILE, type KbSource, type PlanSource, isTaskPath } from "./source.ts";

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
  if (e.keyword === "false schema") return `${where} is not allowed on this kind of task (schema v1.2: a discovery task has \`questions\` and no \`scope\` or \`new\`; a code or design task the reverse)`;
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
  const fail = (rule: RuleId, message: string, file?: string): void => {
    failures.push(file === undefined ? { rule, message } : { rule, file, message });
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
    info.view = taskView(parsed.value);
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
      for (const key of (fmOf(t).sources as string[] | undefined) ?? []) {
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

type Fail = (rule: RuleId, message: string, file?: string) => void;

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
      if (err instanceof AlissaUnavailable) fail(rule, `could not verify: ${err.message}`);
      else throw err;
    }
  };

  // Rule 10 — anchor, program, milestones.
  await guard(10, async () => {
    const program = planFm.program as string;
    const res = await reader.get(`/v1/projects/${encodeURIComponent(program)}`);
    if (res.status === 404) return fail(10, `program \`${program}\` does not resolve to a project the planner can read (${describe(res)})`, "plan.md");
    if (res.status !== 200) return fail(10, `could not read program \`${program}\`: ${describe(res)}`, "plan.md");
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
      else if (o.status !== 200) fail(10, `could not read objective \`${oid}\`: ${describe(o)}`, "plan.md");
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
      const tm = fm(t).milestone as string;
      if (!bows.has(tm)) fail(10, `milestone \`${tm}\` is not one of program \`${program}\`'s milestone bodies of work`, t.file);
      else if (anchorBow !== null && tm !== anchorBow) fail(10, `milestone \`${tm}\` is not the anchor's (\`${anchorBow}\`) — on a ${anchor.kind} anchor every task lands in it`, t.file);
    }
  });

  // Rule 11 — external edges.
  await externalEdges(tasks, reader, fail);

  // Rule 12 — repositories and off-limits.
  await guard(12, async () => {
    const list = await reader.get(`/v1/bodies-of-work?includeShared=true&limit=500`);
    if (list.status !== 200) return fail(12, `could not list the fleet's feed bodies of work: ${describe(list)}`);
    const feeds = new Set<string>();
    const bodies = (list.body as { bodiesOfWork?: unknown[] })?.bodiesOfWork;
    for (const b of Array.isArray(bodies) ? bodies : []) {
      if (!isRecord(b) || typeof b.title !== "string") continue;
      const m = /^autodev:\s*(\S+)\s*$/i.exec(b.title);
      if (m && m[1]) feeds.add(m[1].toLowerCase());
    }
    for (const t of tasks) {
      const repo = fm(t).repo as string;
      if (!feeds.has(repo.toLowerCase())) fail(12, `repo \`${repo}\` has no \`autodev: ${repo}\` feed body of work — it is not a fed repository`, t.file);
    }

    const steering = await reader.get(`/v1/factory/steering`);
    if (steering.status === 404) return fail(12, `the steering record cannot be read (${describe(steering)}) — off-limits globs are unknown, so the rule refuses rather than guesses`);
    if (steering.status !== 200) return fail(12, `could not read the steering record: ${describe(steering)}`);
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
          fail(11, `could not read external edge \`${e.task}\`: ${describe(res)}`, t.file);
          continue;
        }
        const status = (res.body as { task?: { status?: unknown } })?.task?.status;
        if (typeof status !== "string" || !LIVING_TASK.has(status)) {
          fail(11, `external edge \`${e.task}\` is \`${clean(status)}\`; it must be \`pending_validation\` or \`validated\` (§1.3)`, t.file);
        }
      } catch (err) {
        if (err instanceof AlissaUnavailable) fail(11, `could not verify \`${e.task}\`: ${err.message}`, t.file);
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

// ── The knowledge-base mode: K1–K7 (design alissa-build-discovery §3.4) ──────────────────────────
// A pull request that changes any `knowledge-base/**` file is linted under these rules, numbered
// apart from §5.5's. K1–K5 need no network; K6 reads the task with the lint token, and K7 asks
// Studio's verify route whether each cite holds at its pinned SHA. Every rule runs; the verdict is
// the first failure. K7 with the route unavailable is "plan-lint could not run" — a failure, never
// a pass.

export type KRule = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7";

export const K_RULE_NAMES: Readonly<Record<KRule, string>> = {
  K1: "layout and immutability",
  K2: "frontmatter",
  K3: "completeness",
  K4: "size",
  K5: "hygiene",
  K6: "task",
  K7: "cites resolve",
};

/** §2.3's limits. */
export const KB_LIMITS = {
  fileBytes: 32 * 1024,
  questionsMin: 1, questionsMax: 12,
  risksMax: 12, suggestedTasksMax: 8, citesMax: 24,
  lineSpanMax: 400,
  summaryChars: 1200, questionSectionChars: 6000,
} as const;

/** Studio's cite check (lane DS-3), on the lint token. */
export const VERIFY_ROUTE = "/v1/factory/repo-files/verify";

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

export interface KbLintResult {
  target: string;
  kind: "findings" | "assessment";
  questionCount: number;
  failures: KbFailure[];
  rulesRun: KRule[];
  notes: string[];
}

/**
 * `reader` reads the task (K6, and K1's design-task check for an assessment); `verifier` posts
 * K7's cites to Studio. `prTask` is the pull request's own `TASK-<n>` (its branch), which an
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

const READS_TRAILER_RE = /^[ \t]*Alissa-Reads[ \t]*:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})[ \t]*$/gim;
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
  const result = (rulesRun: KRule[]): KbLintResult => ({
    target: src.label, kind: src.kind, questionCount, failures: sortKb(failures), rulesRun, notes,
  });

  // K1 — layout and immutability (found by the reader).
  for (const m of src.layout) fail("K1", m);

  if (src.kind === "assessment") {
    // K1's online half: the one assessments/*.md file is admitted only from a design task (§7.1).
    const task = opts.prTask ?? null;
    if (!opts.online) notes.push("K1's design-task check not run (offline)");
    else if (task === null) fail("K1", "an assessment is admitted only from a `kind: design` task, and this run names none (a `TASK-<n>-…` branch or --task)");
    else {
      try {
        const res = await opts.reader.get(`/v1/tasks/${encodeURIComponent(task)}`);
        if (res.status !== 200) fail("K1", `could not read the PR's task \`${task}\`: ${describe(res)}`);
        else {
          const kind = (res.body as { task?: { kind?: unknown } })?.task?.kind ?? "code";
          if (kind !== "design") fail("K1", `the PR's task \`${task}\` is \`kind: ${clean(kind)}\` — only a design task adds a \`knowledge-base/assessments/*.md\` file (§7.1)`);
        }
      } catch (err) {
        if (err instanceof AlissaUnavailable) fail("K1", `could not verify the PR's task \`${task}\`: ${err.message}`);
        else throw err;
      }
    }
    // K5 — the assessment's text is scanned like a finding's.
    for (const [file, text] of src.files) {
      const lines = secretShapedLines(text);
      if (lines.length > 0) fail("K5", `secret-shaped text on line(s) ${lines.join(", ")} — the token shapes of repoContextFilter.ts (§10)`, file);
    }
    notes.push("an assessment is a design document: K2–K4, K6 and K7 apply to findings only");
    return result(["K1", "K5"]);
  }

  const text = src.files.get(FINDINGS_FILE);
  const bytes = src.sizes.get(FINDINGS_FILE);
  if (bytes !== undefined && bytes > KB_LIMITS.fileBytes) fail("K4", `findings.md is ${bytes} bytes; the limit is ${KB_LIMITS.fileBytes} (§2.3)`, FINDINGS_FILE);
  if (text === undefined) {
    notes.push("K2–K7 not run: no readable findings.md");
    return result(["K1", "K4"]);
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
        for (const e of validate.errors ?? []) {
          if (isKbSizeError(e)) fail("K4", `frontmatter ${ajvMessage(e)} (§2.3)`, FINDINGS_FILE);
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
    for (const c of allCites(questions, risks)) {
      if (!readRepos.has(c.repo.toLowerCase())) k2fail(`a cite names \`${clean(c.repo)}\`, which is not in \`reads\` — every cite is read at a pinned SHA`);
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
      if (q.status === "answered" && (!Array.isArray(q.cites) || q.cites.length === 0)) fail("K3", `question \`${id}\` is \`answered\` but cites nothing — an answer is grounded in the code (§2.3)`, FINDINGS_FILE);
    }
    const sections = body === null ? [] : level2Sections(body).sections;
    if (!sections.some((s) => s.title === "Summary")) fail("K3", "the body has no `## Summary` — it is what the Findings evidence carries (§2.4)", FINDINGS_FILE);
  }

  // K4 — size: line spans and the body's sections (the counts came from the schema above).
  if (fm) {
    for (const c of allCites(questions, risks)) {
      const [a, b] = c.lines.split("-").map(Number) as [number, number | undefined];
      const where = `cite \`${clean(c.path)}\` lines \`${c.lines}\``;
      if (b !== undefined && b < a) fail("K4", `${where} runs backwards`, FINDINGS_FILE);
      else if (b !== undefined && b - a > KB_LIMITS.lineSpanMax) fail("K4", `${where} spans ${b - a} lines; at most ${KB_LIMITS.lineSpanMax} (§2.3)`, FINDINGS_FILE);
    }
  }
  if (body !== null) {
    for (const s of level2Sections(body).sections) {
      const n = charLength(s.lines.join("\n").trim());
      const max = s.title === "Summary" ? KB_LIMITS.summaryChars : KB_LIMITS.questionSectionChars;
      if (n > max) fail("K4", `\`## ${clean(s.title)}\` is ${n} characters; at most ${max} (§2.3)`, FINDINGS_FILE);
    }
  }

  // K5 — hygiene: no cite to a deny-listed path, no secret-shaped text anywhere in the file.
  if (fm) {
    for (const c of allCites(questions, risks)) {
      if (isDeniedPath(c.path)) fail("K5", `a cite names \`${clean(c.path)}\`, a deny-listed path — the worker never opens it (§10)`, FINDINGS_FILE);
    }
  }
  const secretLines = secretShapedLines(text);
  if (secretLines.length > 0) fail("K5", `secret-shaped text on line(s) ${secretLines.join(", ")} — the token shapes of repoContextFilter.ts (§10)`, FINDINGS_FILE);

  if (!opts.online) {
    notes.push("K6–K7 not run (offline)");
    return result(["K1", "K2", "K3", "K4", "K5"]);
  }
  if (!fm) {
    notes.push("K6–K7 not evaluated: the frontmatter is not valid (K2)");
    return result(["K1", "K2", "K3", "K4", "K5", "K6", "K7"]);
  }
  await kbTask(fm, src, opts.reader, fail);
  await kbCites(allCites(questions, risks), fm.reads as Array<{ repo: string; sha: string }>, opts.verifier, fail, notes);
  return result(["K1", "K2", "K3", "K4", "K5", "K6", "K7"]);
}

function allCites(questions: Array<Record<string, unknown>>, risks: Array<Record<string, unknown>>): Cite[] {
  const out: Cite[] = [];
  for (const x of [...questions, ...risks]) if (Array.isArray(x.cites)) out.push(...(x.cites as Cite[]));
  return out;
}

type KbFail = (rule: KRule, message: string, file?: string, couldNotRun?: boolean) => void;

/** K6: the task resolves, is a discovery task created on the directory's day, and pinned what `reads` says. */
async function kbTask(fm: Record<string, unknown>, src: KbSource, reader: AlissaReader, fail: KbFail): Promise<void> {
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
  const pinned = new Map<string, string>();
  for (const m of (typeof t.description === "string" ? t.description : "").matchAll(READS_TRAILER_RE)) pinned.set((m[1] as string).toLowerCase(), m[2] as string);
  if (pinned.size === 0) return fail("K6", `\`${task}\` carries no \`Alissa-Reads: <owner>/<repo>@<sha>\` trailer — its read SHA is unknown, so K6 refuses rather than guesses`, FINDINGS_FILE);
  for (const r of fm.reads as Array<{ repo: string; sha: string }>) {
    const want = pinned.get(r.repo.toLowerCase());
    if (want === undefined) fail("K6", `\`reads\` names \`${clean(r.repo)}\`, which \`${task}\` does not read (its Alissa-Reads: ${[...pinned.keys()].join(", ")})`, FINDINGS_FILE);
    else if (want !== r.sha) fail("K6", `\`reads\` pins \`${clean(r.repo)}\` at \`${r.sha}\`, but \`${task}\`'s Alissa-Reads pins \`${want}\``, FINDINGS_FILE);
  }
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
    notes.push("K7: the findings cite nothing");
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

function sortKb(f: KbFailure[]): KbFailure[] {
  return f.map((x, i) => ({ x, i })).sort((a, b) => Number(a.x.rule.slice(1)) - Number(b.x.rule.slice(1)) || a.i - b.i).map(({ x }) => x);
}
