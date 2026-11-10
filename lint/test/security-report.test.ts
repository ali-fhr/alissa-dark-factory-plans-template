// A Code Security report's run directory: K1's admission and K19–K23 (design
// alissa-code-security-reports §4.1–§4.4 in ali-fhr/studio.alissa.app, lane CSR-2). The rules are the
// port of Studio's `securityReportLintOf` and run on its fixtures, copied byte for byte into
// `fixtures/security-report/` (the tree pin below): c1 the clean run directory passes, c2 each failing
// case of `cases.json` fails exactly its rule on its file, c3 each passing case passes; then K1 online
// (a design task only), the pull-request mode (adds only, the data file never edited) and the schemas.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type KbLintResult, type KRule, K_RULE_NAMES, SECURITY_REPORT_DATA_SCHEMA, SECURITY_REPORT_FILE_SCHEMA, kRulesRan, lintKb, refsNamedIn,
  securityReportCountsTableOf, securityReportDataJsonOf, securityReportSchemas,
} from "../rules.ts";
import { readKbDir } from "../source.ts";
import { type FakeAlissa, FIXTURES, cliEnv, commitAll, fakeAlissa, git, initRepo, kbOnlineAgainst, runCli, tempDir } from "./helpers.ts";

const SR = join(FIXTURES, "security-report");
/** The run directory every fixture case is linted under: its data file's review day and id. */
const RUN = "knowledge-base/security-reports/2026-11-09-k17acmereview0001";
const RULES: KRule[] = ["K1", "K19", "K20", "K21", "K22", "K23"];
/**
 * `git rev-parse 5a87d4919ba9d561211591d9597345de93dca268:tests/fixtures/security-report` in
 * ali-fhr/studio.alissa.app — Studio's main when these fixtures were copied. A fixture change is made
 * in Studio first (CSR-1's README says how), then copied here and this pin moved with it.
 */
const STUDIO_FIXTURES_TREE = "45279d195fa7bb86a9173ed74b5a82a7243b877f";

interface Cases {
  clean: string;
  failing: Array<{ dir: string; rule: KRule; file: string; change: string }>;
  passing: Array<{ dir: string; change: string }>;
}
const cases = JSON.parse(readFileSync(join(SR, "cases.json"), "utf8")) as Cases;

/** The git tree id of a directory on disk, as `git rev-parse <rev>:<dir>` names it. */
function gitTreeId(dir: string): string {
  const entries = readdirSync(dir).map((name) => {
    const full = join(dir, name);
    const isDir = statSync(full).isDirectory();
    const id = isDir ? gitTreeId(full) : createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${statSync(full).size}\0`), readFileSync(full)])).digest("hex");
    return { name, isDir, id };
  });
  // git orders a tree's entries by name, a directory's name as if it ended in "/".
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.isDir ? `${a.name}/` : a.name), Buffer.from(b.isDir ? `${b.name}/` : b.name)));
  const body = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.isDir ? "40000" : "100644"} ${e.name}\0`), Buffer.from(e.id, "hex")])));
  return createHash("sha1").update(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body])).digest("hex");
}

/** A fixture case laid out as a run directory (`…/knowledge-base/security-reports/<day>-<id>/`), outside any repository. */
function runDir(caseDir: string, edit?: (dir: string) => void): string {
  const dir = join(tempDir("sr"), RUN);
  mkdirSync(dir, { recursive: true });
  cpSync(join(SR, caseDir), dir, { recursive: true });
  edit?.(dir);
  return dir;
}

const offline = (dir: string): Promise<KbLintResult> => lintKb(readKbDir(dir, null), { online: false });
const rulesOf = (r: KbLintResult): KRule[] => [...new Set(r.failures.map((f) => f.rule))];
const said = (r: KbLintResult): string => r.failures.map((f) => `${f.rule} ${f.file ?? ""}: ${f.message}`).join("\n");
const replaceIn = (file: string, from: string | RegExp, to: string): void => {
  const text = readFileSync(file, "utf8");
  const next = text.replace(from, to);
  assert.notEqual(next, text, `the edit of ${file} changed nothing`);
  writeFileSync(file, next);
};

