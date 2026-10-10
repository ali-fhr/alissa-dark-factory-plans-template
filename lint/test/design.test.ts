// c3: the plan schema equals design §5.3 byte for byte, and the task schema equals §5.3's block with
// exactly the additions of schema v1.1 (loop-operator-surface §9 L12) and nothing else, both pinned
// at named commits; the README's layout section quotes §5.1 and §5.2 without drift. Each design is
// read with `gh api` at its pinned commit when gh can reach it; otherwise from a committed snapshot
// whose digest is pinned below and which the online run proves equal to the design.
// PLAN_LINT_DESIGN_ONLINE=1 makes the online reads mandatory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { schemas } from "../rules.ts";
import { ROOT } from "./helpers.ts";

/** The design, where it lives and the commit this repository's schemas are pinned to. */
export const DESIGN = {
  repo: "ali-fhr/studio.alissa.app",
  path: "docs/design/genloop.md",
  commit: "252ef5e4cd845e1f896150599f99bcff3921653e",
  /** The repository name the design text uses for the plans repository (superseded, per fleet). */
  plansRepoInDesign: "ali-fhr/alissa-plans",
  snapshot: join(ROOT, "lint", "test", "design-snapshot.md"),
  snapshotSha256: "d062bfdd1876d0e52c930e789b1e06ab7f3de01706f352e500c934f3a6d377a3",
} as const;

/** The design of schema v1.1 (D7, D8, D12; lane L12), and its §3.1 example, pinned the same way. */
export const OPERATOR_SURFACE = {
  repo: "ali-fhr/studio.alissa.app",
  path: "docs/design/loop-operator-surface.md",
  commit: "7fc08519d8ae8e7cd029dab842506d6a65080953",
  snapshot: join(ROOT, "lint", "test", "operator-surface-example.json"),
  snapshotSha256: "183ab01c91b5d4a19cd1bc58eb4103c101eec22ad1fa66374190f68ca9ca401e",
} as const;

const START = "### 5.1 Location\n";
const END = "### 5.4 Size limits\n";

function excerpt(text: string): string {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  assert.ok(a >= 0 && b > a, "the design has §5.1 … §5.4 headings");
  return text.slice(a, b);
}

let cached: { text: string; online: boolean } | null = null;
function design(): { text: string; online: boolean } {
  if (cached) return cached;
  const res = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${DESIGN.repo}/contents/${DESIGN.path}?ref=${DESIGN.commit}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const snapshot = readFileSync(DESIGN.snapshot, "utf8");
  if (res.status === 0 && res.stdout.includes(START)) {
    cached = { text: excerpt(res.stdout), online: true };
  } else {
    if (process.env.PLAN_LINT_DESIGN_ONLINE === "1") {
      assert.fail(`PLAN_LINT_DESIGN_ONLINE=1 but gh could not read ${DESIGN.repo}@${DESIGN.commit}: ${(res.stderr || String(res.error ?? "")).trim()}`);
    }
    cached = { text: snapshot, online: false };
  }
  return cached;
}

type Schema = {
  $id: string;
  title: string;
  required: string[];
  properties: Record<string, { type?: string; items?: unknown; uniqueItems?: boolean; maxItems?: number }>;
  definitions: Record<string, unknown>;
};

function jsonBlocks(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] as string);
}

/** Text up to the next `## ` heading that is not inside a ``` or ~~~ fence. */
function untilNextTopSection(text: string): string {
  const lines = text.split("\n");
  let fence: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1] as string;
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence) && line.trim() === marker) fence = null;
      continue;
    }
    if (fence === null && line.startsWith("## ")) return `${lines.slice(0, i).join("\n")}\n`;
  }
  return text;
}

function repoIdentity(): string | null {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const res = spawnSync("git", ["-C", ROOT, "remote", "get-url", "origin"], { encoding: "utf8" });
  const m = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\s*$/.exec(res.stdout ?? "");
  return m ? (m[1] as string) : null;
}

