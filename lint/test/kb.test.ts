// The knowledge-base mode (design alissa-build-discovery §3.4, lane DS-2): c1 a knowledge-base-only
// PR is linted, never "nothing to lint"; c2 one fixture per K rule fails exactly that rule; c3 a mix
// of plans/ and knowledge-base/ is refused by K1; c4 K7 with the verify route down reports "plan-lint
// could not run", a failure; the review's (a) a design task's one assessment is admitted, (b) the
// inlined deny-list, (c) K6's creation-day check.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { reportKb } from "../plan-lint.ts";
import { KB_DENY_PATTERNS, KB_TOKEN_SHAPE_SOURCES, type KRule, K_RULE_NAMES, isDeniedPath, lintKb, secretShapedLines, taskOfBranch } from "../rules.ts";
import { readKbDir } from "../source.ts";
import {
  type FakeAlissa, KB_CREATED, TOKEN, caseNames, cliEnv, commitAll, fakeAlissa, fixturePlan, git, initRepo, kbFixture, kbOnlineAgainst, runCli, tempDir,
} from "./helpers.ts";

let api: FakeAlissa;
before(async () => {
  api = await fakeAlissa();
});
after(async () => {
  await api.close();
});

const kbCases = caseNames().filter((n) => /^kb-k\d-/.test(n));
const ruleOf = (name: string): KRule => {
  const m = /^kb-(k[1-7])-[a-z0-9-]+$/.exec(name);
  assert.ok(m, `fixture case \`${name}\` is named kb-k<n>-<what>`);
  return (m[1] as string).toUpperCase() as KRule;
};
const lintCase = async (name: string, prTask: string | null = null) => lintKb(readKbDir(kbFixture(name), null), kbOnlineAgainst(api, prTask));

