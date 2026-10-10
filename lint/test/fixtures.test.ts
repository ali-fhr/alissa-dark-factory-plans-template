// c1: every rule 1–12 and 5b has a fixture that fails exactly it and names it; the golden plan
// passes. A fixture case is `rule-<nn>[b]-<what>`; a rule may have several (schema v1.1 adds one per
// new refusal: `kind`, `new` outside `scope`, an unknown edge type, and rule 5b's missing path).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { RULE_NAMES, type RuleId, lint } from "../rules.ts";
import { readPlanDir } from "../source.ts";
import { type FakeAlissa, caseNames, cliEnv, fakeAlissa, fixturePlan, onlineAgainst, runCli } from "./helpers.ts";

let api: FakeAlissa;
before(async () => {
  api = await fakeAlissa();
});
after(async () => {
  await api.close();
});

const lintCase = async (name: string) => lint(readPlanDir(fixturePlan(name), null), onlineAgainst(api));

/** The rule a fixture case fails: `rule-02-kind` → 2, `rule-05b-scope-paths` → "5b". */
function ruleOf(name: string): RuleId {
  const m = /^rule-(\d{2})(b?)-[a-z0-9-]+$/.exec(name);
  assert.ok(m, `fixture case \`${name}\` is named rule-<nn>[b]-<what>`);
  return m[2] ? (`${Number(m[1])}${m[2]}` as RuleId) : Number(m[1]);
}

const ruleCases = caseNames().filter((n) => n.startsWith("rule-"));

describe("fixtures", () => {
  it("has the golden plan and at least one fixture per rule 1–12 and 5b", () => {
    const rules = [...new Set(ruleCases.map(ruleOf))].map(String).sort();
    assert.deepEqual(rules, ["1", "10", "11", "12", "2", "3", "4", "5", "5b", "6", "7", "8", "9"]);
    assert.ok(caseNames().includes("golden"));
  });

  it("schema v1.1 has one fixture per new refusal (kind, new outside scope, edge type) and rule 5b one", () => {
    for (const name of ["rule-02-kind", "rule-02-new-in-scope", "rule-02-edge-type", "rule-05b-scope-paths"]) assert.ok(ruleCases.includes(name), name);
  });

  it("the golden plan passes rules 1–12 and 5b with no warning", async () => {
    const r = await lintCase("golden");
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.rulesRun, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, "5b"]);
    assert.equal(r.planClass, "drift-fix");
    assert.equal(r.taskCount, 2);
  });

  for (const name of ruleCases) {
    const rule = ruleOf(name);
    it(`${name} fails rule ${rule} (${RULE_NAMES[rule]}) and no other rule`, async () => {
      const r = await lintCase(name);
      assert.ok(r.failures.length > 0, "expected a failure");
      assert.deepEqual([...new Set(r.failures.map((f) => f.rule))], [rule], JSON.stringify(r.failures, null, 2));
    });
  }

  it("each schema v1.1 fixture is refused for its own reason", async () => {
    const messages = async (name: string) => (await lintCase(name)).failures.map((f) => f.message).join("\n");
    assert.match(await messages("rule-02-kind"), /\/kind must be equal to one of the allowed values: code, design/);
    assert.match(await messages("rule-02-new-in-scope"), /\/new entry `src\/config\/keys\.ts` is not in `scope`/);
    assert.match(await messages("rule-02-edge-type"), /\/dependsOn\/0\/type must be equal to one of the allowed values: hard, soft, acceptance/);
    assert.match(await messages("rule-05b-scope-paths"), /`src\/config\/keys\.ts` does not exist at example-org\/service-b's default branch \(`trunk`\) and is not declared in `new` — scope_path_missing/);
  });
});

describe("the CLI names the rule", () => {
  it("golden: exit 0, PASS, the plan class in the summary line", async () => {
    const run = await runCli([fixturePlan("golden"), "--no-base"], cliEnv(api));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /plan class: drift-fix — rules 1–12 and 5b/);
    assert.match(run.stdout, /^plan-lint: PASS$/m);
    assert.doesNotMatch(run.stdout, /warn:/);
  });

  for (const name of ruleCases) {
    const rule = ruleOf(name);
    it(`${name}: exit 1 and the verdict names rule ${rule}`, async () => {
      const run = await runCli([fixturePlan(name), "--no-base"], cliEnv(api));
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const verdict = run.stdout.split("\n").find((l) => l.startsWith("plan-lint: FAIL "));
      assert.ok(verdict?.startsWith(`plan-lint: FAIL rule ${rule} (${RULE_NAMES[rule]})`), run.stdout);
    });
  }

  it("offline, rules 10–12 and 5b do not run and their fixtures pass rules 1–9", async () => {
    for (const name of ["rule-05b-scope-paths", "rule-10-anchor", "rule-11-external-edges", "rule-12-repositories"]) {
      const run = await runCli([fixturePlan(name), "--no-base", "--offline"]);
      assert.equal(run.status, 0, run.stdout);
      assert.match(run.stdout, /rules 1–9/);
      assert.match(run.stdout, /rules 10–12 and 5b not run \(offline\)/);
    }
  });

  it("without ALISSA_API_TOKEN and without --offline it refuses to run rather than skip rules 10–12", async () => {
    const run = await runCli([fixturePlan("golden"), "--no-base"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /rules 10–12 need ALISSA_API_TOKEN/);
  });

  it("--check-output writes the check run's conclusion, title and summary", async () => {
    const { tempDir } = await import("./helpers.ts");
    const { readFileSync } = await import("node:fs");
    const out = `${tempDir("check")}/check.json`;
    const run = await runCli([fixturePlan("rule-04-graph"), "--no-base", "--check-output", out], cliEnv(api));
    assert.equal(run.status, 1);
    const check = JSON.parse(readFileSync(out, "utf8")) as { conclusion: string; title: string; summary: string };
    assert.equal(check.conclusion, "failure");
    assert.match(check.title, /^FAIL — rule 4 \(graph\)/);
    assert.match(check.summary, /plan class: `drift-fix`/);
  });
});
