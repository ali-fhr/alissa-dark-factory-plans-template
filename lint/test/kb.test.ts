// The knowledge-base mode (design alissa-build-discovery §3.4, lane DS-2): c1 a knowledge-base-only
// PR is linted, never "nothing to lint"; c2 one fixture per K rule fails exactly that rule; c3 a mix
// of plans/ and knowledge-base/ is refused by K1; c4 K7 with the verify route down reports "plan-lint
// could not run", a failure; the review's (a) a design task's one assessment is admitted, (b) the
// inlined deny-list, (c) K6's creation-day check.
//
// Findings v1.1 (design §2.2, §2.5, §3.4, §3.6, §4.6, lane DS-10): c1 every v1 fixture still passes
// byte-for-byte; c2 one fixture per K8 verdict (`refuted`, `gone`, `blocked`, `unavailable` → could
// not run) fails exactly K8, and an `archived` one passes; c3 a URL cite on a task without
// `Alissa-Sources: web | both` fails K6; c4 the `Discovery-Review:` line; c5 the stamp; c6 `project
// | bodyOfWork` is a `oneOf`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { reportKb } from "../plan-lint.ts";
import {
  KB_ARCHIVE_HOSTS, KB_DENY_PATTERNS, KB_TOKEN_SHAPE_SOURCES, type KRule, K_RULE_NAMES, discoveryReviewLine, findingsSchema, isDeniedPath, kRulesRan, lintKb, secretShapedLines,
  svgRefusals, taskOfBranch,
} from "../rules.ts";
import { parseFrontmatter, splitFrontmatter } from "../markdown.ts";
import { readKbDir } from "../source.ts";
import {
  type FakeAlissa, KB_CREATED, KB_SHA, TOKEN, caseNames, cliEnv, commitAll, fakeAlissa, fixturePlan, git, initRepo, kbFixture, kbOnlineAgainst, runCli, tempDir,
} from "./helpers.ts";

let api: FakeAlissa;
before(async () => {
  api = await fakeAlissa();
});
after(async () => {
  await api.close();
});