/** A repository whose PR branch adds the fixture case's knowledge-base tree. */
function kbPr(caseName: string, opts: { onBase?: boolean; plan?: boolean; also?: Record<string, string> } = {}): { repo: string; base: string; head: string } {
  const repo = initRepo();
  const add = (): void => cpSync(join(kbFixture(caseName).split("/knowledge-base/")[0] as string, "knowledge-base"), join(repo, "knowledge-base"), { recursive: true });
  if (opts.onBase) {
    add();
    commitAll(repo, "merged finding");
  }
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "TASK-1234-findings");
  if (opts.onBase) writeFileSync(join(kbFixture(caseName).replace(/^.*\/knowledge-base\//, `${repo}/knowledge-base/`), "findings.md"), "---\n---\nedited\n");
  else add();
  if (opts.plan) {
    mkdirSync(join(repo, "plans"), { recursive: true });
    cpSync(fixturePlan("golden"), join(repo, "plans", "2026-09-28-golden-plan"), { recursive: true });
  }
  for (const [path, text] of Object.entries(opts.also ?? {})) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return { repo, base, head: commitAll(repo, "pr") };
}

const prArgs = (pr: { repo: string; base: string; head: string }, extra: string[] = []) => ["--pr", "--repo", pr.repo, "--base", pr.base, "--head", pr.head, ...extra];

describe("knowledge-base fixtures (c2)", () => {
  it("has the golden finding, the assessment and exactly one fixture per K rule", () => {
    assert.deepEqual(kbCases.map(ruleOf), ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]);
    assert.ok(caseNames().includes("kb-golden"));
    assert.ok(caseNames().includes("kb-assessment"));
  });

  it("the golden finding passes K1–K7", async () => {
    const r = await lintCase("kb-golden");
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.rulesRun, ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]);
    assert.equal(r.questionCount, 2);
  });

  for (const name of kbCases) {
    const rule = ruleOf(name);
    it(`${name} fails ${rule} (${K_RULE_NAMES[rule]}) and no other rule`, async () => {
      const r = await lintCase(name);
      assert.ok(r.failures.length > 0, "expected a failure");
      assert.deepEqual([...new Set(r.failures.map((f) => f.rule))], [rule], JSON.stringify(r.failures, null, 2));
      assert.ok(r.failures.every((f) => !f.couldNotRun), "a refusal, not a run that could not happen");
    });

    it(`${name}: the CLI exits 1 and the verdict names ${rule}`, async () => {
      const run = await runCli(["--kb", kbFixture(name), "--no-base"], cliEnv(api));
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const verdict = run.stdout.split("\n").find((l) => l.startsWith("plan-lint: FAIL "));
      assert.ok(verdict?.startsWith(`plan-lint: FAIL ${rule} (${K_RULE_NAMES[rule]})`), run.stdout);
    });
  }

  it("each fixture is refused for its own reason", async () => {
    const messages = async (name: string) => (await lintCase(name)).failures.map((f) => f.message).join("\n");
    assert.match(await messages("kb-k1-layout"), /`notes\.md` does not belong in a findings directory/);
    assert.match(await messages("kb-k2-frontmatter"), /\/questions\/1\/status must be equal to one of the allowed values: answered, partial, unanswerable/);
    assert.match(await messages("kb-k3-completeness"), /question `q1` is `answered` but cites nothing/);
    assert.match(await messages("kb-k4-size"), /lines `1-600` spans 599 lines; at most 400/);
    assert.match(await messages("kb-k5-hygiene"), /`config\/\.env\.production`, a deny-listed path/);
    assert.match(await messages("kb-k6-task"), /`TASK-1306` is `kind: code`, not `discovery`/);
    assert.match(await messages("kb-k7-cites"), /cite `example-org\/service-b:src\/config\/load\.ts#L1-40` has a different blob at the pinned SHA/);
  });

  it("offline runs K1–K5 only; the K6 and K7 fixtures pass them", async () => {
    for (const name of ["kb-golden", "kb-k6-task", "kb-k7-cites"]) {
      const run = await runCli(["--kb", kbFixture(name), "--no-base", "--offline"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /knowledge-base mode — 2 question\(s\) — K1–K5$/m);
      assert.match(run.stdout, /K6–K7 not run \(offline\)/);
    }
  });

  it("online without ALISSA_API_TOKEN it refuses to run rather than skip K6–K7", async () => {
    const run = await runCli(["--kb", kbFixture("kb-golden"), "--no-base"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /K6–K7 need ALISSA_API_TOKEN/);
  });
});

describe("K7 through Studio's verify route (c4)", () => {
  it("posts each distinct cite once, at its reads SHA, with the lint token", async () => {
    api.verifyBodies.length = 0;
    await lintCase("kb-golden");
    assert.equal(api.verifyBodies.length, 1);
    const files = (api.verifyBodies[0] as { files: Array<Record<string, string>> }).files;
    assert.equal(files.length, 2, "the risk's cite repeats q1's and is sent once");
    for (const f of files) assert.deepEqual(Object.keys(f).sort(), ["blob", "lines", "path", "repo", "sha"]);
    assert.ok(files.every((f) => f.sha === "3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4"));
  });

  for (const [mode, why] of [[503, /answered 503/], [404, /answered 404/], ["bad-shape", /unexpected shape/]] as const) {
    it(`route ${mode}: "plan-lint could not run", a failure and never a pass`, async () => {
      api.verify = mode;
      try {
        const r = await lintCase("kb-golden");
        assert.deepEqual(r.failures.map((f) => [f.rule, f.couldNotRun]), [["K7", true]]);
        assert.match(r.failures[0]?.message ?? "", why);
        const rep = reportKb(r);
        assert.equal(rep.conclusion, "failure");
        assert.match(rep.title, /^plan-lint could not run — K7 \(cites resolve\) — /);
      } finally {
        api.verify = "up";
      }
    });
  }

  it("route unreachable: the CLI exits 1 and the check output says 'plan-lint could not run'", async () => {
    const out = join(tempDir("kb-down"), "check.json");
    const run = await runCli(["--kb", kbFixture("kb-golden"), "--no-base", "--check-output", out], { ALISSA_API_TOKEN: TOKEN, ALISSA_BASE: "http://127.0.0.1:9" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    const check = JSON.parse(readFileSync(out, "utf8")) as { conclusion: string; title: string };
    assert.equal(check.conclusion, "failure");
    assert.match(check.title, /^plan-lint could not run/);
  });

  it("a finding that cites nothing posts nothing", async () => {
    api.verifyBodies.length = 0;
    const dir = join(tempDir("kb-nocite"), "knowledge-base", "2026", "10", "14", "TASK-1234");
    mkdirSync(dir, { recursive: true });
    const text = readFileSync(join(kbFixture("kb-golden"), "findings.md"), "utf8");
    const noCites = text
      .replace(/ {4}cites:\n(?: {6}- .*\n)+/, "")
      .replace("status: answered", "status: partial")
      .replace(/risks:\n(?:.*\n)*?suggestedTasks:/, "suggestedTasks:");
    writeFileSync(join(dir, "findings.md"), noCites);
    const r = await lintKb(readKbDir(dir, null), kbOnlineAgainst(api));
    assert.deepEqual(r.failures, []);
    assert.equal(api.verifyBodies.length, 0);
    assert.ok(r.notes.includes("K7: the findings cite nothing"));
  });
});

describe("--pr in the knowledge-base mode (c1, c3)", () => {
  it("c1: a knowledge-base-only PR is linted — never 'nothing to lint'", async () => {
    const pr = kbPr("kb-golden");
    const out = join(tempDir("kb-pr"), "check.json");
    const run = await runCli(prArgs(pr, ["--check-output", out]), cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /nothing to lint/);
    assert.match(run.stdout, /^plan-lint: knowledge-base\/2026\/10\/14\/TASK-1234 — knowledge-base mode — 2 question\(s\) — K1–K7$/m);
    const check = JSON.parse(readFileSync(out, "utf8")) as { conclusion: string; title: string };
    assert.deepEqual(check, { ...check, conclusion: "success", title: "PASS — knowledge-base — knowledge-base/2026/10/14/TASK-1234" });
  });

  it("c1: a knowledge-base-only PR that is refused fails, offline too", async () => {
    const run = await runCli(prArgs(kbPr("kb-k3-completeness"), ["--offline"]));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /^plan-lint: FAIL K3 \(completeness\)/m);
  });

  it("c3: a mix of plans/ and knowledge-base/ is refused by K1", async () => {
    const run = await runCli(prArgs(kbPr("kb-golden", { plan: true }), ["--offline"]));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /^plan-lint: FAIL K1 \(layout and immutability\): the diff touches `plans\/2026-09-28-golden-plan\/plan\.md` — a knowledge-base PR never carries a plan/m);
  });

  it("K1: a file outside knowledge-base/ is refused", async () => {
    const run = await runCli(prArgs(kbPr("kb-golden", { also: { "lint/rules.ts": "// nope\n" } }), ["--offline"]));
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL K1 .*`lint\/rules\.ts` outside `knowledge-base\/`/);
  });

  it("K1: a second finding directory, a stray knowledge-base file, a bad date — each refused", async () => {
    const second = "knowledge-base/2026/10/14/TASK-1301/findings.md";
    let run = await runCli(prArgs(kbPr("kb-golden", { also: { [second]: "x\n" } }), ["--offline"]));
    assert.match(run.stdout, /FAIL K1 .*touches 2 knowledge-base directories/);
    run = await runCli(prArgs(kbPr("kb-golden", { also: { "knowledge-base/INDEX.md": "x\n" } }), ["--offline"]));
    assert.match(run.stdout, /FAIL K1 .*`knowledge-base\/INDEX\.md` — a finding lives in/);
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const dir = join(repo, "knowledge-base", "2026", "02", "30", "TASK-1234");
    mkdirSync(dir, { recursive: true });
    cpSync(join(kbFixture("kb-golden"), "findings.md"), join(dir, "findings.md"));
    run = await runCli(["--pr", "--offline", "--repo", repo, "--base", base, "--head", commitAll(repo, "bad date")]);
    assert.match(run.stdout, /FAIL K1 .*does not name a real calendar date/);
  });

  it("K1: a finding already on the base branch is never edited", async () => {
    const run = await runCli(prArgs(kbPr("kb-golden", { onBase: true }), ["--offline"]));
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL K1 .*`knowledge-base\/2026\/10\/14\/TASK-1234` already exists on the base branch/);
    assert.match(run.stdout, /is modified — a knowledge-base PR only adds files/);
  });

  it("a PR that touches neither plans/ nor knowledge-base/ is still 'nothing to lint'", async () => {
    const repo = initRepo();
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "# r\n\nmore\n");
    const run = await runCli(["--pr", "--repo", repo, "--base", base, "--head", commitAll(repo, "readme")]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /nothing to lint — no plans\/\*\* file changed/);
  });
});