describe("design pin", () => {
  it("the design excerpt is the pinned commit's (online), or the pinned snapshot (offline)", (t) => {
    const d = design();
    const snapshot = readFileSync(DESIGN.snapshot, "utf8");
    assert.equal(createHash("sha256").update(snapshot).digest("hex"), DESIGN.snapshotSha256, "the snapshot is the pinned one");
    if (d.online) {
      assert.equal(d.text, snapshot, `the snapshot equals §5.1–§5.3 of ${DESIGN.repo}@${DESIGN.commit}`);
      t.diagnostic(`design read online: ${DESIGN.repo}@${DESIGN.commit}`);
    } else {
      t.diagnostic(`gh could not reach ${DESIGN.repo}; the pinned snapshot stood in (set PLAN_LINT_DESIGN_ONLINE=1 to require the online read)`);
    }
  });

  const blockOf = (name: string): string => {
    const block = jsonBlocks(design().text).find((b) => (JSON.parse(b) as { $id: string }).$id.endsWith(`/schema/${name}`));
    assert.ok(block, `§5.3 has the ${name} block`);
    return block;
  };

  it("schema/plan-frontmatter.v1.json equals its §5.3 block byte for byte", () => {
    const file = readFileSync(join(ROOT, "schema", "plan-frontmatter.v1.json"), "utf8");
    assert.equal(file, `${blockOf("plan-frontmatter.v1.json")}\n`, "the file is the block's lines, newline-terminated");
  });

  it("schema/task-frontmatter.v1.json is §5.3's block bumped in place to v1.1 — L12's three additions and nothing else", () => {
    const v1 = JSON.parse(blockOf("task-frontmatter.v1.json")) as Schema;
    const file = JSON.parse(readFileSync(join(ROOT, "schema", "task-frontmatter.v1.json"), "utf8")) as Schema;
    assert.equal(file.$id, v1.$id, "the $id is unchanged, so every $ref to it holds");
    assert.equal(file.title, v1.title.replace(/version 1$/, "version 1.1"));
    const { kind, new: newPaths, ...rest } = file.properties;
    assert.deepEqual(kind, { type: "string", enum: ["code", "design"] });
    assert.deepEqual(newPaths?.items, { type: "string", pattern: "^[^\\s,*]+$" }, "new[] holds literal paths, as feed_plan's newPaths");
    assert.equal(newPaths?.type, "array");
    assert.equal(newPaths?.uniqueItems, true);
    assert.equal(newPaths?.maxItems, 12);
    assert.deepEqual(file.definitions.edgeType, { type: "string", enum: ["hard", "soft", "acceptance"] });
    assert.ok(!file.required.includes("kind") && !file.required.includes("new"), "both additions are optional");
    const back = { ...file, title: v1.title, properties: rest, definitions: { ...file.definitions, edgeType: v1.definitions.edgeType } };
    assert.deepEqual(back, v1, "with the additions taken out, the schema is §5.3's");
  });

  it("§5.3's two filled examples validate against the schemas", () => {
    const yamlBlocks = [...design().text.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => parse(m[1] as string) as unknown);
    assert.equal(yamlBlocks.length, 2);
    const { task, plan } = schemas();
    assert.ok(task(yamlBlocks[0]), JSON.stringify(task.errors));
    assert.ok(plan(yamlBlocks[1]), JSON.stringify(plan.errors));
  });

  it("the operator-surface §3.1 example is the pinned commit's (online), or the pinned snapshot (offline)", (t) => {
    const snapshot = readFileSync(OPERATOR_SURFACE.snapshot, "utf8");
    assert.equal(createHash("sha256").update(snapshot).digest("hex"), OPERATOR_SURFACE.snapshotSha256, "the snapshot is the pinned one");
    const res = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${OPERATOR_SURFACE.repo}/contents/${OPERATOR_SURFACE.path}?ref=${OPERATOR_SURFACE.commit}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.status === 0 && res.stdout.includes("### 3.1 The request\n")) {
      const a = res.stdout.indexOf("### 3.1 The request\n");
      const section = res.stdout.slice(a, res.stdout.indexOf("### 3.2 ", a));
      assert.ok(jsonBlocks(section).map((b) => `${b}\n`).includes(snapshot), `the snapshot is a §3.1 block of ${OPERATOR_SURFACE.repo}@${OPERATOR_SURFACE.commit}`);
      t.diagnostic(`design read online: ${OPERATOR_SURFACE.repo}@${OPERATOR_SURFACE.commit}`);
    } else if (process.env.PLAN_LINT_DESIGN_ONLINE === "1") {
      assert.fail(`PLAN_LINT_DESIGN_ONLINE=1 but gh could not read ${OPERATOR_SURFACE.repo}@${OPERATOR_SURFACE.commit}: ${(res.stderr || String(res.error ?? "")).trim()}`);
    } else {
      t.diagnostic(`gh could not reach ${OPERATOR_SURFACE.repo}; the pinned snapshot stood in`);
    }
  });

  it("schema v1.1 validates the §3.1 example with kind and newPaths moved inside the frontmatter as kind and new (c1)", () => {
    const example = JSON.parse(readFileSync(OPERATOR_SURFACE.snapshot, "utf8")) as { tasks: Array<{ frontmatter: Record<string, unknown>; kind?: string; newPaths?: string[] }> };
    const { task } = schemas();
    const edgeTypes = new Set<unknown>();
    for (const t of example.tasks) {
      const fm: Record<string, unknown> = { ...t.frontmatter, ...(t.kind ? { kind: t.kind } : {}), ...(t.newPaths ? { new: t.newPaths } : {}) };
      for (const e of fm.dependsOn as Array<{ type: unknown }>) edgeTypes.add(e.type);
      assert.ok(task(fm), `${String(fm.id)}: ${JSON.stringify(task.errors)}`);
      assert.ok(task({ ...fm, kind: "design" }), "kind: design");
    }
    assert.ok(edgeTypes.has("acceptance"), "the example carries an acceptance edge");
  });

  it("schema v1.1 refuses kind other and edge type accept; it still refuses unknown fields (c1)", () => {
    const example = JSON.parse(readFileSync(OPERATOR_SURFACE.snapshot, "utf8")) as { tasks: Array<{ frontmatter: Record<string, unknown> }> };
    const fm = example.tasks[1]?.frontmatter as Record<string, unknown>;
    const { task } = schemas();
    assert.ok(task(fm));
    assert.ok(!task({ ...fm, kind: "other" }));
    assert.ok(!task({ ...fm, dependsOn: [{ id: "release-stamp", type: "accept" }] }));
    assert.ok(!task({ ...fm, new: ["convex/**"] }), "a glob is never declared new");
    assert.ok(!task({ ...fm, newPaths: [] }), "the file's field is `new`, not feed_plan's `newPaths`");
  });

  it("the README's layout section quotes §5.1 and §5.2 without drift (only the plans repository's name differs)", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const a = readme.indexOf(START);
    assert.ok(a >= 0, "README.md has the §5.1 heading");
    const quoted = untilNextTopSection(readme.slice(a));
    const d = design().text;
    const want = d.slice(0, d.indexOf("### 5.3 "));
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${want.split(DESIGN.plansRepoInDesign).map(escape).join("([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)")}$`);
    const m = pattern.exec(quoted);
    assert.ok(m, "README §5.1/§5.2 differ from the design beyond the repository name");
    const names = new Set(m.slice(1));
    assert.equal(names.size, 1, "one repository name throughout");
    const identity = repoIdentity();
    // The template ships the placeholder below; a fleet's copy may keep it or name itself.
    const TEMPLATE_PLACEHOLDER = "your-org/alissa-dark-factory-plans";
    if (identity && [...names][0] !== TEMPLATE_PLACEHOLDER) assert.equal([...names][0]?.toLowerCase(), identity.toLowerCase(), "the name is this repository's own");
    assert.ok(!quoted.includes(DESIGN.plansRepoInDesign), "the superseded name is not used");
  });
});