/** One fixture per K rule, each failing exactly its rule; `kb-k8-archived` is K8's passing case. */
const kbCases = caseNames().filter((n) => /^kb-k\d-/.test(n) && n !== "kb-k8-archived");
const ruleOf = (name: string): KRule => {
  const m = /^kb-(k[1-8])-[a-z0-9-]+$/.exec(name);
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

/** A findings file's frontmatter, parsed as the linter parses it. */
const yamlOf = (text: string): unknown => {
  const split = splitFrontmatter(text);
  assert.ok(split.ok);
  const parsed = parseFrontmatter(split.frontmatter);
  assert.ok(parsed.ok);
  return parsed.value;
};

const prArgs = (pr: { repo: string; base: string; head: string }, extra: string[] = []) => ["--pr", "--repo", pr.repo, "--base", pr.base, "--head", pr.head, ...extra];

describe("knowledge-base fixtures (c2)", () => {
  it("has the golden findings, the assessment, one fixture per K rule and one per failing K8 verdict", () => {
    assert.deepEqual(kbCases.map(ruleOf), ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K8", "K8", "K8"]);
    assert.deepEqual(kbCases.filter((n) => n.startsWith("kb-k8-")), ["kb-k8-blocked", "kb-k8-gone", "kb-k8-refuted", "kb-k8-unavailable"]);
    for (const n of ["kb-golden", "kb-golden-web", "kb-assessment", "kb-k8-archived"]) assert.ok(caseNames().includes(n), n);
  });

  for (const name of ["kb-golden", "kb-golden-web"]) {
    it(`${name} passes K1–K9`, async () => {
      const r = await lintCase(name);
      assert.deepEqual(r.failures, []);
      assert.deepEqual(r.rulesRun, ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9"]);
      assert.equal(r.questionCount, 2);
    });
  }

  for (const name of kbCases) {
    const rule = ruleOf(name);
    // `unavailable` is K8's "could not run": a failure, never a pass, and never a refusal of the finding.
    const couldNotRun = name === "kb-k8-unavailable";
    it(`${name} fails ${rule} (${K_RULE_NAMES[rule]}) and no other rule`, async () => {
      const r = await lintCase(name);
      assert.ok(r.failures.length > 0, "expected a failure");
      assert.deepEqual([...new Set(r.failures.map((f) => f.rule))], [rule], JSON.stringify(r.failures, null, 2));
      if (couldNotRun) assert.ok(r.failures.every((f) => f.couldNotRun === true), "a run that could not happen");
      else assert.ok(r.failures.every((f) => !f.couldNotRun), "a refusal, not a run that could not happen");
    });

    it(`${name}: the CLI exits ${couldNotRun ? 3 : 1} and the verdict names ${rule}`, async () => {
      const run = await runCli(["--kb", kbFixture(name), "--no-base"], cliEnv(api));
      assert.equal(run.status, couldNotRun ? 3 : 1, run.stdout + run.stderr);
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
    assert.match(await messages("kb-k8-refuted"), /^URL cite `https:\/\/docs\.example\.com\/limits` is refuted: the page answers, and neither it nor an archive holds the quote/);
    assert.match(await messages("kb-k8-gone"), /^URL cite `https:\/\/docs\.example\.com\/removed-page` is gone \(404 or 410\), and no archive holds the quote/);
    assert.match(await messages("kb-k8-blocked"), /^URL cite `https:\/\/docs\.example\.com\/members-only` is blocked — .*; supply an archive or another source/);
    assert.match(await messages("kb-k8-unavailable"), /^plan-lint could not run: URL cite `https:\/\/docs\.example\.com\/flaky` is unavailable \(a 5xx or a timeout\)/);
  });

  it("offline runs K1–K5 and K9 only; the K6, K7 and K8 fixtures pass them", async () => {
    for (const name of ["kb-golden", "kb-golden-web", "kb-k6-task", "kb-k7-cites", "kb-k8-refuted", "kb-k8-gone", "kb-k8-blocked", "kb-k8-unavailable", "kb-k8-archived"]) {
      const run = await runCli(["--kb", kbFixture(name), "--no-base", "--offline"]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /knowledge-base mode — [12] question\(s\) — K1–K5, K9$/m);
      assert.match(run.stdout, /K6–K8 not run \(offline\)/);
    }
  });

  it("online without ALISSA_API_TOKEN it refuses to run rather than skip K6–K8", async () => {
    const run = await runCli(["--kb", kbFixture("kb-golden"), "--no-base"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /K6–K8 need ALISSA_API_TOKEN/);
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

  it("route unreachable: the CLI exits 3 and the check output says 'plan-lint could not run'", async () => {
    const out = join(tempDir("kb-down"), "check.json");
    const run = await runCli(["--kb", kbFixture("kb-golden"), "--no-base", "--check-output", out], { ALISSA_API_TOKEN: TOKEN, ALISSA_BASE: "http://127.0.0.1:9" });
    assert.equal(run.status, 3, run.stdout + run.stderr);
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
    api.urlVerifyBodies.length = 0;
    const r = await lintKb(readKbDir(dir, null), kbOnlineAgainst(api));
    assert.deepEqual(r.failures, []);
    assert.equal(api.verifyBodies.length, 0);
    assert.equal(api.urlVerifyBodies.length, 0);
    assert.ok(r.notes.includes("K7: the findings cite no repository file"));
    assert.ok(r.notes.includes("K8: the findings cite no page"));
  });
});

describe("--pr in the knowledge-base mode (c1, c3)", () => {
  it("c1: a knowledge-base-only PR is linted — never 'nothing to lint'", async () => {
    const pr = kbPr("kb-golden");
    const out = join(tempDir("kb-pr"), "check.json");
    const run = await runCli(prArgs(pr, ["--check-output", out]), cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /nothing to lint/);
    assert.match(run.stdout, /^plan-lint: knowledge-base\/2026\/10\/14\/TASK-1234 — knowledge-base mode — 2 question\(s\) — K1–K9$/m);
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

describe("findings v1.1 — the URL cite, K8 and the review line (DS-10)", () => {
  const webGolden = () => readFileSync(join(kbFixture("kb-golden-web"), "findings.md"), "utf8");
  const golden = () => readFileSync(join(kbFixture("kb-golden"), "findings.md"), "utf8");
  /** A variant of a fixture's findings, written under its own task's directory. */
  const variantDir = (text: string, task: string): string => {
    const dir = join(tempDir("kb-v11"), "knowledge-base", "2026", "10", "14", task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "findings.md"), text);
    return dir;
  };
  const offline = async (text: string, task = "TASK-1240") => (await lintKb(readKbDir(variantDir(text, task), null), { online: false })).failures;
  const online = async (text: string, task = "TASK-1240") => lintKb(readKbDir(variantDir(text, task), null), kbOnlineAgainst(api));
  const rulesOf = (f: Array<{ rule: string }>) => [...new Set(f.map((x) => x.rule))];
  const said = (f: Array<{ rule: string; message: string }>) => f.map((x) => `${x.rule} ${x.message}`).join("\n");
  const withTask = async <T>(task: string, patch: Partial<FakeAlissa["kb"]["tasks"][string]>, run: () => Promise<T>): Promise<T> => {
    const saved = api.kb.tasks[task];
    api.kb.tasks[task] = { ...(saved as FakeAlissa["kb"]["tasks"][string]), ...patch };
    try {
      return await run();
    } finally {
      api.kb.tasks[task] = saved as FakeAlissa["kb"]["tasks"][string];
    }
  };

  it("c1: every v1 fixture is byte-for-byte the one v1's linter shipped, and still lints as before", async () => {
    const pinned: Record<string, string> = {
      "kb-golden": "ad1803d675780a8ac626e753e31604660df4fc40b23bc34fb1e783186635eaa7",
      "kb-k1-layout": "e0336708ed6e9ad1eca805771fe7e9b5507ba25d587d0fb59aa22829abaec580",
      "kb-k2-frontmatter": "b5d79042ee3d7727b963221e3bd0eada7098e0c1aee73bf60f06615eed8964d7",
      "kb-k3-completeness": "6795ea5cce934003919b2b585d00ccaba87208bd6d3b187eea5db811376efb81",
      "kb-k4-size": "f980f2d214e71cf63a0fb5f52f66ff2194248e42a90d24c4d6e52d2803b57393",
      "kb-k5-hygiene": "821039311856b1c266a691be2a1c3b3cfd36d0dd2768da185e2ee874e47db891",
      "kb-k6-task": "ff53fa94f545a963d6f5c85ce7dfafd278afa9b40ddbc43b5845d7429de75e88",
      "kb-k7-cites": "c259d945ab411142613f46a88912b5c54b1042c4adc9bf823324840577624eee",
    };
    for (const [name, sha] of Object.entries(pinned)) {
      const text = readFileSync(join(kbFixture(name), "findings.md"));
      assert.equal(createHash("sha256").update(text).digest("hex"), sha, `${name} is unchanged`);
      assert.match(text.toString("utf8"), /^schema: alissa-findings\/v1$/m, `${name} is a v1 file`);
    }
    // The golden passes and each K fixture fails exactly its rule — the suite above, run over these same bytes.
    assert.deepEqual((await lintCase("kb-golden")).failures, []);
  });

  it("c2: the archived verdict passes, says so, and the projection's stale reading is named", async () => {
    const r = await lintCase("kb-k8-archived");
    assert.deepEqual(r.failures, []);
    assert.ok(r.notes.some((n) => /^K8: URL cite `https:\/\/docs\.example\.com\/changed` holds only in its archive `https:\/\/web\.archive\.org\/web\/20261014100230\/.*` — it passes, and the projection marks it stale/.test(n)), r.notes.join("\n"));
  });

  it("c2: each verdict's fixture fails K8 through the CLI, and unavailable reads 'plan-lint could not run'", async () => {
    for (const [name, title] of [
      ["kb-k8-refuted", /^FAIL — K8 \(external cites hold\) — knowledge-base — /],
      ["kb-k8-gone", /^FAIL — K8 \(external cites hold\) — knowledge-base — /],
      ["kb-k8-blocked", /^FAIL — K8 \(external cites hold\) — knowledge-base — /],
      ["kb-k8-unavailable", /^plan-lint could not run — K8 \(external cites hold\) — /],
    ] as const) {
      const out = join(tempDir("kb-k8"), "check.json");
      const run = await runCli(["--kb", kbFixture(name), "--no-base", "--check-output", out], cliEnv(api));
      assert.equal(run.status, name === "kb-k8-unavailable" ? 3 : 1, run.stdout + run.stderr);
      const check = JSON.parse(readFileSync(out, "utf8")) as { conclusion: string; title: string };
      assert.equal(check.conclusion, "failure");
      assert.match(check.title, title, name);
    }
    const run = await runCli(["--kb", kbFixture("kb-k8-archived"), "--no-base"], cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("K8 posts each distinct URL cite once — url, quote and archive, never retrievedAt — and repo cites go to K7 alone", async () => {
    api.verifyBodies.length = 0;
    api.urlVerifyBodies.length = 0;
    assert.deepEqual((await lintCase("kb-golden-web")).failures, []);
    assert.equal(api.urlVerifyBodies.length, 1);
    const cites = (api.urlVerifyBodies[0] as { cites: Array<Record<string, string>> }).cites;
    assert.deepEqual(cites.map((c) => Object.keys(c).sort()), [["archive", "quote", "url"], ["quote", "url"]]);
    assert.deepEqual(cites.map((c) => c.url), ["https://docs.example.com/webhooks/retries", "https://status.example.com/history"]);
    const files = (api.verifyBodies[0] as { files: Array<Record<string, string>> }).files;
    assert.deepEqual(files.map((f) => f.path), ["src/config/load.ts"]);
    api.urlVerifyBodies.length = 0;
    await lintCase("kb-golden");
    assert.equal(api.urlVerifyBodies.length, 0, "a repo-only finding posts no URL cite");
  });

  for (const [mode, why] of [[503, /answered 503/], [404, /answered 404/], ["bad-shape", /unexpected shape/]] as const) {
    it(`K8's route ${mode}: "plan-lint could not run", a failure and never a pass`, async () => {
      api.urlVerify = mode;
      try {
        const r = await lintCase("kb-golden-web");
        assert.deepEqual(r.failures.map((f) => [f.rule, f.couldNotRun]), [["K8", true]]);
        assert.match(r.failures[0]?.message ?? "", why);
        assert.match(reportKb(r).title, /^plan-lint could not run — K8 \(external cites hold\) — /);
      } finally {
        api.urlVerify = "up";
      }
    });
  }

  it("c3: a URL cite on a task without Alissa-Sources: web | both fails K6, and only K6", async () => {
    for (const sources of [undefined, "code"]) {
      const r = await withTask("TASK-1240", { sources }, () => lintCase("kb-golden-web"));
      assert.deepEqual(rulesOf(r.failures), ["K6"], said(r.failures));
      assert.match(said(r.failures), /the findings carry 2 URL cite\(s\), but `TASK-1240` reads `sources: code` \(no `Alissa-Sources: web` or `both`\)/);
    }
    const r = await withTask("TASK-1240", { sources: "pages" }, () => lintCase("kb-golden-web"));
    assert.match(said(r.failures), /^K6 `TASK-1240` carries `Alissa-Sources: pages` — it is `code`, `web` or `both`/);
    assert.deepEqual((await withTask("TASK-1240", { sources: "web" }, () => lintCase("kb-golden-web"))).failures, []);
  });

  it("K6: Alissa-Reads: none matches an empty reads, and refuses a finding that names a read", async () => {
    assert.deepEqual((await lintCase("kb-k8-archived")).failures, [], "TASK-1805 carries Alissa-Reads: none and reads: []");
    const r = await withTask("TASK-1240", { reads: "none" }, () => lintCase("kb-golden-web"));
    assert.deepEqual(rulesOf(r.failures), ["K6"]);
    assert.match(said(r.failures), /carries `Alissa-Reads: none`, but `reads` names `example-org\/service-b`/);
  });

  it("K6: an ask's asker resolves to a task of the same owner, and agrees with the task's Alissa-Asker", async () => {
    let r = await withTask("TASK-1200", { ownerId: "j57someoneelse000000000000000001" }, () => lintCase("kb-golden-web"));
    assert.match(said(r.failures), /^K6 the asker `TASK-1200` belongs to another owner than `TASK-1240` — an ask never crosses owners/);
    r = await online(webGolden().replace("asker: TASK-1200", "asker: TASK-4041"));
    assert.match(said(r.failures), /the asker `TASK-4041` does not resolve/);
    assert.match(said(r.failures), /was asked by `TASK-1200` \(its Alissa-Asker\), but the finding's `asker` is `TASK-4041`/);
    r = await online(webGolden().replace("asker: TASK-1200\n", ""));
    assert.deepEqual(rulesOf(r.failures), ["K6"]);
    assert.match(said(r.failures), /the finding's `asker` is absent/);
  });

  it("c4: the review line — none for a repo-only finding below high impact, light naming its reasons otherwise", async () => {
    const lineOf = async (text: string, task = "TASK-1234") => {
      const r = await lintKb(readKbDir(variantDir(text, task), null), { online: false });
      return r.review === null ? null : discoveryReviewLine(r.review);
    };
    const repoOnlyNoHigh = golden().replace("impact: high", "impact: medium");
    assert.equal(await lineOf(repoOnlyNoHigh), "Discovery-Review: none");
    // §3.6: a `high`-impact question gets the light round even when every cite is a repo cite (§12 Q11's DEFAULT).
    assert.equal(await lineOf(golden()), "Discovery-Review: light — high impact: q1");
    assert.equal(await lineOf(webGolden(), "TASK-1240"), "Discovery-Review: light — external cites: 2");
    assert.equal(await lineOf(webGolden().replace("impact: low", "impact: high"), "TASK-1240"), "Discovery-Review: light — external cites: 2; high impact: q2");
    // Findings too malformed to classify carry no line: a reader takes a missing line as light.
    const r = await lintKb(readKbDir(variantDir("no frontmatter\n", "TASK-1234"), null), { online: false });
    assert.equal(r.review, null);
  });

  it("c4: the CLI ends its output and the check summary with the review line; --pr does too", async () => {
    const out = join(tempDir("kb-review"), "check.json");
    let run = await runCli(["--kb", kbFixture("kb-golden-web"), "--no-base", "--offline", "--check-output", out]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout.trimEnd().split("\n").at(-1), "Discovery-Review: light — external cites: 2");
    const check = JSON.parse(readFileSync(out, "utf8")) as { summary: string };
    assert.equal(check.summary.split("\n").at(-1), "Discovery-Review: light — external cites: 2");
    run = await runCli(prArgs(kbPr("kb-golden")), cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout.trimEnd().split("\n").at(-1), "Discovery-Review: light — high impact: q1");
    run = await runCli(["--kb", kbFixture("kb-assessment"), "--no-base", "--offline"]);
    assert.doesNotMatch(run.stdout, /Discovery-Review:/, "an assessment is not a finding");
  });

  it("c6: a finding carries exactly one of project and bodyOfWork — both, or neither, fails the schema", async () => {
    const validate = findingsSchema();
    const both = webGolden().replace("bodyOfWork: b57c0000000000000000000000000001", "bodyOfWork: b57c0000000000000000000000000001\nproject: j57c0000000000000000000000000001");
    const neither = webGolden().replace("bodyOfWork: b57c0000000000000000000000000001\n", "");
    for (const [text, why] of [[both, /carries both `project` and `bodyOfWork`/], [neither, /carries neither `project` nor `bodyOfWork`/]] as const) {
      const f = await offline(text);
      assert.deepEqual(f.map((x) => x.rule), ["K2"], said(f));
      assert.match(said(f), why);
    }
    const fm = (text: string) => (yamlOf(text) as Record<string, unknown>);
    assert.equal(validate(fm(both)), false);
    assert.ok(validate.errors?.some((e) => e.keyword === "oneOf" && e.instancePath === ""));
    assert.equal(validate(fm(neither)), false);
    assert.equal(validate(fm(webGolden())), true, JSON.stringify(validate.errors));
  });

  it("a v1 file keeps v1's shape: a project, at least one read, no URL cite, no asker", async () => {
    const v1 = (s: string) => s.replace("schema: alissa-findings/v1.1", "schema: alissa-findings/v1");
    let f = await offline(v1(webGolden()));
    assert.match(said(f), /\/questions\/0\/cites\/0 is a URL cite — it needs `schema: alissa-findings\/v1\.1`/);
    assert.match(said(f), /\/bodyOfWork is not allowed|must have required property 'project'/);
    f = await offline(golden().replace(/reads:\n.*\n.*\n/, "reads: []\n").replace(/ {4}cites:\n(?: {6}- .*\n)+/, "").replace("status: answered", "status: partial").replace(/risks:\n(?:.*\n)*?suggestedTasks:/, "suggestedTasks:"), "TASK-1234");
    assert.match(said(f), /\/reads must NOT have fewer than 1 items/);
  });

  it("K2: the URL cite's shape — https, a real retrievedAt between the task's day and now, a verbatim quote, a trusted archive", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["url: https://docs.example.com/webhooks/retries", "url: http://docs.example.com/webhooks/retries", /\/url must match pattern/],
      ['retrievedAt: "2026-10-14T10:02:11Z"', 'retrievedAt: "2026-02-30T10:02:11Z"', /`retrievedAt` `2026-02-30T10:02:11Z` is not a real RFC 3339 time in UTC/],
      ['retrievedAt: "2026-10-14T10:02:11Z"', 'retrievedAt: "2026-10-13T23:59:59Z"', /is before the task's creation day, 2026-10-14/],
      ['retrievedAt: "2026-10-14T10:02:11Z"', 'retrievedAt: "2999-01-01T00:00:00Z"', /`retrievedAt` `2999-01-01T00:00:00Z` is in the future/],
      ['retrievedAt: "2026-10-14T10:02:11Z"', 'retrievedAt: "2026-10-14 10:02:11"', /\/retrievedAt must match pattern/],
      ['quote: "Failed deliveries are retried with exponential backoff for up to three days."', 'quote: "Up to three days."', /\/quote must NOT have fewer than 20 characters/],
      ["archive: https://web.archive.org/web/20261014100230/", "archive: https://mirror.example.net/20261014100230/", /is on mirror\.example\.net, which is not an archive host K8 trusts \(web\.archive\.org, archive\.ph\)/],
      ["archive: https://web.archive.org/web/20261014100230/", "archive: https://web.archive.org/save/", /is not a web\.archive\.org capture/],
      ["kind: url\n        url: https://docs", "kind: page\n        url: https://docs", /\/kind must be equal to constant/],
    ];
    for (const [from, to, why] of cases) {
      const text = webGolden().replace(from, to);
      assert.notEqual(text, webGolden(), from);
      const f = await offline(text);
      assert.deepEqual(rulesOf(f), ["K2"], `${to}\n${said(f)}`);
      assert.match(said(f), why, to);
    }
    assert.deepEqual([...KB_ARCHIVE_HOSTS], ["web.archive.org", "archive.ph"]);
    const source = readFileSync(new URL("../rules.ts", import.meta.url), "utf8");
    assert.ok(source.includes("studio.alissa.app `convex/core/urlCites.ts`"), "the archive list names where it is copied from");
  });

  it("K2: a repo cite still names a read repository when reads is empty", async () => {
    const f = await offline(webGolden().replace(/reads:\n.*\n.*\n/, "reads: []\n"));
    assert.match(said(f), /^K2 a cite names `example-org\/service-b`, which is not in `reads`/);
  });

  it("K4: at most 48 URL cites across the file; K5: no credential in a URL or an archive", async () => {
    const cite = (i: number) => `      - { kind: url, url: "https://docs.example.com/p${i}", retrievedAt: "2026-10-14T10:00:00Z", quote: "A sentence of twenty characters or more." }\n`;
    const risk = (k: number) => `  - text: r${k}\n    severity: low\n    cites:\n${Array.from({ length: 17 }, (_, i) => cite(k * 100 + i)).join("")}`;
    let f = await offline(webGolden().replace("risks:\n", `risks:\n${[1, 2, 3].map(risk).join("")}`));
    assert.deepEqual(rulesOf(f), ["K4"], said(f));
    assert.match(said(f), /carries 53 URL cites; at most 48, across questions and risks/);
    for (const [from, to, why] of [
      ["url: https://docs.example.com/webhooks/retries", "url: https://user:pw@docs.example.com/webhooks/retries", /a URL cite carries userinfo/],
      ["url: https://docs.example.com/webhooks/retries", "url: https://docs.example.com/webhooks/retries?access_token=abc", /a URL cite carries a token-shaped query parameter \(`access_token`\)/],
      ["/https://docs.example.com/webhooks/retries\n", `/https://docs.example.com/webhooks/retries?x=${"a1".repeat(24)}\n`, /an archive carries a token-shaped query parameter value/],
    ] as const) {
      f = await offline(webGolden().replace(from, to));
      assert.deepEqual(rulesOf(f), ["K5"], `${to}\n${said(f)}`);
      assert.match(said(f), why);
      assert.doesNotMatch(said(f), /pw@|abc|a1a1a1/, "the credential itself is never printed");
    }
  });

  it("K3: a question answered from a page alone is admitted", async () => {
    assert.deepEqual((await lintCase("kb-k8-archived")).failures, []);
  });
});

describe("schema v1.3 in a plan — sources, a web task's repo, an ask's milestone", () => {
  const webTask = (edit: (s: string) => string = (s) => s): string => {
    const dir = join(tempDir("web-plan"), "2026-09-28-golden-plan");
    cpSync(fixturePlan("golden"), dir, { recursive: true });
    const task = join(dir, "tasks", "config-contract-notes.md");
    const fm = readFileSync(task, "utf8")
      .replace("repo: example-org/service-a\n", "")
      .replace("scope:\n  - docs/config/contract.md\n  - README.md\n", "kind: discovery\nquestions:\n  - { id: q1, text: Which config formats do comparable services document?, unblocks: [{ decision: Whether the notes need a format section, impact: medium }] }\n")
      .replace("sources:\n  - drift:config-contract:2.0\n", "sources: web\n");
    writeFileSync(task, edit(fm));
    return dir;
  };

  it("a `sources: web` discovery task names no repo; --write renders it as `web`, and rules 1–12 and 5b pass", async () => {
    const dir = webTask();
    let run = await runCli(["--write", dir, "--no-base", "--offline"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /^- `config-contract-notes` — .* \(web, doc-correction\)$/m);
    run = await runCli([dir, "--no-base"], cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^plan-lint: PASS$/m);
  });

  it("a discovery task reading code names its repo; `sources` takes code | web | both or source keys", async () => {
    let run = await runCli([webTask((s) => s.replace("sources: web", "sources: code")), "--no-base", "--offline"]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 2 \(frontmatter\) — tasks\/config-contract-notes\.md: frontmatter \(root\) must have required property 'repo'/);
    run = await runCli([webTask((s) => s.replace("sources: web", "sources: pages")), "--no-base", "--offline"]);
    assert.match(run.stdout, /rule 2 .*\/sources must be equal to one of the allowed values: code, web, both/);
  });

  it("`asker` lets a discovery task omit its milestone — admitted by the schema, refused in a plan by rule 10", async () => {
    const dir = webTask((s) => s.replace("milestone: b0000000000000000000000000000001\n", "asker: TASK-101\n"));
    let run = await runCli(["--write", dir, "--no-base", "--offline"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    run = await runCli([dir, "--no-base"], cliEnv(api));
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 10 \(anchor\) — tasks\/config-contract-notes\.md: the task names no `milestone` — schema v1\.3 omits it only on a project-less ask/);
    run = await runCli([webTask((s) => s.replace("milestone: b0000000000000000000000000000001\n", "")), "--no-base", "--offline"]);
    assert.match(run.stdout, /FAIL rule 2 .*must have required property 'milestone'/);
  });

  it("a code task carries neither `asker` nor a discovery `sources`", async () => {
    const dir = join(tempDir("code-plan"), "2026-09-28-golden-plan");
    cpSync(fixturePlan("golden"), dir, { recursive: true });
    const task = join(dir, "tasks", "config-contract-notes.md");
    writeFileSync(task, readFileSync(task, "utf8").replace("commitClass: doc-correction\n", "commitClass: doc-correction\nasker: TASK-101\n"));
    const run = await runCli([dir, "--no-base", "--offline"]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL rule 2 .*\/asker is not allowed on this kind of task/);
  });
});

// Discovery evidence EV-1 (operator decision 2026-10-20): a finding may carry a flat `evidence/`
// folder. c1 the golden finding with a cited png and csv passes; c2 K9 refuses an uncited file and
// a dangling cite, K1 a nested path and a disallowed type, K4 the size caps and K1 an active svg —
// each by name; c3 K5 scans text evidence, and the integration-check mode is untouched (ic.test.ts).
describe("evidence/ — K1 types, K4 caps, K5 scan, K9 cites (EV-1)", () => {
  const EV_TASK = "TASK-1300";
  before(() => {
    api.kb.tasks[EV_TASK] = { kind: "discovery", createdAt: Date.UTC(2026, 9, 20, 8, 0), reads: `example-org/service-b@${KB_SHA}` };
  });
  /** A copy of the golden evidence finding, to edit; `edit` gets the directory. */
  const variant = (edit: (dir: string) => void): string => {
    const dir = join(tempDir("kb-ev"), "knowledge-base", "2026", "10", "20", EV_TASK);
    cpSync(kbFixture("kb-evidence"), dir, { recursive: true });
    edit(dir);
    return dir;
  };
  const appendBody = (dir: string, line: string): void => writeFileSync(join(dir, "findings.md"), `${readFileSync(join(dir, "findings.md"), "utf8")}\n${line}\n`);
  const offline = async (dir: string) => (await lintKb(readKbDir(dir, null), { online: false })).failures;
  const only = (f: Array<{ rule: string; file?: string; message: string }>, rule: KRule, file: string, re: RegExp): void => {
    assert.deepEqual([...new Set(f.map((x) => x.rule))], [rule], JSON.stringify(f, null, 2));
    assert.ok(f.some((x) => x.file === file && re.test(x.message)), JSON.stringify(f, null, 2));
  };

  it("c1: the golden finding — a cited png and csv — passes K1–K9, through --kb and --pr", async () => {
    const r = await lintCase("kb-evidence");
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.rulesRun, ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9"]);
    const run = await runCli(["--kb", kbFixture("kb-evidence"), "--no-base"], cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /K1–K9$/m);
    const pr = await runCli(prArgs(kbPr("kb-evidence")), cliEnv(api));
    assert.equal(pr.status, 0, pr.stdout + pr.stderr);
    assert.match(pr.stdout, /^plan-lint: knowledge-base\/2026\/10\/20\/TASK-1300 — knowledge-base mode — 2 question\(s\) — K1–K9$/m);
    const off = await runCli(["--kb", kbFixture("kb-evidence"), "--no-base", "--offline"]);
    assert.equal(off.status, 0, off.stdout);
    assert.match(off.stdout, /— K1–K5, K9$/m);
  });

  it("c2: K9 refuses an uncited evidence file, naming it", async () => {
    only(await offline(variant((d) => writeFileSync(join(d, "evidence", "extra.txt"), "a stray note\n"))), "K9", "evidence/extra.txt", /is never cited/);
  });

  it("c2: K9 refuses a dangling cite, inline or in a question's cites", async () => {
    only(await offline(variant((d) => appendBody(d, "The old page [evidence:settings-1280.png]."))), "K9", "findings.md", /`evidence:settings-1280\.png` is cited, but `evidence\/settings-1280\.png` is not in the folder/);
    only(await offline(variant((d) => rmSync(join(d, "evidence", "counts.csv")))), "K9", "findings.md", /`evidence:counts\.csv` is cited/);
  });

  it("c2: K1 refuses a nested path, a disallowed type, a bad name, a symlink and an image whose bytes are not its type", async () => {
    only(await offline(variant((d) => {
      mkdirSync(join(d, "evidence", "shots"));
      writeFileSync(join(d, "evidence", "shots", "a.png"), readFileSync(join(d, "evidence", "settings-1440.png")));
    })), "K1", undefined as unknown as string, /`evidence\/shots` is a nested path/);
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "run.exe"), "MZ");
      appendBody(d, "The tool [evidence:run.exe].");
    })), "K1", "evidence/run.exe", /is a `\.exe` file — evidence is png, jpg, jpeg, webp, svg, csv, json, mmd, d2, txt, log only/);
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "Notes.txt"), "x\n");
      appendBody(d, "The note [evidence:Notes.txt].");
    })), "K1", "evidence/Notes.txt", /is not named `\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}`/);
    only(await offline(variant((d) => symlinkSync("/etc/hostname", join(d, "evidence", "host.txt")))), "K1", undefined as unknown as string, /`evidence\/host\.txt` is a symbolic link/);
    only(await offline(variant((d) => writeFileSync(join(d, "evidence", "settings-1440.png"), "not an image\n"))), "K1", "evidence/settings-1440.png", /is named `\.png`, but its bytes are not a PNG/);
  });

  it("c2: K1 refuses an svg with a script, an event handler or an external href; an inert svg passes", async () => {
    const svg = (dir: string, body: string): void => {
      writeFileSync(join(dir, "evidence", "flow.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>\n`);
      appendBody(dir, "The flow [evidence:flow.svg].");
    };
    only(await offline(variant((d) => svg(d, "<script>alert(1)</script>"))), "K1", "evidence/flow.svg", /carrying a `<script>` element/);
    only(await offline(variant((d) => svg(d, `<rect onload="x()"/>`))), "K1", "evidence/flow.svg", /an event-handler attribute/);
    only(await offline(variant((d) => svg(d, `<a href="https://example.com/x"><text>x</text></a>`))), "K1", "evidence/flow.svg", /an `href` or `src` that leaves the file/);
    assert.deepEqual(await offline(variant((d) => svg(d, `<defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)"><animate attributeName="opacity" values="0;1" dur="2s"/></rect>`))), []);
    assert.deepEqual(svgRefusals(`<image xlink:href='data:image/png;base64,AAAA'/>`), ["an `href` or `src` that leaves the file (only `#fragment` links are admitted)"]);
  });

  // PR #8 round 1: the vectors the first svg check let through, one row each.
  it("c2: K1 refuses a prefixed script, a DTD, a `/`-separated handler, href animation, foreignObject and src", async () => {
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "flow.svg"), `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>\n`);
      appendBody(d, "The flow [evidence:flow.svg].");
    })), "K1", "evidence/flow.svg", /carrying a `<script>` element/);
    const rows: Array<[string, string]> = [
      [`<!DOCTYPE svg [<!ENTITY s "&#60;script>alert(1)&#60;/script>">]><svg xmlns="http://www.w3.org/2000/svg">&s;</svg>`, "a DTD (`<!DOCTYPE` or `<!ENTITY`)"],
      [`<svg/onload=alert(1)>`, "an event-handler attribute (`on…=`)"],
      [`<svg><rect title="a>b" onclick="x()"/></svg>`, "an event-handler attribute (`on…=`)"],
      [`<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`, "an animation that rewrites an `href`, `src` or `ping`"],
      [`<svg><a><set attributeName="xlink:href" to="https://evil.example/"/><text>x</text></a></svg>`, "an animation that rewrites an `href`, `src` or `ping`"],
      [`<svg><a><set attributeName="&#104;ref" to="#x"/><text>x</text></a></svg>`, "an animation that rewrites an `href`, `src` or `ping`"],
      [`<svg><rect><animate attributeName="fill" values="url(https://evil.example/p)"/></rect></svg>`, "an animation whose values hold a URL"],
      [`<svg><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/t.png"/></foreignObject></svg>`, "a `<foreignObject>` element"],
      [`<svg><h:img xmlns:h="http://www.w3.org/1999/xhtml"/></svg>`, "the XHTML namespace (HTML inside the svg)"],
      [`<svg><image src="https://evil.example/t.png"/></svg>`, "an `href` or `src` that leaves the file (only `#fragment` links are admitted)"],
    ];
    for (const [text, why] of rows) assert.ok(svgRefusals(text).includes(why), `${text} → ${JSON.stringify(svgRefusals(text))}`);
  });

  // PR #8 round 2: overlong and undecodable references, and the whole-text checks over decoded text.
  it("c2: K1 decodes every character reference before the svg checks, and refuses one it cannot decode", async () => {
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "flow.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="&#0000000104;ref" values="&#0000000106;avascript&#0000000058;alert(1)"/><text>x</text></a></svg>\n`);
      appendBody(d, "The flow [evidence:flow.svg].");
    })), "K1", "evidence/flow.svg", /an animation that rewrites an `href`, `src` or `ping`/);
    const ref = "a character reference that is not a well-formed XML one (`&#…;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`)";
    const esc = "a backslash (CSS escape) in an attribute or a style";
    const loads = "a style that loads from outside the file (`url(…)`, `image-set(…)` or `@import`)";
    const rows: Array<[string, string]> = [
      [`<svg><a><animate attributeName="&#0000000104;ref" values="&#0000000106;avascript&#0000000058;alert(1)"/><text>x</text></a></svg>`, "an animation whose values hold a URL"],
      [`<svg><a><set attributeName="&#x0000068;ref" to="&#x000006a;avascript&#x000003a;x"/><text>x</text></a></svg>`, "an animation that rewrites an `href`, `src` or `ping`"],
      [`<svg><a><set attributeName="&#x0000068;ref" to="&#x000006a;avascript&#x000003a;x"/><text>x</text></a></svg>`, "an animation whose values hold a URL"],
      [`<svg><a><set attributeName="&#x110000;ref" to="#x"/></a></svg>`, ref],
      [`<svg><a><set attributeName="&#00000000000000000000104;ref" to="#x"/></a></svg>`, "an animation that rewrites an `href`, `src` or `ping`"],
      [`<svg><a><set attributeName="href" to="&#106avascript:x"/></a></svg>`, ref],
      [`<svg><a><set attributeName="href" to="javascript&colon;x"/></a></svg>`, ref],
      [`<svg><text>&#0;</text></svg>`, ref],
      [`<svg><g xmlns:h="http&#x3a;//www.w3.org/1999/xhtml"><h:iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/></g></svg>`, "the XHTML namespace (HTML inside the svg)"],
      [`<svg><g xmlns:h="http&#x3a;//www.w3.org/1999/xhtml"><h:iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/></g></svg>`, "a `srcdoc` attribute (an HTML document inside the svg)"],
      [`<svg><rect style="fill:u&#114;l(https://evil.example/p.svg#a)"/></svg>`, loads],
      [`<svg><style>rect { fill: u&#114;l(https://evil.example/p.svg#a) }</style></svg>`, loads],
      [`<svg><style>&#64;import "https://evil.example/x.css";</style></svg>`, loads],
      [`<svg><rect style="fill:\\75rl(https://evil.example/p.svg#a)"/></svg>`, esc],
      [`<svg><style>rect { fill: \\75rl(https://evil.example/p.svg#a) }</style></svg>`, esc],
      [`<svg><style>@\\69mport "https://evil.example/x.css";</style></svg>`, esc],
      [`<svg><style>rect { fill: &#92;75rl(https://evil.example/p.svg#a) }</style></svg>`, esc],
      [`<svg><rect fill="\\75rl(https://evil.example/p.svg#a)"/></svg>`, esc],
      [`<svg><rect style="background:image-set(&quot;https://evil.example/p.png&quot; 1x)"/></svg>`, loads],
      [`<svg><style>rect { background: -webkit-image-set("https://evil.example/p.png" 1x) }</style></svg>`, loads],
      [`<svg><style>rect { background: image("https://evil.example/p.png") }</style></svg>`, "a style function with a quoted argument other than a `#fragment`"],
    ];
    for (const [text, why] of rows) assert.ok(svgRefusals(text).includes(why), `${text} → ${JSON.stringify(svgRefusals(text))}`);
    // Ordinary charts still pass: the five XML references, numeric ones, a bare `&`, a style with url(#id).
    assert.deepEqual(svgRefusals(`<svg xmlns="http://www.w3.org/2000/svg"><style>.a { fill: url("#g"); font-family: "Inter", sans-serif }</style><text>p &lt; 0.05 &amp; n &#8805; 30 &#x2014; R&D</text><rect class="a" style="opacity:0.5"/></svg>`), []);
  });

  // PR #8 round 3: presentation attributes are CSS, and the URL parser strips whitespace inside a quoted url().
  it("c3: K1 refuses a presentation attribute whose quoted url() starts with whitespace", async () => {
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "flow.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(' https://evil.example/p.svg#a')"/></svg>\n`);
      appendBody(d, "The flow [evidence:flow.svg].");
    })), "K1", "evidence/flow.svg", /a style that loads from outside the file/);
    const quoted = "a style function with a quoted argument other than a `#fragment`";
    const loads = "a style that loads from outside the file (`url(…)`, `image-set(…)` or `@import`)";
    const inputs = [
      `<svg><rect fill="url(' https://evil.example/p.svg#a')"/></svg>`,
      `<svg><rect filter="url(&quot; https://evil.example/f.svg#f&quot;)"/></svg>`,
      `<svg><rect cursor="url(' https://evil.example/c.png'), auto"/></svg>`,
      `<svg><path marker-start="url('&#9;https://evil.example/m.svg#m')"/></svg>`,
      `<svg><rect mask="url('\thttps://evil.example/k.svg#k')"/></svg>`,
    ];
    for (const text of inputs) {
      const got = svgRefusals(text);
      assert.ok(got.includes(quoted) && got.includes(loads), `${text} → ${JSON.stringify(got)}`);
    }
    // Each half alone: the whole-text url( check (an unparsed processing instruction) and the attribute check.
    assert.ok(svgRefusals(`<?x url(' https://evil.example/p.svg')?><svg/>`).includes(loads));
    assert.ok(svgRefusals(`<svg><rect clip-path="image(' https://evil.example/p.png')"/></svg>`).includes(quoted));
    // A fragment with whitespace around it is still a fragment.
    assert.deepEqual(svgRefusals(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(' #g')" filter="url(#f)" mask="url( &quot;#m&quot; )"/></svg>`), []);
  });

  // PR #8 round 4: a quote inside a comment, CDATA section or PI merged the tags after it into one span, hiding an animation.
  it("c3: K1 refuses an href animation behind a quote in a comment, CDATA section or processing instruction", async () => {
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "flow.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><!-- Q1's numbers --><a><animate attributeName="href" values="https://evil.example/"/><text>x</text></a><!-- Q2's numbers --></svg>\n`);
      appendBody(d, "The flow [evidence:flow.svg].");
    })), "K1", "evidence/flow.svg", /an animation that rewrites an `href`, `src` or `ping`/);
    const rewrites = "an animation that rewrites an `href`, `src` or `ping`";
    const url = "an animation whose values hold a URL";
    const w = (s: string): string => `<svg xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
    const inputs = [
      `<!-- ' --><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a><!-- ' -->`,
      `<!-- Q1's numbers --><a><animate attributeName="href" values="https://evil.example/"/><text>x</text></a><!-- Q2's numbers -->`,
      `<![CDATA[ " ]]><a><set attributeName="xlink:href" to="javascript:alert(1)"/></a><![CDATA[ " ]]>`,
      `<?note ' ?><a><set attributeName="href" to="javascript:alert(1)"/></a><?note ' ?>`,
    ];
    for (const text of inputs) {
      const got = svgRefusals(w(text));
      assert.ok(got.includes(rewrites) && got.includes(url), `${text} → ${JSON.stringify(got)}`);
    }
    // Each half alone: the whole-text attributeName check (on no animation tag at all) and the blanked tag scan.
    assert.deepEqual(svgRefusals(w(`<rect attributeName = ' &#104;ref'/>`)), [rewrites]);
    assert.deepEqual(svgRefusals(w(`<!-- ' --><set attributeName="fill" to="javascript:alert(1)"/><!-- ' -->`)), [url]);
    // An unterminated carrier is blanked to the end; ordinary chart text with an apostrophe in a comment passes.
    assert.ok(svgRefusals(w(`<set attributeName="fill" to="javascript:x"/><!-- ' `)).includes(url));
    assert.deepEqual(svgRefusals(w(`<!-- Q1's numbers --><rect><animate attributeName="opacity" values="0;1" dur="1s"/></rect><![CDATA[ it's ]]><?note ' ?>`)), []);
  });

  it("c3: K1 refuses any element that is not an SVG element (HTML breakout tags), `srcset` and `ping`", async () => {
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "flow.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><table background="https://evil.example/t.png"></table></svg>\n`);
      appendBody(d, "The flow [evidence:flow.svg].");
    })), "K1", "evidence/flow.svg", /an element that is not an SVG element \(`<table>`\)/);
    const foreign = (...names: string[]): string => `an element that is not an SVG element (${names.map((n) => `\`<${n}>\``).join(", ")})`;
    const srcset = "a `srcset` attribute (a fetch from outside the file)";
    const w = (s: string): string => `<svg xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
    // The reviewer's three inputs.
    assert.deepEqual(svgRefusals(w(`<img srcset="https://evil.example/t.png 1x"/>`)), [foreign("img"), srcset]);
    assert.deepEqual(svgRefusals(w(`<meta http-equiv="refresh" content="0;url=https://evil.example/"/>`)), [foreign("meta")]);
    assert.deepEqual(svgRefusals(w(`<table background="https://evil.example/t.png"></table>`)), [foreign("table")]);
    // Case, a prefix, a font breakout, an end-tag breakout (`</p>` makes a <p>, named without its slash), a tag hidden in a comment, and srcset on an SVG element.
    assert.deepEqual(svgRefusals(w(`<IMG src="#a"/>`)), [foreign("IMG")]);
    assert.deepEqual(svgRefusals(w(`<s:embed/>`)), [foreign("s:embed")]);
    assert.deepEqual(svgRefusals(w(`<font color="red">x</font>`)), [foreign("font")]);
    assert.deepEqual(svgRefusals(w(`<text>a</p>b</text>`)), [foreign("p")]);
    assert.deepEqual(svgRefusals(w(`<!--><img/>-->`)), [foreign("img")]);
    assert.deepEqual(svgRefusals(w(`<image srcset="#a 1x" href="#a"/>`)), [srcset]);
    // `ping` on a hyperlink (SVG 2): refused by name, prefixed or not, hidden past a comment quote too; the word in chart text passes.
    const ping = "a `ping` attribute (a fetch from outside the file)";
    assert.deepEqual(svgRefusals(w(`<a href="#g" ping="https://evil.example/beacon"><text>x</text></a>`)), [ping]);
    assert.deepEqual(svgRefusals(w(`<a href="#g" PING="#g" x:ping="#g"><text>x</text></a>`)), [ping]);
    assert.deepEqual(svgRefusals(w(`<!-- ' --><a href="#g" ping="https://evil.example/b"><text>x</text></a><!-- ' -->`)), [ping]);
    assert.deepEqual(svgRefusals(w(`<text>ping = 20 ms</text><rect data-ping="1"/>`)), []);
    // An animation that sets `ping` is refused whatever its value: a relative one passes the URL check yet still POSTs to the serving host.
    const pingAnim = "an animation that rewrites an `href`, `src` or `ping`";
    assert.deepEqual(svgRefusals(w(`<a href="#g"><set attributeName="ping" to="beacon"/><text>x</text></a>`)), [pingAnim]);
    assert.deepEqual(svgRefusals(w(`<a href="#g"><animate attributeName="x:PING" values="a;b" dur="1s"/></a>`)), [pingAnim]);
    assert.deepEqual(svgRefusals(w(`<!-- ' --><a href="#g"><set attributeName="&#112;ing" to="beacon"/></a><!-- ' -->`)), [pingAnim]);
    assert.deepEqual(svgRefusals(w(`<rect attributeName = ' ping'/>`)), [pingAnim]);
    // A name that only starts with `ping` is not `ping`.
    assert.deepEqual(svgRefusals(w(`<rect><set attributeName="pings" to="1"/></rect>`)), []);
    assert.deepEqual(svgRefusals(w(`<b/><i/><u/><s/><p/><div/>`)), [`an element that is not an SVG element (\`<b>\`, \`<i>\`, \`<u>\`, \`<s>\`, \`<p>\`, …)`]);
    // An ordinary chart: mixed-case SVG names, gradients, a filter, markers, text paths, animations.
    assert.deepEqual(svgRefusals(w(`<defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect/></clipPath><filter id="f"><feGaussianBlur stdDeviation="2"/><feMerge><feMergeNode/></feMerge></filter><marker id="m"><path d="M0 0"/></marker></defs><g clip-path="url(#c)"><polyline points="0,0 1,1"/><text><tspan>p &lt; 0.05</tspan><textPath href="#p">x</textPath></text><circle><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s"/></circle><use href="#m"/></g><title>t</title><desc>d</desc>`)), []);
  });

  it("c2: K1 refuses text evidence that is not UTF-8, so neither scan is blinded", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "utf16le")]);
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "flow.svg"), utf16);
      appendBody(d, "The flow [evidence:flow.svg].");
    })), "K1", "evidence/flow.svg", /starts with a UTF-16 or UTF-32 byte-order mark/);
    only(await offline(variant((d) => writeFileSync(join(d, "evidence", "counts.csv"), Buffer.from([0x6b, 0x2c, 0xc3, 0x28, 0x0a])))), "K1", "evidence/counts.csv", /is not valid UTF-8/);
    only(await offline(variant((d) => writeFileSync(join(d, "evidence", "counts.csv"), "k,v\na,\u0000\n"))), "K1", "evidence/counts.csv", /holds a NUL byte/);
    assert.deepEqual(await offline(variant((d) => writeFileSync(join(d, "evidence", "counts.csv"), "\ufeffk,v\na,1\n"))), []);
  });

  it("K9: `evidence:` inside a URL, a path or a longer word is not a cite", async () => {
    assert.deepEqual(await offline(variant((d) => appendBody(d, "See https://host.example/evidence:foo.png and a.evidence:bar.png and x:evidence:baz.png."))), []);
  });

  it("c2: K4 caps a file at 2 MB, the folder at 10 MB and 20 files, by name", async () => {
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "big.log"), "x".repeat(2 * 1024 * 1024 + 1));
      appendBody(d, "The log [evidence:big.log].");
    })), "K4", "evidence/big.log", /is 2097153 bytes; an evidence file is at most 2097152/);
    const total = await offline(variant((d) => {
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(d, "evidence", `part-${i}.log`), "x".repeat(1900 * 1024));
        appendBody(d, `Part [evidence:part-${i}.log].`);
      }
    }));
    assert.deepEqual([...new Set(total.map((f) => f.rule))], ["K4"]);
    assert.match(total.map((f) => f.message).join("\n"), /the evidence is \d+ bytes in all; at most 10485760/);
    const many = await offline(variant((d) => {
      for (let i = 0; i < 19; i++) {
        writeFileSync(join(d, "evidence", `n-${i}.txt`), "n\n");
        appendBody(d, `Note [evidence:n-${i}.txt].`);
      }
    }));
    assert.deepEqual(many.map((f) => `${f.rule} ${f.message}`), ["K4 the finding carries 21 evidence files; at most 20"]);
  });

  it("c3: K5 scans every text evidence file for secrets, and names the file but never the secret", async () => {
    const key = ["AK", "IA", "Z".repeat(16)].join("");
    const f = await offline(variant((d) => writeFileSync(join(d, "evidence", "counts.csv"), `key,value\nAWS_KEY,${key}\n`)));
    only(f, "K5", "evidence/counts.csv", /secret-shaped text on line\(s\) 2/);
    assert.doesNotMatch(JSON.stringify(f), new RegExp(key));
    only(await offline(variant((d) => {
      writeFileSync(join(d, "evidence", "trace.json"), `{"token": "${["gh", "p_", "A".repeat(36)].join("")}"}\n`);
      appendBody(d, "The trace [evidence:trace.json].");
    })), "K5", "evidence/trace.json", /secret-shaped text on line\(s\) 1/);
  });

  it("K2: a frontmatter evidence cite needs schema v1.2, and names a well-formed file", async () => {
    const v11 = await offline(variant((d) => writeFileSync(join(d, "findings.md"), readFileSync(join(d, "findings.md"), "utf8").replace("alissa-findings/v1.2", "alissa-findings/v1.1"))));
    assert.deepEqual([...new Set(v11.map((f) => f.rule))], ["K2"], JSON.stringify(v11));
    assert.match(v11.map((f) => f.message).join("\n"), /\/questions\/0\/cites\/1 is an evidence cite — it needs `schema: alissa-findings\/v1\.2`/);
    const bad = await offline(variant((d) => writeFileSync(join(d, "findings.md"), readFileSync(join(d, "findings.md"), "utf8").replace("file: counts.csv }", "file: ../counts.csv }"))));
    assert.ok(bad.some((f) => f.rule === "K2" && /\/questions\/0\/cites\/1\/file must match pattern/.test(f.message)), JSON.stringify(bad));
  });

  it("--pr: an evidence file is added like findings.md; a nested path or a file beside evidence/ is refused by K1", async () => {
    const dir = "knowledge-base/2026/10/20/TASK-1300";
    const nested = await runCli(prArgs(kbPr("kb-evidence", { also: { [`${dir}/evidence/shots/a.txt`]: "x\n", [`${dir}/notes.md`]: "x\n" } }), ["--offline"]));
    assert.equal(nested.status, 1, nested.stdout);
    assert.match(nested.stdout, /K1 \(layout and immutability\): `evidence\/shots\/a\.txt` is a nested path/);
    assert.match(nested.stdout, /`notes\.md` does not belong in a findings directory — it holds `findings\.md` and, optionally, `evidence\/<file>` \(flat\)/);
  });

  it("the report names the rules a run made, with gaps", () => {
    assert.equal(kRulesRan(["K1", "K2", "K3", "K4", "K5", "K9"]), "K1–K5, K9");
    assert.equal(kRulesRan(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9"]), "K1–K9");
    assert.equal(kRulesRan(["K1", "K5"]), "K1, K5");
    assert.equal(kRulesRan(["K1", "K4", "K5"]), "K1, K4, K5");
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
    const findings = JSON.parse(readFileSync(new URL("../../schema/findings.v1.json", import.meta.url), "utf8")) as { properties: { schema: { enum: string[] } } };
    assert.equal(s["findings-schema"], findings.properties.schema.enum.at(-1), "the stamp names the newest findings schema the linter reads");
    assert.deepEqual((s["kb-rules"] ?? "").split(" "), Object.keys(K_RULE_NAMES));
    assert.ok(readFileSync(new URL("../rules.ts", import.meta.url), "utf8").includes(`REPO_CONTEXT_FILTER_VERSION \`${s["kb-deny-list"]}\``));
  });
});
