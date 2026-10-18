// The integration-check mode (design alissa-build-integration-check §3.4, §3.5, lane IC-1): c1 an
// integration-check-only PR is linted, never "nothing to lint"; c2 one fixture per I rule fails
// exactly that rule; c3 a mix with plans/ or knowledge-base/ is refused by I1; c4 I6's statusOf is
// §4.1's, and lint/VERSION declares the mode and its rules.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { httpReader } from "../alissa.ts";
import { reportIc } from "../plan-lint.ts";
import { IC_EVIDENCE_TYPES, IC_LIMITS, type IRule, I_RULE_NAMES, type IcLintOptions, type IntegrationReport, lintIc, statusOf } from "../rules.ts";
import { readIcDir } from "../source.ts";
import {
  FIXTURES, type FakeAlissa, KB_CREATED, type KbWorld, TOKEN, cliEnv, commitAll, fakeAlissa, fixturePlan, git, initRepo, kbFixture, loadWorld, runCli, tempDir,
} from "./helpers.ts";

const IC_FIXTURES = join(FIXTURES, "integration-check");
const RUN = join("integration-check", "2026", "10", "18", "example-program-m1");
const RUN_PATH = "integration-check/2026/10/18/example-program-m1";
const IC_SHA = "7c1e4b2a9d3f5e6071829a3b4c5d6e7f80912a3b";

/** The fixtures' Alissa state for I3 and I9: the plan fixtures' world, and these tasks. */
function icWorld(): KbWorld {
  const check = { kind: "integration_check", createdAt: KB_CREATED, reads: `example-org/service-b@${IC_SHA}` };
  return { tasks: { "TASK-3000": { ...check }, "TASK-3001": { ...check }, "TASK-3009": { ...check, kind: "code" } }, files: {} };
}

let api: FakeAlissa;
before(async () => {
  api = await fakeAlissa(loadWorld(), icWorld());
});
after(async () => {
  await api.close();
});

const online = (prTask: string | null = null): IcLintOptions => ({ online: true, reader: httpReader({ base: api.base, token: TOKEN, retries: 0 }), prTask });
const icFixture = (name: string): string => join(IC_FIXTURES, name, RUN);
const icCases = readdirSync(IC_FIXTURES).filter((n) => /^ic-i\d-/.test(n)).sort();
const ruleOf = (name: string): IRule => {
  const m = /^ic-(i[1-9])-[a-z0-9-]+$/.exec(name);
  assert.ok(m, `fixture case \`${name}\` is named ic-i<n>-<what>`);
  return (m[1] as string).toUpperCase() as IRule;
};
const lintCase = async (name: string, prTask: string | null = null) => lintIc(readIcDir(icFixture(name), null), online(prTask));

/** A copy of the golden run whose report.md (and evidence) a test edits. */
function variant(edit: (s: string) => string = (s) => s, files: Record<string, string | Buffer> = {}): string {
  const dir = join(tempDir("ic-var"), RUN);
  cpSync(icFixture("ic-golden"), dir, { recursive: true });
  const report = join(dir, "report.md");
  writeFileSync(report, edit(readFileSync(report, "utf8")));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
  return dir;
}
const failuresOf = async (dir: string, opts: IcLintOptions = { online: false }) => (await lintIc(readIcDir(dir, null), opts)).failures;
const rulesOf = (f: Array<{ rule: IRule }>) => [...new Set(f.map((x) => x.rule))];
const text = (f: Array<{ rule: IRule; message: string }>) => f.map((x) => `${x.rule} ${x.message}`).join("\n");

