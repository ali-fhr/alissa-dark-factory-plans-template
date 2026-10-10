// c4 and c5, from the workflow's structure: the plan-lint check reports on every pull request, and
// the job holding ALISSA_API_TOKEN never checks out or executes PR-supplied code. Plus the operator's
// decision: nothing in the linter or the workflow hard-codes a plans-repository name.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { ROOT } from "./helpers.ts";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: string };
type Job = { name?: string; if?: string; permissions?: unknown; env?: unknown; environment?: unknown; steps: Step[]; "runs-on"?: string; container?: unknown; services?: unknown };
type Workflow = { name: string; on: Record<string, unknown>; permissions?: unknown; env?: unknown; jobs: Record<string, Job> };

const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "plan-lint.yml");
const raw = readFileSync(WORKFLOW_PATH, "utf8");
const wf = parse(raw) as Workflow;
const text = (v: unknown): string => JSON.stringify(v);
const PINNED = /^(actions\/checkout|actions\/setup-node)@[0-9a-f]{40}$/;

describe("the plan-lint workflow reports on every pull request (c4)", () => {
  it("is the only workflow in the repository, named plan-lint", () => {
    assert.deepEqual(readdirSync(join(ROOT, ".github", "workflows")), ["plan-lint.yml"]);
    assert.equal(wf.name, "plan-lint");
  });

  it("triggers on pull_request and pull_request_target with no paths, branches or types filter", () => {
    assert.deepEqual(Object.keys(wf.on).sort(), ["pull_request", "pull_request_target"]);
    for (const [event, cfg] of Object.entries(wf.on)) {
      assert.ok(cfg === null || (typeof cfg === "object" && Object.keys(cfg as object).length === 0), `${event} carries no filter`);
    }
  });

  it("has exactly the two jobs, each gated on its own event, and no job-level condition beyond it", () => {
    assert.deepEqual(Object.keys(wf.jobs).sort(), ["offline", "trusted"]);
    assert.equal(wf.jobs.offline?.if, "github.event_name == 'pull_request'");
    assert.equal(wf.jobs.trusted?.if, "github.event_name == 'pull_request_target'");
  });

  it("the trusted job publishes the check run named plan-lint on the PR's head commit, whatever the lint concluded", () => {
    const steps = wf.jobs.trusted?.steps ?? [];
    const publish = steps[steps.length - 1] as Step;
    assert.equal(publish.if, "always()");
    assert.match(publish.run ?? "", /name: "plan-lint", head_sha: \$sha, status: "completed"/);
    assert.match(publish.run ?? "", /gh api --method POST "repos\/\$GITHUB_REPOSITORY\/check-runs" --input -/);
    assert.match(publish.run ?? "", /if \[ ! -s "\$out" \]; then/, "a linter that never reported publishes a failure, not nothing");
    assert.equal(publish.env?.HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
  });

  it("no job's own name is plan-lint, so the published run is the only check of that name", () => {
    for (const [id, job] of Object.entries(wf.jobs)) assert.notEqual(job.name ?? id, "plan-lint");
  });
});

describe("the secret-bearing job never checks out or executes PR-supplied code (c5)", () => {
  const trusted = wf.jobs.trusted as Job;
  const offline = wf.jobs.offline as Job;

  it("the workflow grants nothing by default and sets no workflow-level env", () => {
    assert.deepEqual(wf.permissions, {});
    assert.equal(wf.env, undefined);
  });

  it("secrets appear in exactly one place: the env of the trusted job's lint step", () => {
    const secretRefs = [...raw.matchAll(/secrets\.[A-Za-z_]+/g)].map((m) => m[0]);
    assert.deepEqual(secretRefs, ["secrets.ALISSA_API_TOKEN"]);
    assert.equal(trusted.env, undefined);
    const holders = trusted.steps.filter((s) => text(s).includes("secrets."));
    assert.equal(holders.length, 1);
    const lintStep = holders[0] as Step;
    assert.deepEqual(Object.keys(lintStep.env ?? {}).sort(), ["ALISSA_API_TOKEN", "BASE_SHA", "HEAD_SHA"]);
    assert.equal(lintStep.env?.ALISSA_API_TOKEN, "${{ secrets.ALISSA_API_TOKEN }}");
    assert.equal(lintStep.uses, undefined, "the secret is never handed to an action");
    assert.equal(
      lintStep.run,
      'node lint/plan-lint.ts --pr --base "$BASE_SHA" --head "$HEAD_SHA" --summary-file "$GITHUB_STEP_SUMMARY" --check-output "$RUNNER_TEMP/plan-lint-check.json"',
      "the step runs the base checkout's linter in --pr mode (blobs as data) and nothing else",
    );
  });

  it("the secret lives in the alissa-plan-lint environment, and only the trusted job enters it", () => {
    assert.equal(trusted.environment, "alissa-plan-lint", "an environment secret limited to the default branch is out of reach of a PR's own workflow file");
    for (const [id, job] of Object.entries(wf.jobs)) if (id !== "trusted") assert.equal(job.environment, undefined, `${id} names no environment`);
  });

  it("the offline job, which runs PR code, holds no secret and a read-only token", () => {
    assert.ok(!text(offline).includes("secrets."));
    assert.deepEqual(offline.permissions, { contents: "read" });
    assert.ok(!text(offline).includes("github.token"));
  });

  it("the trusted job checks out the base commit only, without persisted credentials", () => {
    const checkouts = trusted.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 1);
    const c = checkouts[0] as Step;
    assert.equal(c.with?.ref, "${{ github.sha }}", "pull_request_target's github.sha is the base branch's commit");
    assert.equal(c.with?.["persist-credentials"], false);
    assert.equal(c.with?.repository, undefined);
    assert.equal(c.with?.path, undefined);
  });

  it("the trusted job uses only the two pinned first-party actions, no container and no services", () => {
    for (const s of trusted.steps) if (s.uses) assert.match(s.uses, PINNED);
    assert.equal(trusted.container, undefined);
    assert.equal(trusted.services, undefined);
    assert.ok(!text(trusted.steps.find((s) => s.uses?.startsWith("actions/setup-node@"))?.with ?? {}).includes("cache"), "no dependency cache to poison");
    assert.deepEqual(trusted.permissions, { contents: "read", checks: "write" });
  });

  it("the trusted job never names the PR's branch or merge ref, and interpolates nothing into a script", () => {
    for (const forbidden of ["head_ref", "pull_request.head.ref", "pull_request.head.repo", "/merge", "pull_request.title", "pull_request.body"]) {
      assert.ok(!text(trusted).includes(forbidden), forbidden);
    }
    for (const s of trusted.steps) if (s.run) assert.ok(!s.run.includes("${{"), `no expression inside the script of "${s.name}" — values arrive through env`);
  });

  it("the trusted job's scripts never check out, extract, install from or execute the PR's tree", () => {
    const scripts = trusted.steps.map((s) => s.run ?? "").join("\n");
    for (const verb of [
      /\bgit (checkout|switch|worktree|restore|reset|read-tree|checkout-index|archive|stash|apply|am|merge|rebase|cherry-pick|pull)\b/,
      /\btar\b/, /\bunzip\b/, /\bnpx\b/, /\bnpm (install|i|exec|run|test|start)\b/, /\bsh -c\b/, /\bbash\b/, /\beval\b/, /\bsource\b/, /\bcurl\b/, /\bwget\b/,
    ]) {
      assert.ok(!verb.test(scripts), `trusted scripts use ${verb}`);
    }
    const fetchIndex = trusted.steps.findIndex((s) => /git -c "http\.extraheader=\$auth" fetch/.test(s.run ?? ""));
    const installIndex = trusted.steps.findIndex((s) => /^npm ci --ignore-scripts$/.test(s.run ?? ""));
    assert.ok(installIndex >= 0 && fetchIndex > installIndex, "dependencies come from the base lockfile, installed before any PR object is fetched");
    const after = trusted.steps.slice(fetchIndex + 1);
    assert.deepEqual(after.map((s) => (s.run ?? "").split("\n")[0]?.split(" ")[0]), ["node", "out=\"$RUNNER_TEMP/plan-lint-check.json\""]);
  });

  it("the fetch step brings the PR in as objects: a fetch into a remote-tracking ref, never a checkout", () => {
    const fetch = trusted.steps.find((s) => /fetch --no-tags/.test(s.run ?? "")) as Step;
    assert.match(fetch.run ?? "", /\+refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/pull\/head/);
    assert.ok(!text(fetch.env).includes("secrets."));
  });
});

describe("nothing hard-codes a plans-repository name", () => {
  const sources = [
    WORKFLOW_PATH,
    join(ROOT, "package.json"),
    join(ROOT, "tsconfig.json"),
    ...readdirSync(join(ROOT, "lint")).filter((f) => f.endsWith(".ts")).map((f) => join(ROOT, "lint", f)),
  ];
  for (const file of sources) {
    it(file.slice(ROOT.length), () => {
      const body = readFileSync(file, "utf8");
      for (const name of [/alissa-dark-factory-plans/i, /alissa-plans/i, /\bali-fhr\//i]) assert.ok(!name.test(body), `${name} in ${file}`);
    });
  }
});
