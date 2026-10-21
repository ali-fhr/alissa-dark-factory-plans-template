#!/usr/bin/env node
// plan-lint — the deterministic linter for plan directories (design §5.5, D17, D18).
//
//   plan-lint [--offline] [--base <ref> | --no-base] <plan-dir>
//   plan-lint --write [--offline] [--base <ref> | --no-base] <plan-dir>
//   plan-lint --pr --base <rev> --head <rev> [--repo <path>] [--offline]
//   plan-lint --kb <findings-dir | assessment.md> [--offline] [--base <ref> | --no-base] [--task TASK-<n>]
//   plan-lint --ic <run-dir> [--offline] [--base <ref> | --no-base] [--task TASK-<n>]
//
// Rules 1–9 need no network; rules 10–12 read Alissa with ALISSA_API_TOKEN (ALISSA_BASE overrides
// https://api.alissa.app), and rule 5b reads each task's repository on GitHub (GITHUB_TOKEN or
// GH_TOKEN when set; GITHUB_API_URL overrides https://api.github.com). --offline runs rules 1–9 only. --summary-file <path> appends a Markdown
// report; --check-output <path> writes { conclusion, title, summary } for a check run.
// A pull request that changes any knowledge-base/** file is linted in the knowledge-base mode, K1–K9
// (design alissa-build-discovery §3.4): K1–K5 and K9 offline, K6 reads the task, K7 posts the repo cites to
// Studio's verify route and K8 the URL cites to its url-cites route; --kb runs the same rules over a
// local directory. A finding's report ends with its `Discovery-Review: none | light — <reasons>` line. A pull request that changes
// any integration-check/** file is linted in the integration-check mode, I1–I9 (design
// alissa-build-integration-check §3.5): I1, I2 and I4–I8 offline, I3 and I9 read Alissa; --ic runs
// the same rules over a local run directory.
// Exit status: 0 passed (or nothing to lint), 1 refused, 2 usage or internal error, 3 could not run
// (Alissa unavailable through every retry — re-run it; the plan was not judged).
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { httpPoster, httpReader } from "./alissa.ts";
import { DEFAULT_GITHUB_API, githubReader } from "./github.ts";
import { parseFrontmatter, splitFrontmatter } from "./markdown.ts";
import {
  DAG_BEGIN, DAG_END, SUMMARY_BEGIN, SUMMARY_END, ensureMarkers, renderDag, renderSummary, writeRegion, type TaskView,
} from "./render.ts";
import {
  type IcLintOptions, type IcLintResult, I_RULE_NAMES, type KbLintOptions, type KbLintResult, K_RULE_NAMES, type LintResult, kRulesRan, RULE_NAMES, lint, lintIc, lintKb,
  discoveryReviewLine, planTaskView, taskOfBranch,
} from "./rules.ts";
import { type PlanSource, UsageError, isTaskPath, readIcDir, readKbDir, readPlanDir, readPlanFromGit } from "./source.ts";

export const DEFAULT_ALISSA_BASE = "https://api.alissa.app";
/** How long K7's and K8's POSTs wait for Studio: K8's route reads up to 48 pages before it answers. */
export const KB_VERIFY_TIMEOUT_MS = 120_000;

export interface Report {
  conclusion: "success" | "failure";
  title: string;
  summary: string;
  lines: string[];
  /** The run could not check a rule (Alissa unavailable through every retry): exit 3, "retry me". */
  couldNotRun?: boolean;
}

/** Exit statuses (README, *plan-lint — usage*). */
export const EXIT = { passed: 0, refused: 1, usage: 2, couldNotRun: 3 } as const;

/** A report's exit status: a could-not-run report is never `refused` — the plan was not judged. */
export function exitCode(r: Report): number {
  if (r.conclusion === "success") return EXIT.passed;
  return r.couldNotRun ? EXIT.couldNotRun : EXIT.refused;
}

export function nothingToLint(changed: number): Report {
  const title = "nothing to lint — no plans/** file changed";
  return {
    conclusion: "success",
    title,
    summary: `**plan-lint: ${title}.** The pull request changes ${changed} file(s), none under \`plans/\`, \`knowledge-base/\` or \`integration-check/\`.`,
    lines: [`plan-lint: ${title}`],
  };
}