describe("milestone 0's assessment (review fix a)", () => {
  const assessmentPr = (also: Record<string, string> = {}) => kbPr("kb-assessment", { also });

  it("a design task's single knowledge-base/assessments/*.md is admitted (its branch names the task)", async () => {
    const run = await runCli(prArgs(assessmentPr()), { ...cliEnv(api), GITHUB_HEAD_REF: "TASK-2000-assessment" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^plan-lint: knowledge-base\/assessments\/service-b-2026-10-14\.md — knowledge-base mode — assessment — K1, K5$/m);
    assert.match(run.stdout, /^plan-lint: PASS$/m);
  });

  it("--task names the PR's task as well, and --kb lints the file locally", async () => {
    const r = await lintCase("kb-assessment", "TASK-2000");
    assert.deepEqual(r.failures, []);
    const run = await runCli(["--kb", kbFixture("kb-assessment"), "--no-base", "--task", "TASK-2000"], cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("from a task that is not a design task, K1 refuses it", async () => {
    const run = await runCli(prArgs(assessmentPr()), { ...cliEnv(api), GITHUB_HEAD_REF: "TASK-2001-assessment" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL K1 .*`TASK-2001` is `kind: code` — only a design task adds a `knowledge-base\/assessments\/\*\.md` file/);
  });

  it("with no task to check, K1 refuses it online", async () => {
    const run = await runCli(prArgs(assessmentPr()), cliEnv(api));
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL K1 .*this run names none/);
  });

  it("anything alongside it is refused: a finding, a second assessment, a file elsewhere", async () => {
    const extras: Array<Record<string, string>> = [
      { "knowledge-base/2026/10/14/TASK-1234/findings.md": readFileSync(join(kbFixture("kb-golden"), "findings.md"), "utf8") },
      { "knowledge-base/assessments/service-c-2026-10-14.md": "# c\n" },
      { "README.md": "# r\n\nmore\n" },
    ];
    for (const also of extras) {
      const run = await runCli(prArgs(assessmentPr(also)), { ...cliEnv(api), GITHUB_HEAD_REF: "TASK-2000-assessment" });
      assert.equal(run.status, 1, JSON.stringify(also));
      assert.match(run.stdout, /FAIL K1 /);
    }
  });

  it("taskOfBranch reads the TASK-<n>-<DESC> grammar only", () => {
    assert.equal(taskOfBranch("TASK-2000-assessment"), "TASK-2000");
    assert.equal(taskOfBranch("task/TASK-2000-x"), null);
    assert.equal(taskOfBranch("PLAN-20260928T000000Z-x"), null);
    assert.equal(taskOfBranch(undefined), null);
  });
});

describe("K5's inlined deny-list (review fix b)", () => {
  it("is NT-2's list as widened by BC1, with its source and version named", () => {
    assert.deepEqual([...KB_DENY_PATTERNS], [
      ".env*", "*.pem", "*.key", "*.p12", "id_rsa*", "*secret*", "*credential*", ".npmrc", ".git/**", "**/node_modules/**",
      ".netrc", ".pypirc", "*.tfstate*", "*.keystore", "*.jks", "*.kdbx", ".aws/**", ".ssh/**", "*.p8",
    ]);
    const source = readFileSync(new URL("../rules.ts", import.meta.url), "utf8");
    for (const pin of ["studio.alissa.app `convex/core/repoContextFilter.ts`", "1f9b7a4bb788f79e7ac36175c5c193b4c2be7dc5", "REPO_CONTEXT_FILTER_VERSION `rcf1-0ebb8c65`"]) assert.ok(source.includes(pin), pin);
    assert.equal(KB_TOKEN_SHAPE_SOURCES.length, 20);
  });

  it("matches every pattern against each segment, case-insensitively", () => {
    for (const p of [
      ".env", "app/.env.local", "certs/server.pem", "tls.KEY", "a/b.p12", "home/id_rsa.pub", "config/Secrets.yml", "aws_credentials.json",
      ".npmrc", ".git/config", "vendor/x/.git/HEAD", "web/node_modules/a/index.js", ".netrc", ".pypirc", "infra/prod.tfstate.backup",
      "release.keystore", "app.jks", "vault.kdbx", ".aws/config", ".ssh/known_hosts", "AuthKey_ABC.p8",
    ]) assert.ok(isDeniedPath(p), p);
    for (const p of ["src/config/load.ts", "docs/environment.md", "src/keys.ts", "lib/gitignore.ts"]) assert.ok(!isDeniedPath(p), p);
  });

  it("finds secret-shaped text and names only its lines", () => {
    // Built at run time so that no secret-shaped literal is ever committed.
    const gh = ["gh", "p_", "A".repeat(36)].join("");
    const pem = ["-----BEGIN RSA PRIVATE", " KEY-----\nabc\n-----END RSA PRIVATE", " KEY-----"].join("");
    assert.deepEqual(secretShapedLines(`one\ntoken ${gh}\nthree\n${pem}\n`), [2, 4]);
    assert.deepEqual(secretShapedLines("loadConfig() reads the environment once."), []);
  });

  it("refuses a finding whose text carries one", async () => {
    const dir = join(tempDir("kb-secret"), "knowledge-base", "2026", "10", "14", "TASK-1234");
    mkdirSync(dir, { recursive: true });
    const key = ["AK", "IA", "Z".repeat(16)].join("");
    writeFileSync(join(dir, "findings.md"), `${readFileSync(join(kbFixture("kb-golden"), "findings.md"), "utf8")}\nThe deploy script embeds ${key}.\n`);
    const r = await lintKb(readKbDir(dir, null), { online: false });
    assert.deepEqual(r.failures.map((f) => f.rule), ["K5"]);
    assert.doesNotMatch(r.failures[0]?.message ?? "", new RegExp(key), "the secret itself is never printed");
  });
});

describe("K6 — the task (review fix c)", () => {
  const withTask = async (patch: Partial<FakeAlissa["kb"]["tasks"][string]>) => {
    const saved = api.kb.tasks["TASK-1234"];
    api.kb.tasks["TASK-1234"] = { ...(saved as FakeAlissa["kb"]["tasks"][string]), ...patch };
    try {
      // A fresh reader each time: answers are memoised per run.
      return (await lintCase("kb-golden")).failures;
    } finally {
      api.kb.tasks["TASK-1234"] = saved as FakeAlissa["kb"]["tasks"][string];
    }
  };

  it("refuses a directory dated other than the task's creation day (UTC)", async () => {
    const f = await withTask({ createdAt: KB_CREATED + 86_400_000 });
    assert.deepEqual(f.map((x) => x.rule), ["K6"]);
    assert.match(f[0]?.message ?? "", /created on 2026-10-15 \(UTC\), but its directory is dated 2026-10-14/);
  });

  it("the creation day is UTC: 23:59 UTC is still the same day", async () => {
    assert.deepEqual(await withTask({ createdAt: Date.UTC(2026, 9, 14, 23, 59) }), []);
  });

  it("refuses reads pinned at another SHA, and a task with no Alissa-Reads", async () => {
    let f = await withTask({ reads: `example-org/service-b@${"b".repeat(40)}` });
    assert.match(f.map((x) => `${x.rule} ${x.message}`).join("\n"), /^K6 .*Alissa-Reads pins `b{40}`/);
    f = await withTask({ reads: undefined });
    assert.match(f[0]?.message ?? "", /carries no `Alissa-Reads/);
  });

  it("refuses a task that does not resolve", async () => {
    const dir = join(tempDir("kb-404"), "knowledge-base", "2026", "10", "14", "TASK-4040");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "findings.md"), readFileSync(join(kbFixture("kb-golden"), "findings.md"), "utf8").replace("task: TASK-1234", "task: TASK-4040"));
    const r = await lintKb(readKbDir(dir, null), kbOnlineAgainst(api));
    assert.deepEqual(r.failures.map((f) => f.rule), ["K6"]);
    assert.match(r.failures[0]?.message ?? "", /`TASK-4040` does not resolve/);
  });
});

describe("K2 and K4 edges", () => {
  const variant = async (edit: (s: string) => string) => {
    const dir = join(tempDir("kb-var"), "knowledge-base", "2026", "10", "14", "TASK-1234");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "findings.md"), edit(readFileSync(join(kbFixture("kb-golden"), "findings.md"), "utf8")));
    return (await lintKb(readKbDir(dir, null), { online: false })).failures;
  };

  it("K2: task other than the directory's; a cite outside reads; a repeated question id", async () => {
    assert.match((await variant((s) => s.replace("task: TASK-1234", "task: TASK-9"))).map((f) => `${f.rule} ${f.message}`).join("\n"), /^K2 `task` is `TASK-9` but the directory is `TASK-1234`$/m);
    assert.match((await variant((s) => s.replace("cites: [{ repo: example-org/service-b,", "cites: [{ repo: other/repo,"))).map((f) => f.message).join("\n"), /`other\/repo`, which is not in `reads`/);
    assert.match((await variant((s) => s.replace(/blob: 9ad0[0-9a-f]+/, "blob: 1234567890123456789012345678901234567890"))).map((f) => f.message).join("\n"), /blob must be string — YAML reads an all-digit value as a number; quote it/);
    assert.match((await variant((s) => s.replace("  - id: q2", "  - id: q1"))).map((f) => f.message).join("\n"), /question id `q1` appears twice/);
  });

  it("K4: more than 12 questions is K4, not K2; an oversized Summary; a file over 32 KB", async () => {
    const q = (i: number) => `  - id: x${i}\n    text: t\n    status: unanswerable\n    confidence: low\n    reason: r\n    unblocks: [{ decision: d, impact: low }]\n`;
    let f = await variant((s) => s.replace("risks:\n", `${Array.from({ length: 11 }, (_, i) => q(i)).join("")}risks:\n`));
    assert.deepEqual([...new Set(f.map((x) => x.rule))], ["K4"], JSON.stringify(f));
    f = await variant((s) => s.replace("## Summary\n", `## Summary\n\n${"word ".repeat(260)}\n`));
    assert.deepEqual(f.map((x) => x.rule), ["K4"]);
    f = await variant((s) => `${s}\n${"x".repeat(33 * 1024)}\n`);
    assert.ok(f.some((x) => x.rule === "K4" && /bytes; the limit is 32768/.test(x.message)));
  });
});

describe("schema v1.2 in a plan", () => {
  const discoveryPlan = (edit: (s: string) => string = (s) => s): string => {
    const dir = join(tempDir("disc-plan"), "2026-09-28-golden-plan");
    cpSync(fixturePlan("golden"), dir, { recursive: true });
    const task = join(dir, "tasks", "config-contract-notes.md");
    const fm = readFileSync(task, "utf8").replace(
      "scope:\n  - docs/config/contract.md\n  - README.md\n",
      "kind: discovery\nquestions:\n  - { id: q1, text: Which config keys does service-a document today?, unblocks: [{ decision: Whether the notes need a rewrite, impact: high }] }\n",
    );
    writeFileSync(task, edit(fm));
    return dir;
  };

  it("a plan carrying a discovery task (no scope) passes rules 1–12 and 5b", async () => {
    const run = await runCli([discoveryPlan(), "--no-base"], cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^plan-lint: PASS$/m);
    assert.doesNotMatch(run.stdout, /warn:/);
  });

  it("a discovery task with a scope is refused by rule 2, one of another class by rule 6", async () => {
    let run = await runCli([discoveryPlan((s) => s.replace("kind: discovery\n", "kind: discovery\nscope:\n  - docs/config/contract.md\n")), "--no-base", "--offline"]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 2 \(frontmatter\) — tasks\/config-contract-notes\.md: frontmatter \/scope is not allowed on this kind of task/);
    assert.doesNotMatch(run.stdout, /must match "then" schema/);
    run = await runCli([discoveryPlan((s) => s.replace("commitClass: doc-correction", "commitClass: drift-fix")), "--no-base", "--offline"]);
    assert.match(run.stdout, /FAIL rule 6 \(class\) .*a discovery task is always `doc-correction`/);
  });
});

describe("lint/VERSION — the stamp Studio's plans-repo-kb-lint readiness check reads (§12 Q2)", () => {
  const stamp = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of readFileSync(new URL("../VERSION", import.meta.url), "utf8").split("\n")) {
      const m = /^([a-z0-9-]+): (.+)$/.exec(line);
      if (m) out[m[1] as string] = m[2] as string;
      else assert.equal(line, "", `every line is \`key: value\` (found \`${line}\`)`);
    }
    return out;
  };

  it("declares the knowledge-base mode and agrees with the schemas and rules it ships beside", () => {
    const s = stamp();
    assert.ok((s.modes ?? "").split(" ").includes("knowledge-base"));
    assert.ok((s.modes ?? "").split(" ").includes("plan"));
    assert.match(s["plan-lint-template"] ?? "", /^\d{4}-\d{2}-\d{2}$/);
    const task = JSON.parse(readFileSync(new URL("../../schema/task-frontmatter.v1.json", import.meta.url), "utf8")) as { title: string };
    assert.ok(task.title.endsWith(`version ${s["task-schema"]}`), task.title);
    const findings = JSON.parse(readFileSync(new URL("../../schema/findings.v1.json", import.meta.url), "utf8")) as { properties: { schema: { const: string } } };
    assert.equal(s["findings-schema"], findings.properties.schema.const);
    assert.deepEqual((s["kb-rules"] ?? "").split(" "), Object.keys(K_RULE_NAMES));
    assert.ok(readFileSync(new URL("../rules.ts", import.meta.url), "utf8").includes(`REPO_CONTEXT_FILTER_VERSION \`${s["kb-deny-list"]}\``));
  });
});