/** A repository whose PR branch adds the fixture case's run directory. */
function icPr(caseName: string, opts: { onBase?: boolean; plan?: boolean; kb?: boolean; also?: Record<string, string> } = {}): { repo: string; base: string; head: string } {
  const repo = initRepo();
  const add = (): void => cpSync(join(IC_FIXTURES, caseName, "integration-check"), join(repo, "integration-check"), { recursive: true });
  if (opts.onBase) {
    add();
    commitAll(repo, "merged run");
  }
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "TASK-3000-integration-check");
  if (opts.onBase) writeFileSync(join(repo, RUN, "report.md"), "---\n---\nedited\n");
  else add();
  if (opts.plan) cpSync(fixturePlan("golden"), join(repo, "plans", "2026-09-28-golden-plan"), { recursive: true });
  if (opts.kb) cpSync(kbFixture("kb-golden"), join(repo, "knowledge-base", "2026", "10", "14", "TASK-1234"), { recursive: true });
  for (const [path, body] of Object.entries(opts.also ?? {})) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  return { repo, base, head: commitAll(repo, "pr") };
}
const prArgs = (pr: { repo: string; base: string; head: string }, extra: string[] = []) => ["--pr", "--repo", pr.repo, "--base", pr.base, "--head", pr.head, ...extra];
const branchEnv = (task = "TASK-3000") => ({ ...cliEnv(api), GITHUB_HEAD_REF: `${task}-integration-check` });