export function report(r: LintResult): Report {
  const ran = r.rulesRun.includes("5b") ? "rules 1–12 and 5b" : `rules ${r.rulesRun[0]}–${r.rulesRun[r.rulesRun.length - 1]}`;
  const head = `${r.plan} — ${r.taskCount} task(s) — plan class: ${r.planClass ?? "none"} — ${ran}`;
  const fmt = (f: { rule: number | "5b"; file?: string; message: string }): string =>
    `rule ${f.rule} (${RULE_NAMES[f.rule]})${f.file ? ` — ${f.file}` : ""}: ${f.message}`;
  // A refusal is the verdict whenever there is one: a plan that breaks a rule is refused even when
  // another rule could not run. Only a run whose every finding is "could not run" is that.
  const verdict = r.failures.find((f) => !f.couldNotRun);
  const infra = verdict === undefined ? r.failures[0] : undefined;
  const others = r.failures.filter((f) => f !== (verdict ?? infra));
  const lines = [`plan-lint: ${head}`];
  if (verdict) lines.push(`plan-lint: FAIL ${fmt(verdict)}`);
  else if (infra) lines.push(`plan-lint could not run: ${fmt(infra)}`);
  else lines.push("plan-lint: PASS");
  for (const f of others) lines.push(`plan-lint:   also ${f.couldNotRun ? "could not run: " : ""}${fmt(f)}`);
  for (const w of r.warnings) lines.push(`plan-lint:   warn: ${w}`);
  for (const n of r.notes) lines.push(`plan-lint:   note: ${n}`);

  const header = `**plan-lint** · \`${r.plan}\` · ${r.taskCount} task(s) · plan class: \`${r.planClass ?? "none"}\` · ${ran}`;
  const md = infra
    ? [
      `**plan-lint could not run: ${fmt(infra)}**`,
      "",
      header,
      "",
      "The Alissa API stayed unavailable (unreachable, 429 or 5xx) through every retry, so the plan was not judged. Re-run the job; nothing in the plan needs fixing for this.",
    ]
    : [header, "", verdict ? `**FAIL — ${fmt(verdict)}**` : "**PASS**"];
  const tag = (f: (typeof r.failures)[number]): string => `${f.couldNotRun ? "could not run — " : ""}${fmt(f)}`;
  if (r.failures.length > 1) md.push("", "Every finding, in rule order:", "", ...r.failures.map((f) => `- ${tag(f)}`));
  if (r.warnings.length > 0) md.push("", "Warnings (not checked — never a pass):", "", ...r.warnings.map((w) => `- ${w}`));
  if (r.notes.length > 0) md.push("", "Notes:", "", ...r.notes.map((n) => `- ${n}`));
  const warned = r.warnings.length > 0 ? ` — ${r.warnings.length} warning(s)` : "";
  const title = verdict ? `FAIL — rule ${verdict.rule} (${RULE_NAMES[verdict.rule]}) — ${r.plan}`
    : infra ? `plan-lint could not run — rule ${infra.rule} (${RULE_NAMES[infra.rule]}) — ${r.plan}`
    : `PASS — ${r.plan} — plan class ${r.planClass ?? "none"}${warned}`;
  return { conclusion: r.failures.length > 0 ? "failure" : "success", title, summary: md.join("\n"), lines, ...(infra ? { couldNotRun: true } : {}) };
}

/**
 * The knowledge-base mode's report. Its titles say `knowledge-base`, which the merge edge reads
 * (§3.5); a finding's report ends with the machine-read `Discovery-Review:` line (§3.6), in the
 * check's summary and on stdout alike.
 */
