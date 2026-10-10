// The twelve rules of design §5.5, and rule 5b of loop-operator-surface §2.12 (L12), evaluated in
// order over one plan. Every rule runs (so a fixture can prove it fails exactly one); the verdict is
// the first failure, with its rule named.
import { readFileSync } from "node:fs";
import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import { minimatch } from "minimatch";
import { type AlissaReader, AlissaUnavailable, describe } from "./alissa.ts";
import { contentsPath, repoPath } from "./github.ts";
import { charLength, level2Sections, listItems, parseFrontmatter, splitFrontmatter } from "./markdown.ts";
import {
  DAG_BEGIN, DAG_END, SUMMARY_BEGIN, SUMMARY_END, isRecord, oneLine, readRegion, renderDag, renderSummary, taskView, type TaskView,
} from "./render.ts";
import { type PlanSource, isTaskPath } from "./source.ts";

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
      for (const e of validateTask.errors ?? []) {
        if (isClassError(e)) {
          const refuters = isRecord(info.fm) && info.fm.commitClass === "unanchored" ? " — `unanchored` is the refuter's alone (§4.3)" : "";
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
    for (const entry of fmOf(t).scope as string[]) {
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
    for (const entry of fm.scope as string[]) {
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
      for (const entry of fm(t).scope as string[]) {
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