describe("integration-check fixtures (c2)", () => {
  it("has the golden run and exactly one fixture per I rule", () => {
    assert.deepEqual(icCases.map(ruleOf), ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"]);
    assert.ok(readdirSync(IC_FIXTURES).includes("ic-golden"));
  });

  it("the golden run passes I1–I9, its task the branch's", async () => {
    const r = await lintCase("ic-golden", "TASK-3000");
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.rulesRun, ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"]);
    assert.equal(r.status, "SUCCESS");
    assert.equal(r.criteriaCount, 2);
  });

  for (const name of icCases) {
    const rule = ruleOf(name);
    it(`${name} fails ${rule} (${I_RULE_NAMES[rule]}) and no other rule`, async () => {
      const r = await lintCase(name);
      assert.ok(r.failures.length > 0, "expected a failure");
      assert.deepEqual(rulesOf(r.failures), [rule], JSON.stringify(r.failures, null, 2));
      assert.ok(r.failures.every((f) => !f.couldNotRun), "a refusal, not a run that could not happen");
    });

    it(`${name}: the CLI exits 1 and the verdict names ${rule}`, async () => {
      const run = await runCli(["--ic", icFixture(name), "--no-base"], cliEnv(api));
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const verdict = run.stdout.split("\n").find((l) => l.startsWith("plan-lint: FAIL "));
      assert.ok(verdict?.startsWith(`plan-lint: FAIL ${rule} (${I_RULE_NAMES[rule]})`), run.stdout);
    });
  }

  it("each fixture is refused for its own reason", async () => {
    const messages = async (name: string) => text((await lintCase(name)).failures);
    assert.match(await messages("ic-i1-layout"), /`notes\.md` does not belong in a run directory/);
    assert.match(await messages("ic-i2-frontmatter"), /\/steps\/0\/verdict must be equal to one of the allowed values: pass, fail, unverified, skipped/);
    assert.match(await messages("ic-i3-criteria"), /the milestone's criterion `c2` has no verdict/);
    assert.match(await messages("ic-i4-evidence"), /criterion `c1` cites `evidence\/c1-settings-768\.png`, which is not a file of the run/);
    assert.match(await messages("ic-i5-unverified"), /the body's first section is `## Summary` — every report opens with `## Couldn't verify`/);
    assert.match(await messages("ic-i6-status"), /`status` is `UNCERTAIN` but the verdicts make it `SUCCESS`/);
    assert.match(await messages("ic-i7-size"), /is a `\.html` file — evidence is png, jpg, webp, log, txt, json, yml only/);
    assert.match(await messages("ic-i8-hygiene"), /`notes\[1\]` is not a variable name/);
    assert.match(await messages("ic-i9-task"), /`TASK-3009` is `kind: code`, not `integration_check`/);
  });

  it("I8 never prints the value a note carried", async () => {
    assert.doesNotMatch(text((await lintCase("ic-i8-hygiene")).failures), /RESEND_API_KEY=set/);
  });

  it("offline runs I1, I2 and I4–I8; the I3 and I9 fixtures pass them", async () => {
    for (const name of ["ic-golden", "ic-i3-criteria", "ic-i9-task"]) {
      const run = await runCli(["--ic", icFixture(name), "--no-base", "--offline"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /integration-check mode — status SUCCESS — \d criteria — I1, I2, I4–I8$/m);
      assert.match(run.stdout, /I3 and I9 not run \(offline\)/);
    }
  });

  it("online without ALISSA_API_TOKEN it refuses to run rather than skip I3 and I9", async () => {
    const run = await runCli(["--ic", icFixture("ic-golden"), "--no-base"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /I3 and I9 need ALISSA_API_TOKEN/);
  });

  it("--ic takes a directory, and no other mode beside it", async () => {
    let run = await runCli(["--ic", join(icFixture("ic-golden"), "report.md"), "--offline"]);
    assert.equal(run.status, 2);
    run = await runCli(["--ic", icFixture("ic-golden"), "--kb", kbFixture("kb-golden"), "--offline"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--ic takes one run directory/);
  });
});

describe("--pr in the integration-check mode (c1, c3)", () => {
  it("c1: an integration-check-only PR is linted — never 'nothing to lint'", async () => {
    const out = join(tempDir("ic-pr"), "check.json");
    const run = await runCli(prArgs(icPr("ic-golden"), ["--check-output", out]), branchEnv());
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /nothing to lint/);
    assert.match(run.stdout, new RegExp(`^plan-lint: ${RUN_PATH} — integration-check mode — status SUCCESS — 2 criteria — I1–I9$`, "m"));
    const check = JSON.parse(readFileSync(out, "utf8")) as { conclusion: string; title: string };
    assert.deepEqual(check, { ...check, conclusion: "success", title: `PASS — integration-check — ${RUN_PATH}` });
  });

  it("c1: an integration-check-only PR that is refused fails, offline too, with the mode in its title", async () => {
    const out = join(tempDir("ic-pr"), "check.json");
    const run = await runCli(prArgs(icPr("ic-i6-status"), ["--offline", "--check-output", out]));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /^plan-lint: FAIL I6 \(the status follows the rules\)/m);
    const check = JSON.parse(readFileSync(out, "utf8")) as { title: string };
    assert.equal(check.title, `FAIL — I6 (the status follows the rules) — integration-check — ${RUN_PATH}`);
  });

  it("c3: a mix with plans/ is refused by I1", async () => {
    const run = await runCli(prArgs(icPr("ic-golden", { plan: true }), ["--offline"]));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /^plan-lint: FAIL I1 \(layout and immutability\): the diff touches `plans\/2026-09-28-golden-plan\/plan\.md` — an integration-check PR never carries a plan/m);
  });

  it("c3: a mix with knowledge-base/ is refused by I1 (the integration-check mode wins the selection)", async () => {
    const run = await runCli(prArgs(icPr("ic-golden", { kb: true }), ["--offline"]));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /^plan-lint: FAIL I1 \(layout and immutability\): the diff touches `knowledge-base\/2026\/10\/14\/TASK-1234\/findings\.md` — an integration-check PR never carries a finding/m);
  });

  it("I1: a file outside integration-check/, a second run, a stray file, a bad date, a bad milestone name — each refused", async () => {
    const fails = async (pr: { repo: string; base: string; head: string }, re: RegExp) => {
      const run = await runCli(prArgs(pr, ["--offline"]));
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stdout, re);
    };
    await fails(icPr("ic-golden", { also: { "lint/rules.ts": "// nope\n" } }), /FAIL I1 .*`lint\/rules\.ts` outside `integration-check\/`/);
    await fails(icPr("ic-golden", { also: { "integration-check/2026/10/18/example-program-m2/report.md": "x\n" } }), /FAIL I1 .*touches 2 integration-check directories/);
    await fails(icPr("ic-golden", { also: { "integration-check/INDEX.md": "x\n" } }), /FAIL I1 .*`integration-check\/INDEX\.md` — a run lives in/);
    await fails(icPr("ic-golden", { also: { [`${RUN_PATH}/screens/a.png`]: "x" } }), /FAIL I1 .*`screens\/a\.png` does not belong in a run directory/);
    for (const [dir, re] of [
      ["integration-check/2026/02/30/example-program-m1", /does not name a real calendar date/],
      ["integration-check/2026/10/18/Example_Program", /`Example_Program` is not `<project-slug>-m<n>`/],
    ] as const) {
      const repo = initRepo();
      const base = git(repo, "rev-parse", "HEAD");
      cpSync(icFixture("ic-golden"), join(repo, dir), { recursive: true });
      const run = await runCli(["--pr", "--offline", "--repo", repo, "--base", base, "--head", commitAll(repo, "bad dir")]);
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stdout, re);
    }
  });

  it("I1: a run already on the base branch is never edited", async () => {
    const run = await runCli(prArgs(icPr("ic-golden", { onBase: true }), ["--offline"]));
    assert.equal(run.status, 1);
    assert.match(run.stdout, new RegExp(`FAIL I1 .*\`${RUN_PATH}\` already exists on the base branch`));
    assert.match(run.stdout, /is modified — an integration-check PR only adds files/);
  });

  it("--ic checks immutability against a base branch too", async () => {
    const repo = initRepo();
    cpSync(icFixture("ic-golden"), join(repo, RUN), { recursive: true });
    commitAll(repo, "merged run");
    const r = await lintIc(readIcDir(join(repo, RUN), "main"), { online: false });
    assert.match(text(r.failures), /^I1 .*already exists on the base branch \(main\)/m);
  });

  it("I2: a report whose task is not the PR branch's is refused", async () => {
    const run = await runCli(prArgs(icPr("ic-golden")), branchEnv("TASK-3001"));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /FAIL I2 .*`task` is `TASK-3000` but the pull request's branch is `TASK-3001`/);
  });

  it("a PR that touches none of plans/, knowledge-base/ or integration-check/ is still 'nothing to lint'", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "# r\n\nmore\n");
    const run = await runCli(["--pr", "--repo", repo, "--base", base, "--head", commitAll(repo, "readme")]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /nothing to lint/);
  });
});