export function reportKb(r: KbLintResult): Report {
  const ran = kRulesRan(r.rulesRun);
  const what = r.kind === "assessment" ? "assessment" : `${r.questionCount} question(s)`;
  const head = `${r.target} — knowledge-base mode — ${what} — ${ran}`;
  const lines = [`plan-lint: ${head}`];
  const first = r.failures[0];
  const fmt = (f: { rule: keyof typeof K_RULE_NAMES; file?: string; message: string }): string =>
    `${f.rule} (${K_RULE_NAMES[f.rule]})${f.file ? ` — ${f.file}` : ""}: ${f.message}`;
  if (first) {
    lines.push(`plan-lint: FAIL ${fmt(first)}`);
    for (const f of r.failures.slice(1)) lines.push(`plan-lint:   also ${fmt(f)}`);
  } else lines.push("plan-lint: PASS");
  for (const n of r.notes) lines.push(`plan-lint:   note: ${n}`);
  const md = [`**plan-lint** · \`${r.target}\` · knowledge-base mode · ${what} · ${ran}`, "", first ? `**FAIL — ${fmt(first)}**` : "**PASS**"];
  if (r.failures.length > 1) md.push("", "Every finding, in rule order:", "", ...r.failures.map((f) => `- ${fmt(f)}`));
  if (r.notes.length > 0) md.push("", "Notes:", "", ...r.notes.map((n) => `- ${n}`));
  if (r.review !== null) {
    lines.push(discoveryReviewLine(r.review));
    md.push("", discoveryReviewLine(r.review));
  }
  const title = !first ? `PASS — knowledge-base — ${r.target}`
    : first.couldNotRun ? `plan-lint could not run — ${first.rule} (${K_RULE_NAMES[first.rule]}) — ${r.target}`
    : `FAIL — ${first.rule} (${K_RULE_NAMES[first.rule]}) — knowledge-base — ${r.target}`;
  return { conclusion: first ? "failure" : "success", title, summary: md.join("\n"), lines, ...(first?.couldNotRun ? { couldNotRun: true } : {}) };
}

/** The integration-check mode's report. Its titles say `integration-check`, which the merge edge reads (§3.6). */
export function reportIc(r: IcLintResult): Report {
  const ran = r.rulesRun.length === 9 ? "I1–I9" : r.rulesRun.join(", ") === "I1, I2, I4, I5, I6, I7, I8" ? "I1, I2, I4–I8" : r.rulesRun.join(", ");
  const head = `${r.target} — integration-check mode — status ${r.status ?? "unknown"} — ${r.criteriaCount} criteria — ${ran}`;
  const lines = [`plan-lint: ${head}`];
  const first = r.failures[0];
  const fmt = (f: { rule: keyof typeof I_RULE_NAMES; file?: string; message: string }): string =>
    `${f.rule} (${I_RULE_NAMES[f.rule]})${f.file ? ` — ${f.file}` : ""}: ${f.message}`;
  if (first) {
    lines.push(`plan-lint: FAIL ${fmt(first)}`);
    for (const f of r.failures.slice(1)) lines.push(`plan-lint:   also ${fmt(f)}`);
  } else lines.push("plan-lint: PASS");
  for (const n of r.notes) lines.push(`plan-lint:   note: ${n}`);
  const md = [`**plan-lint** · \`${r.target}\` · integration-check mode · status \`${r.status ?? "unknown"}\` · ${r.criteriaCount} criteria · ${ran}`, "", first ? `**FAIL — ${fmt(first)}**` : "**PASS**"];
  if (r.failures.length > 1) md.push("", "Every finding, in rule order:", "", ...r.failures.map((f) => `- ${fmt(f)}`));
  if (r.notes.length > 0) md.push("", "Notes:", "", ...r.notes.map((n) => `- ${n}`));
  const title = !first ? `PASS — integration-check — ${r.target}`
    : first.couldNotRun ? `plan-lint could not run — ${first.rule} (${I_RULE_NAMES[first.rule]}) — ${r.target}`
    : `FAIL — ${first.rule} (${I_RULE_NAMES[first.rule]}) — integration-check — ${r.target}`;
  return { conclusion: first ? "failure" : "success", title, summary: md.join("\n"), lines, ...(first?.couldNotRun ? { couldNotRun: true } : {}) };
}

