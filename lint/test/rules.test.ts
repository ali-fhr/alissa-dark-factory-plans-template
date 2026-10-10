// Rule branches beyond the one-fixture-per-rule set: the other anchors, off-limits, fail-closed reads,
// the scope heuristics and the plan class.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { httpReader } from "../alissa.ts";
import { githubReader } from "../github.ts";
import { CLASS_ORDER, type RuleId, bodyProblems, lint, literalScopePath, overlaps, planClassOf, scopeProblem } from "../rules.ts";
import { readPlanDir } from "../source.ts";
import { type FakeAlissa, TOKEN, cliEnv, copyPlan, fakeAlissa, loadWorld, onlineAgainst, runCli, tempDir, type World } from "./helpers.ts";

const B1 = "b0000000000000000000000000000001";
const B3 = "b0000000000000000000000000000003";
const P1 = "p0000000000000000000000000000001";
const NOTES = "tasks/config-contract-notes.md";
const SVCB = "tasks/service-b-config-keys.md";

/** A temp copy of the golden plan with edits applied, re-rendered so rule 8 stays green. */
async function variant(edits: Record<string, Array<[string | RegExp, string]>>): Promise<string> {
  const dir = copyPlan("golden", tempDir("variant"));
  for (const [file, subs] of Object.entries(edits)) {
    const p = join(dir, file);
    let s = readFileSync(p, "utf8");
    for (const [from, to] of subs) {
      assert.ok(typeof from === "string" ? s.includes(from) : from.test(s), `edit ${String(from)} matches ${file}`);
      s = s.replace(from, to);
    }
    writeFileSync(p, s);
  }
  const w = await runCli(["--write", "--offline", "--no-base", dir]);
  assert.notEqual(w.status, 2, w.stderr);
  return dir;
}

let api: FakeAlissa;
before(async () => {
  api = await fakeAlissa();
});
after(async () => {
  await api.close();
});

async function failuresOf(dir: string, world?: World): Promise<Array<{ rule: RuleId; message: string }>> {
  let server = api;
  if (world) server = await fakeAlissa(world);
  try {
    const r = await lint(readPlanDir(dir, null), onlineAgainst(server));
    return r.failures;
  } finally {
    if (world) await server.close();
  }
}

const anchorLine = /^anchor: .*$/m;
const exhaustPlan = (cls: string, keys: string[]) => ({
  "plan.md": [
    [anchorLine, `anchor: { kind: exhaust, class: ${cls} }`],
    [/^milestone: .*$/m, `milestone: ${B3}`],
    [/^sources:\n(?: {2}- .*\n)+/m, `sources:\n${keys.map((k) => `  - { key: "${k}", evidence: "seen" }`).join("\n")}\n`],
  ] as Array<[RegExp, string]>,
  [NOTES]: [[new RegExp(`milestone: ${B1}`), `milestone: ${B3}`], [/^sources:\n {2}- .*\n/m, `sources:\n  - ${keys[0]}\n`]] as Array<[RegExp, string]>,
  [SVCB]: [[new RegExp(`milestone: ${B1}`), `milestone: ${B3}`], [/^sources:\n {2}- .*\n/m, `sources:\n  - ${keys[0]}\n`]] as Array<[RegExp, string]>,
});