describe("I6's statusOf is §4.1's (c4)", () => {
  type Row = { steps: Array<[IntegrationReport["steps"][number]["id"], string]>; criteria: string[]; neighbours: string[]; want: string };
  const report = (row: Row): IntegrationReport =>
    ({
      steps: row.steps.map(([id, verdict]) => ({ id, verdict, evidence: [], detail: "" })),
      criteria: row.criteria.map((verdict, i) => ({ id: `c${i + 1}`, verdict, evidence: [], detail: "" })),
      neighbours: row.neighbours.map((verdict, i) => ({ id: `n${i + 1}`, kind: "route", target: "/", verdict, evidence: [], detail: "" })),
    }) as unknown as IntegrationReport;
  const rows: Row[] = [
    { steps: [["build", "pass"], ["start", "pass"]], criteria: ["pass", "pass"], neighbours: ["pass"], want: "SUCCESS" },
    { steps: [["build", "pass"], ["start", "pass"]], criteria: ["pass"], neighbours: ["unverified"], want: "SUCCESS" },
    { steps: [["build", "pass"], ["start", "pass"]], criteria: [], neighbours: [], want: "SUCCESS" },
    { steps: [["build", "pass"], ["start", "pass"]], criteria: ["pass", "unverified"], neighbours: [], want: "UNCERTAIN" },
    { steps: [["build", "pass"], ["start", "pass"]], criteria: ["pass", "skipped"], neighbours: [], want: "UNCERTAIN" },
    { steps: [["build", "pass"], ["start", "unverified"]], criteria: ["pass"], neighbours: [], want: "UNCERTAIN" },
    { steps: [["build", "pass"]], criteria: ["pass"], neighbours: [], want: "UNCERTAIN" },
    { steps: [["build", "fail"], ["start", "unverified"]], criteria: ["unverified"], neighbours: [], want: "FAILED" },
    { steps: [["build", "pass"], ["start", "pass"]], criteria: ["pass"], neighbours: ["fail"], want: "FAILED" },
    { steps: [["build", "pass"], ["start", "pass"]], criteria: ["fail", "unverified"], neighbours: [], want: "FAILED" },
    { steps: [["start", "fail"]], criteria: ["pass"], neighbours: [], want: "FAILED" },
  ];
  for (const row of rows) {
    it(`${JSON.stringify(row.steps)} · criteria ${JSON.stringify(row.criteria)} · neighbours ${JSON.stringify(row.neighbours)} → ${row.want}`, () => {
      assert.equal(statusOf(report(row)), row.want);
    });
  }

  it("is the design's function, line for line", () => {
    const source = readFileSync(new URL("../rules.ts", import.meta.url), "utf8");
    const design = [
      'export function statusOf(r: IntegrationReport): "SUCCESS" | "UNCERTAIN" | "FAILED" {',
      "  const verdicts = [...r.steps, ...r.criteria, ...r.neighbours].map((x) => x.verdict);",
      '  if (verdicts.includes("fail")) return "FAILED";',
      '  const started = r.steps.find((s) => s.id === "start")?.verdict === "pass";',
      '  if (!started || r.criteria.some((c) => c.verdict !== "pass")) return "UNCERTAIN";',
      '  return "SUCCESS";',
      "}",
    ].join("\n");
    assert.ok(source.includes(design), "rules.ts carries §4.1's statusOf verbatim (with `export`)");
  });

  it("I6 refuses a declared status other than statusOf's, and a fail with no failure", async () => {
    const failed = (s: string) =>
      s.replace("status: SUCCESS", "status: FAILED").replace(
        "  - id: c2\n    verdict: pass\n    evidence: [evidence/tests.log]\n",
        "  - id: c2\n    verdict: fail\n    evidence: [evidence/tests.log]\n",
      );
    let f = await failuresOf(variant(failed));
    assert.deepEqual(rulesOf(f), ["I6"], text(f));
    assert.match(text(f), /criterion `c2` is `fail` but carries no `failure`/);
    f = await failuresOf(variant((s) => failed(s).replace("    detail: \"The contract test", "    failure: { what: The contract test fails, suggestedFix: Document the 2.x keys, paths: [docs/config/contract.md] }\n    detail: \"The contract test")));
    assert.deepEqual(f, []);
    f = await failuresOf(variant((s) => s.replace("id: start, verdict: pass", "id: start, verdict: unverified").replace("couldntVerify:\n", "couldntVerify:\n  - { id: u2, kind: app_start, what: The app, why: No database, howToCheck: Confirm the recipe }\n")));
    assert.match(text(f), /^I6 `status` is `SUCCESS` but the verdicts make it `UNCERTAIN`/m);
  });
});

