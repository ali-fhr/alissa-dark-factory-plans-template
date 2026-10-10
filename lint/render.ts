// The two generated sections of plan.md (§5.2, D17): the Summary and the Mermaid dependency graph,
// rendered from the task files alone. Deterministic: the same task files always render the same bytes.

export const SUMMARY_BEGIN = "<!-- plan-summary:begin -->";
export const SUMMARY_END = "<!-- plan-summary:end -->";
export const DAG_BEGIN = "<!-- plan-dag:begin -->";
export const DAG_END = "<!-- plan-dag:end -->";

export interface Edge {
  id?: string;
  task?: string;
  type: string;
}

export interface TaskView {
  id: string;
  title: string;
  repo: string;
  commitClass: string;
  dependsOn: Edge[];
}

/** The fields rendering needs, or `null` when the frontmatter lacks them (rule 2 reports why). */
export function taskView(fm: unknown): TaskView | null {
  if (!isRecord(fm)) return null;
  const { id, title, repo, commitClass, dependsOn } = fm;
  if (typeof id !== "string" || typeof title !== "string" || typeof repo !== "string" || typeof commitClass !== "string") return null;
  const edges: Edge[] = [];
  if (dependsOn !== undefined && dependsOn !== null) {
    if (!Array.isArray(dependsOn)) return null;
    for (const e of dependsOn) {
      if (!isRecord(e) || typeof e.type !== "string") return null;
      if (typeof e.id === "string") edges.push({ id: e.id, type: e.type });
      else if (typeof e.task === "string") edges.push({ task: e.task, type: e.type });
      else return null;
    }
  }
  return { id, title, repo, commitClass, dependsOn: edges };
}

/** Upstream before dependent (plan-local edges); ties, and any cycle's members, by id. */
export function topoOrder(tasks: TaskView[]): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const up of new Set(t.dependsOn.map((e) => e.id).filter((u): u is string => u !== undefined && u !== t.id && byId.has(u)))) {
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.set(up, [...(dependents.get(up) ?? []), t.id]);
    }
  }
  const ready = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id).sort(compare);
  const out: TaskView[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(byId.get(next) as TaskView);
    for (const d of dependents.get(next) ?? []) {
      const n = (indegree.get(d) ?? 0) - 1;
      indegree.set(d, n);
      if (n === 0) {
        ready.push(d);
        ready.sort(compare);
      }
    }
  }
  for (const t of [...tasks].sort((a, b) => compare(a.id, b.id))) if (!seen.has(t.id)) out.push(t);
  return out;
}

export function renderSummary(tasks: TaskView[]): string {
  return topoOrder(tasks)
    .map((t) => `- \`${t.id}\` — ${oneLine(t.title)} (${oneLine(t.repo)}, ${oneLine(t.commitClass)})`)
    .join("\n");
}

/**
 * Every node is declared once as `key["label"]` and the edges join keys, so no id reaches Mermaid's
 * grammar: a slug may be `end` (reserved) or hold `--` (read as an edge), and neither can break the
 * graph. Keys are `t_` + the plan task id, or `x_` + the external `TASK-<n>`, with each character
 * outside `[A-Za-z0-9]` written `_`. That is one-to-one for schema-valid ids (a slug has no `_`).
 * Nodes come in dependency order, then ids named by an edge but absent from the plan, then
 * external tasks, each by id; the edges follow in dependency order.
 */
export function renderDag(tasks: TaskView[]): string {
  const ordered = topoOrder(tasks);
  const planIds = new Set(ordered.map((t) => t.id));
  const missing = new Set<string>();
  const external = new Set<string>();
  for (const t of ordered) {
    for (const e of t.dependsOn) {
      if (e.id !== undefined) {
        if (!planIds.has(e.id)) missing.add(e.id);
      } else external.add(e.task ?? "");
    }
  }
  const lines = ["```mermaid", "graph LR"];
  for (const id of [...ordered.map((t) => t.id), ...[...missing].sort(compare)]) lines.push(`  ${nodeKey("t", id)}["${nodeLabel(id)}"]`);
  for (const task of [...external].sort(compare)) lines.push(`  ${nodeKey("x", task)}["${nodeLabel(task)}"]`);
  for (const t of ordered) {
    for (const e of t.dependsOn) {
      const from = e.id !== undefined ? nodeKey("t", e.id) : nodeKey("x", e.task ?? "");
      lines.push(`  ${from} -->|${nodeLabel(e.type)}| ${nodeKey("t", t.id)}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

function nodeKey(prefix: "t" | "x", id: string): string {
  return `${prefix}_${oneLine(id).replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** Text inside a quoted label or an edge label: one line, with Mermaid's own entity for `"`. */
function nodeLabel(text: string): string {
  return oneLine(text).replace(/"/g, "#quot;").replace(/\|/g, "#124;");
}

export type Region = { ok: true; inner: string } | { ok: false; error: string };

/** The text strictly between a begin marker line and its end marker line. */
export function readRegion(text: string, begin: string, end: string): Region {
  const lines = text.split("\n");
  const b = indexesOf(lines, begin);
  const e = indexesOf(lines, end);
  if (b.length !== 1 || e.length !== 1) {
    return { ok: false, error: `\`${begin}\` and \`${end}\` must each appear exactly once, alone on their line (found ${b.length} and ${e.length})` };
  }
  const [bi, ei] = [b[0] as number, e[0] as number];
  if (ei < bi) return { ok: false, error: `\`${end}\` comes before \`${begin}\`` };
  return { ok: true, inner: lines.slice(bi + 1, ei).join("\n") };
}

/** Replace the region's inner text; `null` when the markers are not well-formed (see `readRegion`). */
export function writeRegion(text: string, begin: string, end: string, inner: string): string | null {
  const lines = text.split("\n");
  const b = indexesOf(lines, begin);
  const e = indexesOf(lines, end);
  if (b.length !== 1 || e.length !== 1 || (e[0] as number) < (b[0] as number)) return null;
  return [...lines.slice(0, (b[0] as number) + 1), ...inner.split("\n"), ...lines.slice(e[0] as number)].join("\n");
}

/** Insert an empty marker pair after the first `## <heading>` line when a plan.md has none yet. */
export function ensureMarkers(text: string, heading: string, begin: string, end: string): string | null {
  const lines = text.split("\n");
  if (indexesOf(lines, begin).length > 0 || indexesOf(lines, end).length > 0) return text;
  const h = lines.findIndex((l) => l.replace(/\r$/, "").trim() === `## ${heading}`);
  if (h < 0) return null;
  return [...lines.slice(0, h + 1), begin, end, ...lines.slice(h + 1)].join("\n");
}

function indexesOf(lines: string[], marker: string): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.replace(/\r$/, "").trim() === marker) out.push(i);
  });
  return out;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