describe("rule 10 — anchors", () => {
  it("accepts the milestone's own id as well as its body of work's", async () => {
    const dir = await variant({ "plan.md": [[anchorLine, "anchor: { kind: milestone, milestoneId: q0000000000000000000000000000001 }"]] });
    assert.deepEqual(await failuresOf(dir), []);
  });

  it("criterion: an unsatisfied criterion passes, a satisfied or unknown one fails", async () => {
    const ok = await variant({ "plan.md": [[anchorLine, `anchor: { kind: criterion, milestoneId: ${B1}, criterionId: c1 }`]] });
    assert.deepEqual(await failuresOf(ok), []);
    const done = await variant({ "plan.md": [[anchorLine, `anchor: { kind: criterion, milestoneId: ${B1}, criterionId: c2 }`]] });
    assert.match((await failuresOf(done)).map((f) => `${f.rule} ${f.message}`).join("\n"), /^10 criterion `c2` .* already satisfied/m);
    const unknown = await variant({ "plan.md": [[anchorLine, `anchor: { kind: criterion, milestoneId: ${B1}, criterionId: c9 }`]] });
    assert.match((await failuresOf(unknown))[0]?.message ?? "", /criterion `c9` is not one of/);
  });

  it("objective: active passes, succeeded or missing fails", async () => {
    const ok = await variant({ "plan.md": [[anchorLine, "anchor: { kind: objective, objectiveId: o0000000000000000000000000000001 }"]] });
    assert.deepEqual(await failuresOf(ok), []);
    const closed = await variant({ "plan.md": [[anchorLine, "anchor: { kind: objective, objectiveId: o0000000000000000000000000000002 }"]] });
    assert.match((await failuresOf(closed))[0]?.message ?? "", /is `succeeded`, not `active`/);
    const missing = await variant({ "plan.md": [[anchorLine, "anchor: { kind: objective, objectiveId: o0000000000000000000000000000009 }"]] });
    assert.match((await failuresOf(missing))[0]?.message ?? "", /does not resolve/);
  });

  it("a non-exhaust plan without a milestone fails; a task outside the anchor's milestone fails", async () => {
    const noMilestone = await variant({ "plan.md": [[/^milestone: .*\n/m, ""]] });
    assert.match((await failuresOf(noMilestone)).map((f) => f.message).join("\n"), /plan\.md has no `milestone`/);
    const elsewhere = await variant({ [SVCB]: [[new RegExp(`milestone: ${B1}`), `milestone: ${B3}`]] });
    const f = await failuresOf(elsewhere);
    assert.deepEqual(f.map((x) => x.rule), [10]);
    assert.match(f[0]?.message ?? "", /is not the anchor's/);
  });

  it("a paused program and an unknown program both fail", async () => {
    const paused = await variant({
      "plan.md": [[/^program: .*$/m, "program: p0000000000000000000000000000002"]],
    });
    assert.match((await failuresOf(paused)).map((f) => f.message).join("\n"), /is `paused`, not `active`/);
    const unknown = await variant({ "plan.md": [[/^program: .*$/m, "program: p0000000000000000000000000000009"]] });
    assert.match((await failuresOf(unknown))[0]?.message ?? "", /does not resolve to a project/);
  });
});

describe("rule 9 — exhaust anchors", () => {
  it("drift-fix takes drift: keys only", async () => {
    const ok = await variant(exhaustPlan("drift-fix", ["drift:config-contract:2.0"]));
    assert.deepEqual(await failuresOf(ok), []);
    const bad = await variant(exhaustPlan("drift-fix", ["drift:config-contract:2.0", "esc:flaky-1"]));
    const f = await failuresOf(bad);
    assert.deepEqual([...new Set(f.map((x) => x.rule))], [9]);
    assert.match(f[0]?.message ?? "", /`esc:flaky-1` is not of the anchor's class drift-fix/);
  });

  it("exhaust-followup takes later: and minor:; doc-correction takes any class", async () => {
    assert.deepEqual(await failuresOf(await variant(exhaustPlan("exhaust-followup", ["later:pr-1:r1", "minor:pr-2:r1"]))), []);
    assert.deepEqual(await failuresOf(await variant(exhaustPlan("doc-correction", ["gate:x", "stale:y"]))), []);
  });

  it("an exhaust anchor with no sources fails", async () => {
    const dir = await variant({
      "plan.md": [[anchorLine, "anchor: { kind: exhaust, class: flaky-test }"], [/^milestone: .*$/m, `milestone: ${B3}`], [/^sources:\n(?: {2}- .*\n)+/m, "sources: []\n"]],
      [NOTES]: [[new RegExp(`milestone: ${B1}`), `milestone: ${B3}`], [/^sources:\n {2}- .*\n/m, "sources: []\n"]],
      [SVCB]: [[new RegExp(`milestone: ${B1}`), `milestone: ${B3}`], [/^sources:\n {2}- .*\n/m, "sources: []\n"]],
    });
    assert.match((await failuresOf(dir)).map((f) => `${f.rule} ${f.message}`).join("\n"), /^9 an exhaust anchor \(flaky-test\) needs at least one source/m);
  });
});

describe("rule 11 — external edges", () => {
  it("pending_validation passes; an unknown task fails", async () => {
    assert.deepEqual(await failuresOf(await variant({ [NOTES]: [["TASK-100", "TASK-102"]] })), []);
    const f = await failuresOf(await variant({ [NOTES]: [["TASK-100", "TASK-999"]] }));
    assert.deepEqual(f.map((x) => x.rule), [11]);
    assert.match(f[0]?.message ?? "", /`TASK-999` does not resolve/);
  });
});

describe("rule 12 — repositories and off-limits", () => {
  it("a scope entry under the fleet's or the program's offLimits fails; another program's do not apply", async () => {
    const fleet = await failuresOf(await variant({ [SVCB]: [["  - src/config/load.ts\n", "  - convex/schema.ts\n"]] }));
    assert.deepEqual(fleet.map((f) => f.rule), [12]);
    assert.match(fleet[0]?.message ?? "", /matches `convex\/schema\.ts` in the fleet's steering offLimits/);
    const program = await failuresOf(await variant({ [SVCB]: [["  - src/config/load.ts\n", "  - infra/secrets/prod.env\n"]] }));
    assert.match(program[0]?.message ?? "", /in the program's steering offLimits/);
    // p...2's offLimits hold src/config/** — the golden plan's service-b scope — but the plan is p...1's.
    assert.deepEqual(await failuresOf(await variant({})), []);
  });

  it("fails closed when the steering route is not deployed (404)", async () => {
    const world = loadWorld();
    world.steering = null;
    const f = await failuresOf(await variant({}), world);
    assert.deepEqual(f.map((x) => x.rule), [12]);
    assert.match(f[0]?.message ?? "", /steering record cannot be read .*refuses rather than guesses/);
  });

  it("an unreachable API fails rules 10–12 rather than passing them", async () => {
    const dir = await variant({});
    const r = await lint(readPlanDir(dir, null), {
      online: true,
      reader: httpReader({ base: "http://127.0.0.1:9", token: TOKEN, retries: 0, timeoutMs: 2000 }),
      github: githubReader({ GITHUB_API_URL: "http://127.0.0.1:9" }, { retries: 0, timeoutMs: 2000 }),
    });
    assert.deepEqual([...new Set(r.failures.map((f) => f.rule))], [10, 11, 12]);
    assert.ok(r.failures.every((f) => /could not verify/.test(f.message)));
    assert.ok(r.warnings.length > 0 && r.warnings.every((w) => /scope_path_unknown/.test(w)), "rule 5b warns, it neither passes nor refuses");
  });

  it("a wrong token is a failure, never a pass", async () => {
    const r = await lint(readPlanDir(await variant({}), null), onlineAgainst(api, "wrong"));
    assert.deepEqual([...new Set(r.failures.map((f) => f.rule))], [10, 11, 12]);
  });
});

describe("schema v1.1 — kind, new[], acceptance edges", () => {
  it("a design task with an acceptance edge and a declared-new path passes every rule", async () => {
    const dir = await variant({
      [SVCB]: [
        ["{ id: config-contract-notes, type: hard }", "{ id: config-contract-notes, type: acceptance }"],
        ["  - tests/config/load.test.ts\n", "  - tests/config/load.test.ts\n  - src/config/keys.ts\n"],
        [/^commitClass: /m, "kind: design\nnew:\n  - src/config/keys.ts\ncommitClass: "],
      ],
    });
    assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /-->\|acceptance\| t_service_b_config_keys/, "the graph labels the edge");
    const r = await lint(readPlanDir(dir, null), onlineAgainst(api));
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.warnings, []);
  });

  it("kind code passes; a new entry outside scope is rule 2, and only rule 2", async () => {
    assert.deepEqual(await failuresOf(await variant({ [SVCB]: [[/^commitClass: /m, "kind: code\ncommitClass: "]] })), []);
    const f = await failuresOf(await variant({ [SVCB]: [[/^commitClass: /m, "new:\n  - src/config/load.ts\n  - src/config/keys.ts\ncommitClass: "]] }));
    assert.deepEqual(f.map((x) => x.rule), [2]);
    assert.match(f[0]?.message ?? "", /`src\/config\/keys\.ts` is not in `scope`/);
  });
});

describe("rule 5b — scope paths", () => {
  it("reads each repository's own default branch, and a directory path exists", async () => {
    const dir = await variant({ [NOTES]: [["  - README.md\n", "  - README.md\n  - docs/config\n"]] });
    const before = api.requests.length;
    assert.deepEqual(await failuresOf(dir), []);
    const reads = api.requests.slice(before).filter((q) => q.startsWith("GET /github/"));
    assert.ok(reads.includes("GET /github/repos/example-org/service-b/contents/src/config/load.ts?ref=trunk"), reads.join("\n"));
    assert.ok(reads.includes("GET /github/repos/example-org/service-a/contents/docs/config?ref=main"), reads.join("\n"));
  });

  it("a glob is never checked, and a path declared new is not read", async () => {
    const before = api.requests.length;
    const dir = await variant({
      [SVCB]: [
        ["  - tests/config/load.test.ts\n", "  - tests/config/load.test.ts\n  - src/legacy/**\n  - src/config/keys.ts\n"],
        [/^commitClass: /m, "new:\n  - src/config/keys.ts\ncommitClass: "],
      ],
    });
    assert.deepEqual(await failuresOf(dir), []);
    assert.ok(!api.requests.slice(before).some((q) => /legacy|keys\.ts/.test(q)));
  });

  it("every missing path is its own finding, named with its repository and branch", async () => {
    const f = await failuresOf(await variant({
      [NOTES]: [["  - README.md\n", "  - README.md\n  - ./docs/config/missing.md\n"]],
      [SVCB]: [["  - tests/config/load.test.ts\n", "  - tests/config/load.test.ts\n  - src/config/keys.ts\n"]],
    }));
    assert.deepEqual(f.map((x) => x.rule), ["5b", "5b"]);
    assert.match(f[0]?.message ?? "", /`\.\/docs\/config\/missing\.md` does not exist at example-org\/service-a's default branch \(`main`\)/);
    assert.match(f[1]?.message ?? "", /`src\/config\/keys\.ts` does not exist at example-org\/service-b's default branch \(`trunk`\)/);
  });

  it("a repository GitHub will not show is scope_path_unknown: a warning per path, never a pass and never a refusal", async () => {
    const world = loadWorld();
    delete world.github["example-org/service-b"];
    const server = await fakeAlissa(world);
    try {
      const r = await lint(readPlanDir(await variant({}), null), onlineAgainst(server));
      assert.deepEqual(r.failures, []);
      assert.equal(r.warnings.length, 2);
      assert.ok(r.warnings.every((w) => /^rule 5b scope_path_unknown — tasks\/service-b-config-keys\.md: .* in example-org\/service-b was not checked: the repository cannot be read \(404/.test(w)), r.warnings.join("\n"));
    } finally {
      await server.close();
    }
  });

  it("the CLI prints the warnings and the check title counts them; an unreachable GitHub still exits 0", async () => {
    const run = await runCli([await variant({}), "--no-base"], { ...cliEnv(api), GITHUB_API_URL: "http://127.0.0.1:9" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^plan-lint: PASS$/m);
    assert.equal(run.stdout.match(/^plan-lint: {3}warn: rule 5b scope_path_unknown/gm)?.length, 4, run.stdout);
  });

  it("literalScopePath: globs are null; ./ and a trailing slash are dropped", () => {
    assert.equal(literalScopePath("src/config/load.ts"), "src/config/load.ts");
    assert.equal(literalScopePath("./docs/config/"), "docs/config");
    for (const g of ["src/legacy/**", "docs/*.md", "src/?.ts", "src/[ab].ts", "src/{a,b}.ts"]) assert.equal(literalScopePath(g), null, g);
  });
});

describe("helpers", () => {
  it("scopeProblem: the design's forbidden examples fail, named files and two-deep globs pass", () => {
    for (const bad of ["**", "*", "**/*", "tests/**", "src/**", "convex/**", "docs/**", "src/*", "docs/**/*", "**/*.ts", "../x", "/etc/passwd"]) {
      assert.notEqual(scopeProblem(bad), null, bad);
    }
    for (const good of ["README.md", "docs/design/genloop.md", "tests/unit/**", "docs/design/*.md", "**/schema.ts", "**/migrations/**", "convex/schema.ts"]) {
      assert.equal(scopeProblem(good), null, good);
    }
  });

  it("overlaps: either glob matching the other", () => {
    assert.ok(overlaps("convex/schema.ts", "convex/schema.ts"));
    assert.ok(overlaps("convex/schema.ts", "convex/**"));
    assert.ok(overlaps("convex/**", "convex/schema.ts"));
    assert.ok(overlaps("**/schema.ts", "convex/schema.ts"));
    assert.ok(!overlaps("src/config/load.ts", "convex/schema.ts"));
    assert.ok(!overlaps("docs/a.md", "infra/secrets/**"));
  });

  it("planClassOf: the most severe of §7.1's order; unanchored never counts", () => {
    assert.equal(planClassOf(["doc-correction", "drift-fix"]), "drift-fix");
    assert.equal(planClassOf(["flaky-test", "schema-migration", "doc-correction"]), "schema-migration");
    assert.equal(planClassOf(["unanchored", "doc-correction"]), "doc-correction");
    assert.equal(planClassOf([]), null);
    assert.equal(CLASS_ORDER.length, 11);
  });

  it("bodyProblems: order, the last section, sizes, criteria as list items", () => {
    const why = `## Why\n\n${"x".repeat(420)}\n\n`;
    const dod = `## Definition of done\n\n${"d".repeat(45)}\n\n`;
    assert.deepEqual(bodyProblems(`${why}## What\n\nmore\n\n${dod}## Criteria\n\n- one\n- two\n  continued\n`), []);
    assert.match(bodyProblems(`${dod}${why}## Criteria\n\n- one\n`).join(), /first section/);
    assert.match(bodyProblems(`${why}${dod}## Criteria\n\n- one\n\n## After\n`).join(), /last section/);
    assert.match(bodyProblems(`${why}${dod}## Criteria\n\nprose, not a list\n`).join(), /only list items/);
    assert.match(bodyProblems(`## Why\n\nshort\n\n${dod}## Criteria\n\n- one\n`).join(), /description .* is \d+ characters/);
    assert.match(bodyProblems(`${why}${dod}## Criteria\n\n${Array.from({ length: 13 }, (_, i) => `- c${i}`).join("\n")}\n`).join(), /13 items/);
    assert.deepEqual(bodyProblems(`${why}\`\`\`md\n## Definition of done\n\`\`\`\n\n${dod}## Criteria\n\n- one\n`), [], "a heading inside a code fence is not a section");
  });
});

describe("plan.md", () => {
  it("its id must be its directory's name (rule 2)", async () => {
    const dir = await variant({ "plan.md": [["id: 2026-09-28-golden-plan", "id: 2026-09-28-another-name"]] });
    const r = await lint(readPlanDir(dir, null), { online: false });
    assert.deepEqual(r.failures.map((f) => f.rule), [2]);
    assert.match(r.failures[0]?.message ?? "", /is not its directory's name/);
  });

  it("the program appears only as data: nothing names a repository beyond the task files'", async () => {
    const r = await lint(readPlanDir(await variant({}), null), onlineAgainst(api));
    assert.deepEqual(r.failures, []);
    assert.ok(api.requests.some((q) => q === `GET /v1/projects/${P1}`));
  });
});