let api: FakeAlissa;
before(async () => {
  api = await fakeAlissa();
});
after(async () => {
  await api.close();
});

describe("CSR-1's fixtures, copied byte for byte", () => {
  it("are Studio's tree at the pinned commit", () => {
    assert.equal(gitTreeId(SR), STUDIO_FIXTURES_TREE);
  });

  it("cases.json names a clean case, a failing case for each of K19–K23 and passing cases", () => {
    assert.equal(cases.clean, "clean");
    assert.deepEqual([...new Set(cases.failing.map((c) => c.rule))].sort(), ["K19", "K20", "K21", "K22", "K23"]);
    assert.ok(cases.passing.length > 0);
  });
});

describe("K19–K23 on the fixtures (c1–c3)", () => {
  it("c1: the clean run directory passes K1, K19–K23 offline", async () => {
    const r = await offline(runDir(cases.clean));
    assert.deepEqual(r.failures, [], said(r));
    assert.equal(r.kind, "security-report");
    assert.deepEqual(r.rulesRun, RULES);
    assert.equal(r.review, null, "a security report carries no Discovery-Review line");
  });

  for (const c of cases.failing) {
    it(`c2: ${c.dir} fails exactly ${c.rule}, on ${c.file} (${c.change})`, async () => {
      const r = await offline(runDir(c.dir));
      assert.deepEqual(rulesOf(r), [c.rule], said(r));
      assert.ok(r.failures.every((f) => f.file === c.file), said(r));
    });
  }

  for (const c of cases.passing) {
    it(`c3: ${c.dir} passes (${c.change})`, async () => {
      const r = await offline(runDir(c.dir));
      assert.deepEqual(r.failures, [], said(r));
    });
  }

  it("the CLI's --kb runs it and names the mode and the rules", async () => {
    const pass = await runCli(["--kb", runDir(cases.clean), "--offline", "--no-base"]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /— knowledge-base mode — security report — K1, K19–K23$/m);
    assert.match(pass.stdout, /^plan-lint: PASS$/m);
    const fail = await runCli(["--kb", runDir("k20-numbers"), "--offline", "--no-base"]);
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /^plan-lint: FAIL K20 \(report numbers\) — summary\.md: "two" beside critical/m);
  });
});