/** `--write`: render the Summary and the Dependency graph into plan.md. Returns whether it changed. */
export function writeGenerated(src: PlanSource, dir: string): boolean {
  const views: TaskView[] = [];
  for (const file of [...src.sizes.keys()].filter(isTaskPath).sort()) {
    const text = src.files.get(file);
    const split = text === undefined ? null : splitFrontmatter(text);
    const parsed = split && split.ok ? parseFrontmatter(split.frontmatter) : null;
    const view = parsed && parsed.ok ? planTaskView(parsed.value) : null;
    if (!view) throw new UsageError(`--write cannot render ${file}: its frontmatter lacks id, title, repo, commitClass or a well-formed dependsOn (rule 2)`);
    views.push(view);
  }
  const planPath = join(dir, "plan.md");
  const before = src.files.get("plan.md");
  if (before === undefined) throw new UsageError("--write needs a readable plan.md");
  let text = ensureMarkers(before, "Summary", SUMMARY_BEGIN, SUMMARY_END);
  if (text === null) throw new UsageError("--write: plan.md has no `## Summary` heading to render under");
  text = ensureMarkers(text, "Dependency graph", DAG_BEGIN, DAG_END);
  if (text === null) throw new UsageError("--write: plan.md has no `## Dependency graph` heading to render under");
  const withSummary = writeRegion(text, SUMMARY_BEGIN, SUMMARY_END, renderSummary(views));
  const withDag = withSummary === null ? null : writeRegion(withSummary, DAG_BEGIN, DAG_END, renderDag(views));
  if (withDag === null) throw new UsageError("--write: plan.md's generated-section markers are malformed (each must appear once, begin before end)");
  if (withDag === before) return false;
  writeFileSync(planPath, withDag);
  return true;
}

