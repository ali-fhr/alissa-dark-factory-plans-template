// The pull-request mode the CI job runs: rule 1 on a real diff (c6), "nothing to lint" (c4), and
// the proof that linting a PR never executes, checks out or follows anything the PR supplied (c5).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { commitAll, fixturePlan, git, initRepo, runCli, tempDir } from "./helpers.ts";

const GOLDEN_ID = "2026-09-28-golden-plan";

function addGolden(repo: string, id = GOLDEN_ID): void {
  const dest = join(repo, "plans", id);
  mkdirSync(join(repo, "plans"), { recursive: true });
  cpSync(fixturePlan("golden"), dest, { recursive: true });
  if (id !== GOLDEN_ID) {
    const p = join(dest, "plan.md");
    writeFileSync(p, readFileSync(p, "utf8").replace(`id: ${GOLDEN_ID}`, `id: ${id}`));
  }
}

async function lintPr(repo: string, base: string, head: string, extra: string[] = []) {
  return runCli(["--pr", "--offline", "--repo", repo, "--base", base, "--head", head, ...extra]);
}

describe("--pr", () => {
  it("a PR that touches no plans/** file succeeds with 'nothing to lint'", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "TASK-1-TOOLING");
    writeFileSync(join(repo, "README.md"), "# r\n\nmore\n");
    const head = commitAll(repo, "readme");
    const out = join(tempDir("nothing"), "check.json");
    const run = await runCli(["--pr", "--repo", repo, "--base", base, "--head", head, "--check-output", out]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /nothing to lint — no plans\/\*\* file changed/);
    const check = JSON.parse(readFileSync(out, "utf8")) as { conclusion: string; title: string };
    assert.equal(check.conclusion, "success");
    assert.match(check.title, /^nothing to lint/);
    assert.match(run.stdout, /nothing to lint/, "and it needs no ALISSA_API_TOKEN to say so");
  });

  it("a PR adding one new plan directory passes", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "PLAN-20260928T000000Z-golden-plan");
    addGolden(repo);
    const head = commitAll(repo, "plan");
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^plan-lint: plans\/2026-09-28-golden-plan — 2 task\(s\) — plan class: drift-fix/m);
  });

  it("c6: a PR editing a directory already on main fails rule 1", async () => {
    const repo = initRepo();
    addGolden(repo);
    const base = commitAll(repo, "merged plan");
    git(repo, "checkout", "-q", "-b", "PLAN-20260929T000000Z-edit");
    const task = join(repo, "plans", GOLDEN_ID, "tasks", "service-b-config-keys.md");
    writeFileSync(task, readFileSync(task, "utf8").replace("priority: high", "priority: top"));
    const head = commitAll(repo, "edit a merged plan");
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /^plan-lint: FAIL rule 1 \(layout and immutability\): `plans\/2026-09-28-golden-plan` already exists on the base branch/m);
  });

  it("c6: adding a file to a merged plan's directory fails rule 1 too", async () => {
    const repo = initRepo();
    addGolden(repo);
    const base = commitAll(repo, "merged plan");
    git(repo, "checkout", "-q", "-b", "PLAN-x");
    writeFileSync(join(repo, "plans", GOLDEN_ID, "materialized.json"), "{}\n");
    const head = commitAll(repo, "sneak a file in");
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 1 .*already exists on the base branch/);
  });

  it("a plan PR that also touches a file outside plans/ fails rule 1", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "PLAN-y");
    addGolden(repo);
    writeFileSync(join(repo, "README.md"), "# changed\n");
    const head = commitAll(repo, "plan + readme");
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 1 .*touches `README\.md` outside `plans\/`/);
  });

  it("a PR adding two plan directories fails rule 1", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "PLAN-z");
    addGolden(repo);
    addGolden(repo, "2026-09-28-second-plan");
    const head = commitAll(repo, "two plans");
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 1 .*2 plan directories/);
  });

  it("the diff is taken against the merge base: a plan merged on main after the branch point is not this PR's", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-q", "-b", "PLAN-late");
    addGolden(repo);
    const head = commitAll(repo, "my plan");
    git(repo, "checkout", "-q", "main");
    addGolden(repo, "2026-09-27-other-plan");
    const base = commitAll(repo, "someone else's plan merged");
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 0, run.stdout);
  });

  it("refuses an option-shaped revision", async () => {
    const repo = initRepo();
    const run = await runCli(["--pr", "--offline", "--repo", repo, "--base", "--output=/tmp/x", "--head", "HEAD"]);
    assert.equal(run.status, 2);
  });
});

