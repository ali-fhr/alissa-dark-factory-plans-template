// c2: --write renders the Summary and the Mermaid dependency graph, and a second run changes nothing.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DAG_BEGIN, DAG_END, SUMMARY_BEGIN, SUMMARY_END, readRegion, renderDag, renderSummary, type TaskView } from "../render.ts";
import { copyPlan, fixturePlan, runCli, tempDir } from "./helpers.ts";

function blankGenerated(planMd: string): string {
  return planMd
    .replace(/<!-- plan-summary:begin -->[\s\S]*?<!-- plan-summary:end -->/, `${SUMMARY_BEGIN}\n${SUMMARY_END}`)
    .replace(/<!-- plan-dag:begin -->[\s\S]*?<!-- plan-dag:end -->/, `${DAG_BEGIN}\n${DAG_END}`);
}

describe("--write", () => {
  it("renders the Summary and the Dependency graph, then a second run changes nothing", async () => {
    const dir = copyPlan("golden", tempDir("write"));
    const planPath = join(dir, "plan.md");
    const committed = readFileSync(planPath, "utf8");
    writeFileSync(planPath, blankGenerated(committed));

    const first = await runCli(["--write", "--offline", "--no-base", dir]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /plan-lint: wrote .*plan\.md \(Summary, Dependency graph\)/);
    const once = readFileSync(planPath, "utf8");
    assert.equal(once, committed, "the rendering equals the committed golden plan.md");

    const summary = readRegion(once, SUMMARY_BEGIN, SUMMARY_END);
    assert.ok(summary.ok);
    assert.equal(
      summary.inner,
      [
        "- `config-contract-notes` — service-a's contract notes describe the 2.0 config keys (example-org/service-a, doc-correction)",
        "- `service-b-config-keys` — service-b loads the 2.0 config keys (example-org/service-b, drift-fix)",
      ].join("\n"),
    );
    const dag = readRegion(once, DAG_BEGIN, DAG_END);
    assert.ok(dag.ok);
    assert.equal(
      dag.inner,
      [
        "```mermaid",
        "graph LR",
        '  t_config_contract_notes["config-contract-notes"]',
        '  t_service_b_config_keys["service-b-config-keys"]',
        '  x_TASK_100["TASK-100"]',
        "  x_TASK_100 -->|soft| t_config_contract_notes",
        "  t_config_contract_notes -->|hard| t_service_b_config_keys",
        "```",
      ].join("\n"),
    );

    const second = await runCli(["--write", "--offline", "--no-base", dir]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already up to date/);
    assert.equal(readFileSync(planPath, "utf8"), once, "a second run changes nothing");
  });

  it("inserts the markers under the two headings when plan.md has none yet", async () => {
    const dir = copyPlan("golden", tempDir("write-markers"));
    const planPath = join(dir, "plan.md");
    const committed = readFileSync(planPath, "utf8");
    const bare = committed.replace(/<!-- plan-summary:begin -->[\s\S]*?<!-- plan-summary:end -->\n/, "").replace(/<!-- plan-dag:begin -->[\s\S]*?<!-- plan-dag:end -->\n/, "");
    assert.ok(!bare.includes(SUMMARY_BEGIN) && !bare.includes(DAG_BEGIN));
    writeFileSync(planPath, bare);
    const run = await runCli(["--write", "--offline", "--no-base", dir]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(readFileSync(planPath, "utf8"), committed);
  });

  it("repairs a drifted plan (the rule 8 fixture) so the lint passes", async () => {
    const dir = copyPlan("rule-08-generated", tempDir("write-drift"));
    const before = await runCli(["--offline", "--no-base", dir]);
    assert.equal(before.status, 1);
    const run = await runCli(["--write", "--offline", "--no-base", dir]);
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /plan-lint: wrote/);
  });

  it("refuses to render a task whose frontmatter lacks the rendered fields", async () => {
    const dir = copyPlan("golden", tempDir("write-bad"));
    const task = join(dir, "tasks", "service-b-config-keys.md");
    writeFileSync(task, readFileSync(task, "utf8").replace(/^title: .*$/m, ""));
    const before = readFileSync(join(dir, "plan.md"), "utf8");
    const run = await runCli(["--write", "--offline", "--no-base", dir]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--write cannot render tasks\/service-b-config-keys\.md/);
    assert.equal(readFileSync(join(dir, "plan.md"), "utf8"), before, "nothing written");
  });

  it("renders deterministically whatever order the task files are given in, cycles included", () => {
    const t = (id: string, deps: string[]): TaskView => ({ id, title: `Task ${id} title`, repo: "o/r", commitClass: "drift-fix", dependsOn: deps.map((d) => ({ id: d, type: "hard" })) });
    const tasks = [t("c", ["b"]), t("a", []), t("b", ["a"]), t("x", ["y"]), t("y", ["x"]), t("lone", [])];
    const reversed = [...tasks].reverse();
    assert.equal(renderSummary(tasks), renderSummary(reversed));
    assert.equal(renderDag(tasks), renderDag(reversed));
    assert.deepEqual(
      renderSummary(tasks).split("\n").map((l) => l.slice(3, l.indexOf("`", 3))),
      ["a", "b", "c", "lone", "x", "y"],
      "upstream first, ties and cycle members by id",
    );
    assert.match(renderDag(tasks), /^ {2}t_lone\["lone"\]$/m, "an isolated task is still a node");
  });

  it("keeps every id out of Mermaid's grammar: `end` and `--` ids become quoted labels on safe keys", () => {
    const t = (id: string, deps: TaskView["dependsOn"]): TaskView => ({ id, title: `Task ${id} title`, repo: "o/r", commitClass: "drift-fix", dependsOn: deps });
    const tasks = [t("end", [{ task: "TASK-7", type: "soft" }]), t("api--cutover", [{ id: "end", type: "hard" }]), t("o-x", [{ id: "api--cutover", type: "soft" }])];
    assert.equal(
      renderDag(tasks),
      [
        "```mermaid",
        "graph LR",
        '  t_end["end"]',
        '  t_api__cutover["api--cutover"]',
        '  t_o_x["o-x"]',
        '  x_TASK_7["TASK-7"]',
        "  x_TASK_7 -->|soft| t_end",
        "  t_end -->|hard| t_api__cutover",
        "  t_api__cutover -->|soft| t_o_x",
        "```",
      ].join("\n"),
    );
    for (const line of renderDag(tasks).split("\n").slice(2, -1)) {
      assert.match(line, /^ {2}(?:[tx]_[A-Za-z0-9_]+\["[^"]*"\]|[tx]_[A-Za-z0-9_]+ -->\|[a-z]+\| t_[A-Za-z0-9_]+)$/, `a node declaration or a key-to-key edge: ${line}`);
    }
  });

  it("declares a node for an id an edge names but the plan lacks, and quotes labels safely", () => {
    const tasks: TaskView[] = [{ id: "a-task", title: "A task title", repo: "o/r", commitClass: "drift-fix", dependsOn: [{ id: "gone", type: "hard" }] }];
    assert.match(renderDag(tasks), /^ {2}t_gone\["gone"\]$/m);
    assert.match(renderDag([{ ...(tasks[0] as TaskView), id: 'a"b', dependsOn: [] }]), /^ {2}t_a_b\["a#quot;b"\]$/m);
  });

  it("the committed golden plan is exactly what --write renders (fixtures are not hand-edited)", async () => {
    const dir = fixturePlan("golden");
    const run = await runCli(["--offline", "--no-base", dir]);
    assert.equal(run.status, 0, run.stdout);
  });
});