describe("K19 report shape, beyond the fixtures", () => {
  const data = (dir: string): string => join(dir, "report-data.json");

  it("refuses a data file with a field the schema does not know (no scenario ever rides in it)", async () => {
    const dir = runDir(cases.clean, (d) => replaceIn(data(d), '"category": "money",', '"category": "money",\n      "scenario": "send a refund twice",'));
    const r = await offline(dir);
    assert.deepEqual(rulesOf(r), ["K19"], said(r));
    assert.match(said(r), /report-data\.json: \/findings\/0 must NOT have additional properties `scenario`/);
  });

  it("refuses counts that disagree with the lists", async () => {
    const r = await offline(runDir(cases.clean, (d) => replaceIn(data(d), '"refuted": 1\n', '"refuted": 2\n')));
    assert.match(said(r), /K19 report-data\.json: counts\.refuted: 2, but the data holds 1/);
  });

  it("refuses a data file that is not in canonical form, even with the right sha on every report file", async () => {
    const dir = runDir(cases.clean, (d) => {
      const raw = readFileSync(data(d), "utf8");
      const compact = `${JSON.stringify(JSON.parse(raw))}\n`;
      writeFileSync(data(d), compact);
      const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
      for (const f of readdirSync(d).filter((n) => n.endsWith(".md"))) replaceIn(join(d, f), sha(raw), sha(compact));
    });
    const r = await offline(dir);
    assert.deepEqual(rulesOf(r), ["K19"], said(r));
    assert.match(said(r), /not in canonical form/);
  });

  it("refuses a run directory whose name is not the data file's day and review id", async () => {
    const tmp = tempDir("sr");
    const dir = join(tmp, "knowledge-base/security-reports/2026-11-10-k17acmereview0001");
    mkdirSync(dir, { recursive: true });
    cpSync(join(SR, cases.clean), dir, { recursive: true });
    const r = await offline(dir);
    assert.deepEqual(rulesOf(r), ["K19"], said(r));
    assert.match(said(r), /the run directory is `2026-11-10-k17acmereview0001`, but the data file's review is `2026-11-09-k17acmereview0001`/);
  });

  it("refuses a file name outside §4.1's list, and a technical file the data file does not list", async () => {
    const r = await offline(runDir(cases.clean, (d) => {
      writeFileSync(join(d, "notes.md"), "scratch\n");
      cpSync(join(d, "technical-chains.md"), join(d, "technical-acme-shop-admin.md"));
    }));
    assert.deepEqual(rulesOf(r), ["K19"], said(r));
    assert.match(said(r), /notes\.md: not a report file name/);
    assert.match(said(r), /technical-acme-shop-admin\.md: not in the data file's `files`/);
  });

  it("refuses a summary carrying a technical file's keys (the schema's kind branches)", async () => {
    const r = await offline(runDir(cases.clean, (d) => replaceIn(join(d, "summary.md"), "links: [", "covers: [TASK-1040#q2]\nlinks: [")));
    assert.match(said(r), /K19 summary\.md: frontmatter \/covers is not allowed on this kind of report file/);
  });

  it("refuses a suggested task that names no ref its file covers", async () => {
    const r = await offline(runDir(cases.clean, (d) => replaceIn(join(d, "technical-chains.md"), "covers: [TASK-1040#q3]\n",
      "covers: [TASK-1040#q3]\nsuggestedTasks:\n  - { title: Check the session scope, repo: acme-shop/payments-api, commitClass: auth-secrets, scope: [src/session.ts], why: Because of TASK-1040#q2 }\n")));
    assert.match(said(r), /K19 technical-chains\.md: suggested task 1 names no ref this file covers/);
  });

  it("stops at K19 when the data file is missing: the other rules read it", async () => {
    const dir = runDir(cases.clean);
    const tmp = tempDir("sr");
    const bare = join(tmp, RUN);
    mkdirSync(bare, { recursive: true });
    for (const f of readdirSync(dir).filter((n) => n !== "report-data.json")) cpSync(join(dir, f), join(bare, f));
    const r = await offline(bare);
    assert.deepEqual(r.failures.map((f) => [f.rule, f.message]), [["K19", "the run directory has no report-data.json"]]);
  });
});

describe("K1 — the run directory's layout, and its design task online", () => {
  it("refuses a subfolder in the run directory: it is flat", async () => {
    const r = await offline(runDir(cases.clean, (d) => {
      mkdirSync(join(d, "evidence"));
      writeFileSync(join(d, "evidence", "a.txt"), "x\n");
    }));
    assert.deepEqual(rulesOf(r), ["K1"], said(r));
    assert.match(said(r), /`evidence\/` is a directory — a run directory is flat/);
  });

  it("refuses a run directory whose name is not <yyyy-mm-dd>-<reviewId>", async () => {
    const tmp = tempDir("sr");
    const dir = join(tmp, "knowledge-base/security-reports/2026-02-30-k17acmereview0001");
    mkdirSync(dir, { recursive: true });
    cpSync(join(SR, cases.clean), dir, { recursive: true });
    const r = await offline(dir);
    assert.ok(r.failures.some((f) => f.rule === "K1" && /does not start with a real calendar date/.test(f.message)), said(r));
  });

  it("admits the files from a kind: design task, and refuses them from any other or from none", async () => {
    const dir = runDir(cases.clean);
    const design = await lintKb(readKbDir(dir, null), kbOnlineAgainst(api, "TASK-2000"));
    assert.deepEqual(design.failures, [], said(design));
    assert.deepEqual(design.rulesRun, RULES);
    const code = await lintKb(readKbDir(dir, null), kbOnlineAgainst(api, "TASK-2001"));
    assert.deepEqual(code.failures.map((f) => f.rule), ["K1"]);
    assert.match(code.failures[0]?.message ?? "", /`TASK-2001` is `kind: code` — only a design task adds files to a `knowledge-base\/security-reports\/<yyyy-mm-dd>-<reviewId>\/` directory/);
    const none = await lintKb(readKbDir(dir, null), kbOnlineAgainst(api, null));
    assert.match(none.failures[0]?.message ?? "", /a security report is admitted only from a `kind: design` task, and this run names none/);
  });
});

describe("--pr on a security report's run directory", () => {
  /** A plans repository whose base holds `report-data.json` (the Report plan's PR) and, optionally, merged report files. */
  function reportRepo(merged: string[]): { repo: string; base: string; dir: string } {
    const repo = initRepo();
    const dir = join(repo, RUN);
    mkdirSync(dir, { recursive: true });
    for (const f of ["report-data.json", ...merged]) cpSync(join(SR, cases.clean, f), join(dir, f));
    const base = commitAll(repo, "report data");
    git(repo, "checkout", "-q", "-b", "TASK-2000-report-summary");
    return { repo, base, dir };
  }
  const prArgs = (repo: string, base: string, head: string) => ["--pr", "--repo", repo, "--base", base, "--head", head];
  const env = () => ({ ...cliEnv(api), GITHUB_HEAD_REF: "TASK-2000-report-summary" });

  it("passes a technical task's PR, then the summary's PR beside the merged technical files", async () => {
    const tech = reportRepo([]);
    cpSync(join(SR, cases.clean, "technical-chains.md"), join(tech.dir, "technical-chains.md"));
    const one = await runCli(prArgs(tech.repo, tech.base, commitAll(tech.repo, "chains report")), env());
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.match(one.stdout, new RegExp(`^plan-lint: ${RUN} — knowledge-base mode — security report — K1, K19–K23$`, "m"));

    const sum = reportRepo(["technical-acme-shop-payments-api.md", "technical-acme-shop-storefront.md", "technical-chains.md"]);
    cpSync(join(SR, cases.clean, "summary.md"), join(sum.dir, "summary.md"));
    const two = await runCli(prArgs(sum.repo, sum.base, commitAll(sum.repo, "summary")), env());
    assert.equal(two.status, 0, two.stdout + two.stderr);
    assert.match(two.stdout, /^plan-lint: PASS$/m);
  });

  it("refuses a PR that edits a merged report file (K1) or the data file (K19, changed after its first commit)", async () => {
    const a = reportRepo(["technical-chains.md"]);
    replaceIn(join(a.dir, "technical-chains.md"), "### Fix", "### Fix\n\nAlso rotate the session.");
    const edited = await runCli(prArgs(a.repo, a.base, commitAll(a.repo, "edit")), env());
    assert.equal(edited.status, 1);
    assert.match(edited.stdout, /FAIL K1 \(layout and immutability\): `knowledge-base\/security-reports\/2026-11-09-k17acmereview0001\/technical-chains\.md` is modified — a merged report file is never edited/);

    const b = reportRepo([]);
    replaceIn(join(b.dir, "report-data.json"), '"reason": "repos_cap"', '"reason": "repos_capped"');
    const data = await runCli(prArgs(b.repo, b.base, commitAll(b.repo, "edit data")), env());
    assert.equal(data.status, 1);
    assert.match(data.stdout, /K19 \(report shape\) — report-data\.json: changed after its first commit/);
  });

  it("refuses a PR that mixes the run directory with a finding or a plan", async () => {
    const a = reportRepo([]);
    cpSync(join(SR, cases.clean, "technical-chains.md"), join(a.dir, "technical-chains.md"));
    mkdirSync(join(a.repo, "knowledge-base/2026/11/09/TASK-1040"), { recursive: true });
    writeFileSync(join(a.repo, "knowledge-base/2026/11/09/TASK-1040/findings.md"), "---\n---\n");
    mkdirSync(join(a.repo, "plans/2026-11-10-report"), { recursive: true });
    writeFileSync(join(a.repo, "plans/2026-11-10-report/plan.md"), "---\n---\n");
    const run = await runCli(prArgs(a.repo, a.base, commitAll(a.repo, "mix")), env());
    assert.equal(run.status, 1);
    assert.match(run.stdout, /the diff touches `knowledge-base\/2026\/11\/09\/TASK-1040\/findings\.md` — a security report PR touches one/);
    assert.match(run.stdout, /the diff touches `plans\/2026-11-10-report\/plan\.md` — a knowledge-base PR never carries a plan/);
  });

  it("refuses a PR from a code task (K1 online)", async () => {
    const a = reportRepo([]);
    cpSync(join(SR, cases.clean, "technical-chains.md"), join(a.dir, "technical-chains.md"));
    const run = await runCli(prArgs(a.repo, a.base, commitAll(a.repo, "chains")), { ...cliEnv(api), GITHUB_HEAD_REF: "TASK-2001-report" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL K1 \(layout and immutability\): the PR's task `TASK-2001` is `kind: code`/);
  });
});

describe("the schemas, the shared renderings and the stamp", () => {
  it("the clean data file and every clean report file validate against the schemas", () => {
    const { data, file } = securityReportSchemas();
    const raw = readFileSync(join(SR, cases.clean, "report-data.json"), "utf8");
    assert.ok(data(JSON.parse(raw)), JSON.stringify(data.errors));
    assert.equal(securityReportDataJsonOf(JSON.parse(raw)), raw, "the fixture's data file is in canonical form");
    for (const f of readdirSync(join(SR, cases.clean)).filter((n) => n.endsWith(".md"))) {
      const fm = readFileSync(join(SR, cases.clean, f), "utf8").split("\n---\n")[0]?.replace(/^---\n/, "") ?? "";
      assert.ok(fm.includes(`schema: ${SECURITY_REPORT_FILE_SCHEMA}`), f);
    }
    assert.equal(JSON.parse(raw).schema, SECURITY_REPORT_DATA_SCHEMA);
  });

  it("the counts table is the summary's At a glance table, byte for byte (en and es-MX)", () => {
    const raw = JSON.parse(readFileSync(join(SR, cases.clean, "report-data.json"), "utf8"));
    assert.ok(readFileSync(join(SR, cases.clean, "summary.md"), "utf8").includes(securityReportCountsTableOf(raw)));
    const es = securityReportCountsTableOf({ ...raw, review: { ...raw.review, lang: "es-MX" } });
    assert.match(es, /^\| En resumen \| Cantidad \|$/m);
    assert.match(es, /^\| Críticos y altos abiertos \| 3 \|$/m);
  });

  it("refsNamedIn reads TASK-<n>#<id> refs, each once, without trailing punctuation", () => {
    assert.deepEqual(refsNamedIn("See TASK-1040#q2. Also TASK-1040#q2, and TASK-1041#owner-1."), ["TASK-1040#q2", "TASK-1041#owner-1"]);
  });

  it("names K19–K23 and reports a run as `K1, K19–K23`", () => {
    assert.deepEqual(Object.keys(K_RULE_NAMES).slice(-5), ["K19", "K20", "K21", "K22", "K23"]);
    assert.equal(kRulesRan(RULES), "K1, K19–K23");
  });

  it("lint/VERSION names both report schemas", () => {
    const line = readFileSync(new URL("../VERSION", import.meta.url), "utf8").split("\n").find((l) => l.startsWith("security-report-schemas: "));
    assert.equal(line, `security-report-schemas: ${SECURITY_REPORT_DATA_SCHEMA} ${SECURITY_REPORT_FILE_SCHEMA}`);
    for (const [name, want] of [["security-report-data.v1.json", SECURITY_REPORT_DATA_SCHEMA], ["security-report.v1.json", SECURITY_REPORT_FILE_SCHEMA]] as const) {
      const schema = JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8")) as { properties: { schema: { const: string } } };
      assert.equal(schema.properties.schema.const, want, name);
    }
  });
});