describe("--pr never executes, checks out or follows PR-supplied content (c5)", () => {
  it("a PR that replaces the linter, the package scripts and git's drivers runs none of them", async () => {
    const repo = initRepo();
    const marker = join(tempDir("marker"), "pwned");
    // The base branch: the repository as it is on main.
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "PLAN-evil");
    addGolden(repo);
    // Everything a hostile PR could hope the CI job would run:
    mkdirSync(join(repo, "lint"), { recursive: true });
    const payload = `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");`;
    writeFileSync(join(repo, "lint", "plan-lint.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { preinstall: `node -e '${payload}'`, test: `node -e '${payload}'` } }));
    writeFileSync(join(repo, ".gitattributes"), "*.md diff=evil\n");
    writeFileSync(join(repo, ".npmrc"), "script-shell=/bin/false\n");
    const head = commitAll(repo, "hostile");
    // The trusted job's position: the base checked out, the PR present only as fetched objects.
    git(repo, "checkout", "-q", "--detach", base);
    git(repo, "config", "diff.evil.textconv", `sh -c 'echo ran > ${marker}'`);
    git(repo, "config", "diff.evil.command", `sh -c 'echo ran > ${marker}'`);

    const run = await lintPr(repo, base, head);
    assert.equal(existsSync(marker), false, "no PR-supplied code or driver ran");
    assert.equal(run.status, 1, "the plan PR that touches lint/ and package.json is refused by rule 1");
    assert.match(run.stdout, /touches `lint\/plan-lint\.ts` outside `plans\/`/);
    assert.equal(git(repo, "rev-parse", "HEAD"), base, "HEAD never moved to the PR");
    assert.equal(existsSync(join(repo, "plans")), false, "the PR's files were never written to the work tree");
    assert.equal(existsSync(join(repo, "lint", "plan-lint.ts")), false);
  });

  it("a symbolic link in a plan is refused and never followed", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const secret = join(tempDir("secret"), "token.txt");
    writeFileSync(secret, "SECRET-VALUE-123\n");
    git(repo, "checkout", "-q", "-b", "PLAN-link");
    addGolden(repo);
    const task = join(repo, "plans", GOLDEN_ID, "tasks", "service-b-config-keys.md");
    const { rmSync } = await import("node:fs");
    rmSync(task);
    symlinkSync(secret, task);
    const head = commitAll(repo, "link");
    git(repo, "checkout", "-q", "--detach", base);
    const run = await lintPr(repo, base, head);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 1 .*`tasks\/service-b-config-keys\.md` is a symbolic link/);
    assert.equal(run.stdout.includes("SECRET-VALUE-123") || run.stderr.includes("SECRET-VALUE-123"), false, "the link's target was never read");
  });
});

describe("directory mode, rule 1's immutability half", () => {
  it("refuses a directory that already exists on origin/HEAD, and on an explicit --base", async () => {
    const upstream = initRepo();
    addGolden(upstream);
    commitAll(upstream, "merged plan");
    const clone = tempDir("clone");
    git(clone, "clone", "-q", upstream, ".");
    const dir = join(clone, "plans", GOLDEN_ID);
    const auto = await runCli(["--offline", dir]);
    assert.equal(auto.status, 1, auto.stdout);
    assert.match(auto.stdout, /FAIL rule 1 .*`plans\/2026-09-28-golden-plan` already exists on the base branch \(refs\/remotes\/origin\/HEAD\)/);
    const explicit = await runCli(["--offline", "--base", "main", dir]);
    assert.equal(explicit.status, 1);
    const skipped = await runCli(["--offline", "--no-base", dir]);
    assert.equal(skipped.status, 0, skipped.stdout);
    assert.match(skipped.stdout, /immutability not checked \(--no-base\)/);
  });

  it("passes a new plan directory and says when no base branch could be found", async () => {
    const repo = initRepo();
    addGolden(repo);
    const run = await runCli(["--offline", join(repo, "plans", GOLDEN_ID)]);
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /immutability not checked: no base branch found/);
  });
});
