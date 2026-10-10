#!/usr/bin/env node
// plan-lint — the deterministic linter for plan directories (design §5.5, D17, D18).
//
//   plan-lint [--offline] [--base <ref> | --no-base] <plan-dir>
//   plan-lint --write [--offline] [--base <ref> | --no-base] <plan-dir>
//   plan-lint --pr --base <rev> --head <rev> [--repo <path>] [--offline]
//
// Rules 1–9 need no network; rules 10–12 read Alissa with ALISSA_API_TOKEN (ALISSA_BASE overrides
// https://api.alissa.app), and rule 5b reads each task's repository on GitHub (GITHUB_TOKEN or
// GH_TOKEN when set; GITHUB_API_URL overrides https://api.github.com). --offline runs rules 1–9 only. --summary-file <path> appends a Markdown
// report; --check-output <path> writes { conclusion, title, summary } for a check run.
// Exit status: 0 passed (or nothing to lint), 1 refused, 2 usage or internal error.
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { httpReader } from "./alissa.ts";
import { DEFAULT_GITHUB_API, githubReader } from "./github.ts";
import { parseFrontmatter, splitFrontmatter } from "./markdown.ts";
import {
  DAG_BEGIN, DAG_END, SUMMARY_BEGIN, SUMMARY_END, ensureMarkers, renderDag, renderSummary, taskView, writeRegion, type TaskView,
} from "./render.ts";
import { type LintResult, RULE_NAMES, lint } from "./rules.ts";
import { type PlanSource, UsageError, isTaskPath, readPlanDir, readPlanFromGit } from "./source.ts";

export const DEFAULT_ALISSA_BASE = "https://api.alissa.app";

export interface Report {
  conclusion: "success" | "failure";
  title: string;
  summary: string;
  lines: string[];
}

export function nothingToLint(changed: number): Report {
  const title = "nothing to lint — no plans/** file changed";
  return {
    conclusion: "success",
    title,
    summary: `**plan-lint: ${title}.** The pull request changes ${changed} file(s), none under \`plans/\`.`,
    lines: [`plan-lint: ${title}`],
  };
}

export function report(r: LintResult): Report {
  const ran = r.rulesRun.includes("5b") ? "rules 1–12 and 5b" : `rules ${r.rulesRun[0]}–${r.rulesRun[r.rulesRun.length - 1]}`;
  const head = `${r.plan} — ${r.taskCount} task(s) — plan class: ${r.planClass ?? "none"} — ${ran}`;
  const lines = [`plan-lint: ${head}`];
  const first = r.failures[0];
  const fmt = (f: { rule: number | "5b"; file?: string; message: string }): string =>
    `rule ${f.rule} (${RULE_NAMES[f.rule]})${f.file ? ` — ${f.file}` : ""}: ${f.message}`;
  if (first) {
    lines.push(`plan-lint: FAIL ${fmt(first)}`);
    for (const f of r.failures.slice(1)) lines.push(`plan-lint:   also ${fmt(f)}`);
  } else lines.push("plan-lint: PASS");
  for (const w of r.warnings) lines.push(`plan-lint:   warn: ${w}`);
  for (const n of r.notes) lines.push(`plan-lint:   note: ${n}`);

  const md = [
    `**plan-lint** · \`${r.plan}\` · ${r.taskCount} task(s) · plan class: \`${r.planClass ?? "none"}\` · ${ran}`,
    "",
    first ? `**FAIL — ${fmt(first)}**` : "**PASS**",
  ];
  if (r.failures.length > 1) md.push("", "Every finding, in rule order:", "", ...r.failures.map((f) => `- ${fmt(f)}`));
  if (r.warnings.length > 0) md.push("", "Warnings (not checked — never a pass):", "", ...r.warnings.map((w) => `- ${w}`));
  if (r.notes.length > 0) md.push("", "Notes:", "", ...r.notes.map((n) => `- ${n}`));
  const warned = r.warnings.length > 0 ? ` — ${r.warnings.length} warning(s)` : "";
  const title = first ? `FAIL — rule ${first.rule} (${RULE_NAMES[first.rule]}) — ${r.plan}` : `PASS — ${r.plan} — plan class ${r.planClass ?? "none"}${warned}`;
  return { conclusion: first ? "failure" : "success", title, summary: md.join("\n"), lines };
}

/** `--write`: render the Summary and the Dependency graph into plan.md. Returns whether it changed. */
export function writeGenerated(src: PlanSource, dir: string): boolean {
  const views: TaskView[] = [];
  for (const file of [...src.sizes.keys()].filter(isTaskPath).sort()) {
    const text = src.files.get(file);
    const split = text === undefined ? null : splitFrontmatter(text);
    const parsed = split && split.ok ? parseFrontmatter(split.frontmatter) : null;
    const view = parsed && parsed.ok ? taskView(parsed.value) : null;
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
  plan-lint --pr --base <rev> --head <rev> [--repo <path>] [--offline]
options: --summary-file <path>  --check-output <path>
env: ALISSA_API_TOKEN (rules 10–12), ALISSA_BASE (default ${DEFAULT_ALISSA_BASE}),
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
    if (values.pr) {
      if (values.write || positionals.length > 0 || !values.base || !values.head) throw new UsageError("--pr takes --base and --head and no directory (and never --write)");
      const read = readPlanFromGit(values.repo ?? process.cwd(), values.base, values.head);
      if (read.kind === "nothing") out = nothingToLint(read.changed.length);
      else out = report(await lint(read.source, readerFor(values.offline === true, env)));
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
    if (values["check-output"]) writeFileSync(values["check-output"], JSON.stringify({ conclusion: out.conclusion, title: out.title, summary: out.summary }));
    return out.conclusion === "success" ? 0 : 1;
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