const USAGE = `usage:
  plan-lint [--offline] [--base <ref> | --no-base] <plan-dir>
  plan-lint --write [--offline] [--base <ref> | --no-base] <plan-dir>
  plan-lint --pr --base <rev> --head <rev> [--repo <path>] [--offline] [--task TASK-<n>]
  plan-lint --kb <findings-dir | assessment.md> [--offline] [--base <ref> | --no-base] [--task TASK-<n>]
  plan-lint --ic <integration-check/<YYYY>/<MM>/<DD>/<milestone>> [--offline] [--base <ref> | --no-base] [--task TASK-<n>]
options: --summary-file <path>  --check-output <path>
env: ALISSA_API_TOKEN (rules 10–12, K6–K8, I3 and I9), ALISSA_BASE (default ${DEFAULT_ALISSA_BASE}),
     GITHUB_HEAD_REF (the PR's TASK-<n>-… branch, when --task is not given),
     GITHUB_TOKEN or GH_TOKEN (rule 5b, optional), GITHUB_API_URL (default ${DEFAULT_GITHUB_API})`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        write: { type: "boolean" },
        pr: { type: "boolean" },
        offline: { type: "boolean" },
        base: { type: "string" },
        "no-base": { type: "boolean" },
        head: { type: "string" },
        repo: { type: "string" },
        kb: { type: "string" },
        ic: { type: "string" },
        task: { type: "string" },
        "summary-file": { type: "string" },
        "check-output": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(`plan-lint: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    let out: Report;
    if (values.task !== undefined && !/^TASK-[1-9][0-9]*$/.test(values.task)) throw new UsageError(`--task \`${values.task}\` is not TASK-<n>`);
    const prTask = values.task ?? taskOfBranch(env.GITHUB_HEAD_REF);
    if (values.pr) {
      if (values.write || values.kb !== undefined || values.ic !== undefined || positionals.length > 0 || !values.base || !values.head) {
        throw new UsageError("--pr takes --base and --head and no directory (and never --write, --kb or --ic)");
      }
      const read = readPlanFromGit(values.repo ?? process.cwd(), values.base, values.head);
      if (read.kind === "nothing") out = nothingToLint(read.changed.length);
      else if (read.kind === "kb") out = reportKb(await lintKb(read.source, kbOptionsFor(values.offline === true, env, prTask)));
      else if (read.kind === "ic") out = reportIc(await lintIc(read.source, icOptionsFor(values.offline === true, env, prTask)));
      else out = report(await lint(read.source, readerFor(values.offline === true, env)));
    } else if (values.ic !== undefined) {
      if (values.write || values.kb !== undefined || positionals.length > 0 || values.head || values.repo) throw new UsageError("--ic takes one run directory and no --write, --kb, --head, --repo or other directory");
      const source = readIcDir(values.ic, values["no-base"] ? null : values.base);
      out = reportIc(await lintIc(source, icOptionsFor(values.offline === true, env, prTask)));
    } else if (values.kb !== undefined) {
      if (values.write || positionals.length > 0 || values.head || values.repo) throw new UsageError("--kb takes one path and no --write, --head, --repo or other directory");
      const source = readKbDir(values.kb, values["no-base"] ? null : values.base);
      out = reportKb(await lintKb(source, kbOptionsFor(values.offline === true, env, prTask)));
    } else {
      if (positionals.length !== 1) throw new UsageError("give exactly one plan directory");
      if (values.head || values.repo) throw new UsageError("--head and --repo belong to --pr");
      const dir = positionals[0] as string;
      const base = values["no-base"] ? null : values.base;
      if (values.write) {
        const changed = writeGenerated(readPlanDir(dir, null), dir);
        console.log(`plan-lint: ${changed ? "wrote" : "already up to date:"} ${join(dir, "plan.md")} (Summary, Dependency graph)`);
      }
      const source = readPlanDir(dir, base);
      out = report(await lint(source, readerFor(values.offline === true, env)));
    }
    for (const l of out.lines) console.log(l);
    if (values["summary-file"]) appendFileSync(values["summary-file"], `${out.summary}\n`);
    if (values["check-output"]) {
      writeFileSync(values["check-output"], JSON.stringify({ conclusion: out.conclusion, title: out.title, summary: out.summary, couldNotRun: out.couldNotRun === true }));
    }
    return exitCode(out);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`plan-lint: ${err.message}`);
      return 2;
    }
    console.error(`plan-lint: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 2;
  }
}

/** Called only once there is a plan to lint: a PR with nothing to lint needs no token. */
function readerFor(offline: boolean, env: NodeJS.ProcessEnv): Parameters<typeof lint>[1] {
  if (offline) return { online: false };
  const token = env.ALISSA_API_TOKEN;
  if (!token) throw new UsageError("rules 10–12 need ALISSA_API_TOKEN; pass --offline to run rules 1–9 only");
  return { online: true, reader: httpReader({ base: env.ALISSA_BASE || DEFAULT_ALISSA_BASE, token }), github: githubReader(env) };
}

/** The knowledge-base mode's online half: K6 (and an assessment's task) through the reader, K7 and K8 through Studio's verify routes. */
function kbOptionsFor(offline: boolean, env: NodeJS.ProcessEnv, prTask: string | null): KbLintOptions {
  if (offline) return { online: false, prTask };
  const token = env.ALISSA_API_TOKEN;
  if (!token) throw new UsageError("K6–K8 need ALISSA_API_TOKEN; pass --offline to run K1–K5 and K9 only");
  const base = env.ALISSA_BASE || DEFAULT_ALISSA_BASE;
  // K8's route fetches every page (and its archive) behind a 10 s per-fetch guard before it answers.
  return { online: true, reader: httpReader({ base, token }), verifier: httpPoster({ base, token, timeoutMs: KB_VERIFY_TIMEOUT_MS }), prTask };
}

/** The integration-check mode's online half: I3 (the milestone's criteria) and I9 (the task) through the reader. */
function icOptionsFor(offline: boolean, env: NodeJS.ProcessEnv, prTask: string | null): IcLintOptions {
  if (offline) return { online: false, prTask };
  const token = env.ALISSA_API_TOKEN;
  if (!token) throw new UsageError("I3 and I9 need ALISSA_API_TOKEN; pass --offline to run I1, I2 and I4–I8 only");
  return { online: true, reader: httpReader({ base: env.ALISSA_BASE || DEFAULT_ALISSA_BASE, token }), prTask };
}

function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