describe("I2–I9 edges", () => {
  it("I2: milestone.n other than the directory's; repeated ids; an all-digit sha", async () => {
    assert.match(text(await failuresOf(variant((s) => s.replace("n: 1,", "n: 2,")))), /^I2 `milestone\.n` is 2 but the directory names `m1`$/m);
    assert.match(text(await failuresOf(variant((s) => s.replace("  - id: c2\n", "  - id: c1\n")))), /^I2 criterion id `c1` appears twice$/m);
    assert.match(text(await failuresOf(variant((s) => s.replace("{ id: n2,", "{ id: n1,")))), /^I2 neighbour id `n1` appears twice$/m);
    assert.match(text(await failuresOf(variant((s) => s.replace(`sha: "${IC_SHA}"`, `sha: ${"1".repeat(40)}`)))), /sha must be string — YAML reads an all-digit value as a number; quote it/);
  });

  it("I3: a verdict for a criterion the milestone does not have; a project that does not resolve; Alissa down is 'could not run'", async () => {
    const extra = variant((s) => s.replace("neighbours:\n", "  - { id: c9, verdict: pass, evidence: [evidence/tests.log], detail: extra }\nneighbours:\n"));
    let f = await failuresOf(extra, online());
    assert.deepEqual(rulesOf(f), ["I3"], text(f));
    assert.match(text(f), /a verdict for criterion `c9`, which milestone `q0000000000000000000000000000001` does not have/);
    f = await failuresOf(variant((s) => s.replace("project: p0000000000000000000000000000001", "project: p0000000000000000000000000000404")), online());
    assert.match(text(f), /^I3 project `p0000000000000000000000000000404` does not resolve/m);
    const down = await lintIc(readIcDir(icFixture("ic-golden"), null), { online: true, reader: httpReader({ base: "http://127.0.0.1:9", token: TOKEN, retries: 0 }) });
    assert.deepEqual(rulesOf(down.failures), ["I3", "I9"]);
    assert.ok(down.failures.every((x) => x.couldNotRun));
    assert.match(reportIc(down).title, new RegExp(`^plan-lint could not run — I3 \\(every criterion has a verdict\\) — `));
    assert.equal(reportIc(down).conclusion, "failure");
  });

  it("I4: a pass with no evidence; a cite outside evidence/; an evidence file nothing cites; a draft recipe that is not a file", async () => {
    assert.match(text(await failuresOf(variant((s) => s.replace("id: build, verdict: pass, evidence: [evidence/build.log]", "id: build, verdict: pass, evidence: []"))))
      , /step `build` is `pass` but cites no evidence/);
    assert.match(text(await failuresOf(variant((s) => s.replace("evidence: [evidence/build.log]", "evidence: [evidence/build.log, report.md]")))), /cites `report\.md`, which is not under the run's `evidence\/`/);
    const f = await failuresOf(variant((s) => s, { "evidence/extra.txt": "nobody cites me\n" }));
    assert.deepEqual(rulesOf(f), ["I4"]);
    assert.match(text(f), /`evidence\/extra\.txt` is cited by no verdict, step, item or recipe/);
    assert.match(text(await failuresOf(variant((s) => s.replace("state: confirmed, path: .alissa/verify.yml", "state: draft, path: evidence/verify.draft.yml")))), /the draft recipe of `example-org\/service-b` cites `evidence\/verify\.draft\.yml`, which is not a file of the run/);
    assert.deepEqual(
      await failuresOf(variant((s) => s.replace("state: confirmed, path: .alissa/verify.yml", "state: draft, path: evidence/verify.draft.yml"), { "evidence/verify.draft.yml": "schema: alissa-verify/v1\n" })),
      [],
      "a draft recipe in evidence/ counts as cited",
    );
  });

  it("I5: an unverified criterion with no item; an item with no why or no howToCheck; an unverified step with an empty list", async () => {
    let f = await failuresOf(variant((s) => s.replace("status: SUCCESS", "status: UNCERTAIN").replace("  - id: c2\n    verdict: pass\n    evidence: [evidence/tests.log]\n", "  - id: c2\n    verdict: unverified\n    evidence: []\n")));
    assert.deepEqual(rulesOf(f), ["I5"], text(f));
    assert.match(text(f), /criterion `c2` is `unverified` but no Couldn't verify item names it/);
    assert.deepEqual(await failuresOf(variant((s) => s.replace("status: SUCCESS", "status: UNCERTAIN").replace("  - id: c2\n    verdict: pass\n", "  - id: c2\n    verdict: unverified\n    unverified: u1\n"))), []);
    f = await failuresOf(variant((s) => s.replace('    why: "No real phone or native app runs in the fleet."\n', "")));
    assert.match(text(f), /^I5 Couldn't verify item `u1` gives no `why`/m);
    f = await failuresOf(variant((s) => s.replace(/    howToCheck: .*\n/, '    howToCheck: "  "\n')));
    assert.match(text(f), /^I5 Couldn't verify item `u1` gives no `howToCheck`/m);
    f = await failuresOf(variant((s) => s.replace(/couldntVerify:\n(?:    .*\n|  - .*\n)*?steps:/, "couldntVerify: []\nsteps:")));
    assert.match(text(f), /^I5 neighbour `n2` is `unverified` but the Couldn't verify list is empty$/m);
  });

  it("I7: an evidence file over 2 MB, more than 60 files, a report over 48 KB", async () => {
    let f = await failuresOf(variant((s) => s.replace("evidence: [evidence/build.log]", "evidence: [evidence/build.log, evidence/big.png]"), { "evidence/big.png": Buffer.alloc(IC_LIMITS.evidenceFileBytes + 1) }));
    assert.deepEqual(rulesOf(f), ["I7"], text(f));
    assert.match(text(f), /is 2097153 bytes; an evidence file is at most 2097152/);
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`evidence/s${i}.txt`] = "x\n";
    const names = Object.keys(many);
    const cite = (s: string) =>
      s.replace("evidence: [evidence/build.log]", `evidence: [evidence/build.log, ${names.slice(0, 30).join(", ")}]`)
        .replace("evidence: [evidence/tests.log], detail: \"2 covering", `evidence: [evidence/tests.log, ${names.slice(30).join(", ")}], detail: "2 covering`);
    f = await failuresOf(variant(cite, many));
    assert.deepEqual(rulesOf(f), ["I7"], text(f));
    assert.match(text(f), /the run holds 67 evidence files; at most 60/);
    f = await failuresOf(variant((s) => `${s}\n${"word ".repeat(10_000)}\n`));
    assert.deepEqual(rulesOf(f), ["I7"]);
    assert.match(text(f), /report\.md is \d+ bytes; the limit is 49152/);
    assert.deepEqual([...IC_EVIDENCE_TYPES], ["png", "jpg", "webp", "log", "txt", "json", "yml"]);
  });

  it("I8: secret-shaped text in a log is refused, and the secret is never printed", async () => {
    // Built at run time so that no secret-shaped literal is ever committed.
    const key = ["AK", "IA", "Z".repeat(16)].join("");
    const f = await failuresOf(variant((s) => s, { "evidence/start.log": `listening on 127.0.0.1:3000\nAWS key ${key}\n` }));
    assert.deepEqual(rulesOf(f), ["I8"]);
    assert.match(text(f), /secret-shaped text on line\(s\) 2/);
    assert.equal(f[0]?.file, "evidence/start.log");
    assert.doesNotMatch(text(f), new RegExp(key));
  });

  it("I9: reads that differ from the task's Alissa-Reads, either way, and a task that does not resolve", async () => {
    let f = await failuresOf(variant((s) => s.replace(`sha: "${IC_SHA}"`, `sha: "${"b".repeat(40)}"`)), online());
    assert.deepEqual(rulesOf(f), ["I9"], text(f));
    assert.match(text(f), /Alissa-Reads pins `7c1e4b2a/);
    f = await failuresOf(variant((s) => s.replace("reads:\n", `reads:\n  - { repo: example-org/service-c, sha: "${IC_SHA}" }\n`)), online());
    assert.match(text(f), /^I9 `reads` names `example-org\/service-c`, which `TASK-3000` does not read/m);
    const saved = api.kb.tasks["TASK-3000"] as KbWorld["tasks"][string];
    api.kb.tasks["TASK-3000"] = { ...saved, reads: `example-org/service-b@${IC_SHA}\nAlissa-Reads: example-org/service-a@${IC_SHA}` };
    try {
      f = await failuresOf(icFixture("ic-golden"), online());
      assert.match(text(f), /^I9 `TASK-3000`'s Alissa-Reads names `example-org\/service-a`, which `reads` leaves out$/m);
    } finally {
      api.kb.tasks["TASK-3000"] = saved;
    }
    f = await failuresOf(variant((s) => s.replace("task: TASK-3000", "task: TASK-4040")), online());
    assert.match(text(f), /^I9 `TASK-4040` does not resolve/m);
  });
});

describe("lint/VERSION — the integration-check stamp (§3.5)", () => {
  const stamp = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of readFileSync(new URL("../VERSION", import.meta.url), "utf8").split("\n")) {
      const m = /^([a-z0-9-]+): (.+)$/.exec(line);
      if (m) out[m[1] as string] = m[2] as string;
    }
    return out;
  };

  it("reads modes: plan knowledge-base integration-check, the ic-rules line and the report schema", () => {
    const s = stamp();
    assert.equal(s.modes, "plan knowledge-base integration-check");
    assert.equal(s["ic-rules"], "I1 I2 I3 I4 I5 I6 I7 I8 I9");
    assert.deepEqual((s["ic-rules"] ?? "").split(" "), Object.keys(I_RULE_NAMES));
    const schema = JSON.parse(readFileSync(new URL("../../schema/integration-check.v1.json", import.meta.url), "utf8")) as { properties: { schema: { const: string } } };
    assert.equal(s["ic-schema"], schema.properties.schema.const);
  });
});
