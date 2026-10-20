# CLAUDE.md — operating notes for fleet sessions in this plans repository

This is the fleet's **plans repository** (README.md; design: Alissa's genloop design v0.2, D2, D3, D19, D20, §5). It holds plans, not code. Its name is
per-fleet configuration (default `<owner>/alissa-dark-factory-plans`) — never hardcode it.

## The rules

1. **One directory per plan.** A plan is exactly `plans/<yyyy-mm-dd>-<slug>/` — `plan.md` plus
   `tasks/<id>.md`, 1–8 task files, nothing else — on a branch named `PLAN-<stamp>-<slug>`. The
   directory name is the plan's `id`; the date is the pass's UTC day; the slug matches
   `[a-z0-9-]{3,48}`. A plan PR's diff touches nothing outside its own new directory.
2. **Run `plan-lint` before pushing.** `plan-lint plans/<dir>` runs the twelve rules of §5.5
   (1–9 offline; 10–12 read Alissa with `ALISSA_API_TOKEN`); `plan-lint --write plans/<dir>`
   renders the generated *Summary* and *Dependency graph* sections of `plan.md` from the task
   files — commit what it wrote, because CI checks the rendered sections for drift (rule 8). A
   plan your own run refuses is never pushed. The linter ships in `lint/`: `npm ci` once, then `node lint/plan-lint.ts …` (Node ≥ 22.18, no build step). On every
   pull request CI runs it twice — the `offline` job over the PR's own code (rules 1–9, no secret)
   and the `trusted` job over the base branch's code (rules 1–12, `ALISSA_API_TOKEN` from the
   `alissa-plan-lint` environment) — and the trusted job publishes the `plan-lint` check on the head
   commit, "nothing to lint" when no `plans/**` or `knowledge-base/**` file changed. The default branch's ruleset
   requires that check, so a refused plan cannot merge.
3. **Never touch a merged plan's directory.** A merged plan is immutable (D20). Do not edit,
   rename, delete or add to any `plans/<dir>/` that exists on `main` — `plan-lint` refuses the
   PR (rule 1). To change a committed plan, open a new plan whose `plan.md` names it
   (`supersedes: plans/<dir>`) and leave the old directory in place; to change the live work,
   edit the tasks in Studio. `materialized.json` is written by the orcloop close edge alone.
4. **Pull requests only.** Never push to `main`; never merge your own PR. The plan PR is opened
   by the genloop login requesting the reviewer seat's login; the `plan-lint` check must be green before a
   review round starts; the review ends with a `Commit-Readiness` trailer that the merge edge
   reads.
5. **Full task data, never headlines.** Every task file carries every field the task create
   takes (frontmatter of §5.3): `id`, `title`, `repo`, `milestone`, `priority`, `dependsOn`,
   `scope`, `commitClass`, `sources`, then `## Why`, `## Definition of done`, `## Criteria` in
   that order, within the sizes of §5.4. The prose is for people and the refuter; the
   frontmatter is for the linter and the seats.
6. **Edges live on the dependent task.** Declare dependencies in each task's `dependsOn` (an
   `id` inside the plan, or at most one external `TASK-<n>`); there is no edges file, and the
   Mermaid graph in `plan.md` is generated, never hand-written.
7. **Do not reformat the README's quoted sections.** The §5.1 and §5.2 blocks in README.md are
   quoted from the design without drift and pinned by a test in the plan-lint lane. Only the
   repository name differs from the design text, by the operator's decision.

## The knowledge base

`knowledge-base/` holds discovery findings (README, *The knowledge base*; design
`alissa-build-discovery.md` §2–§4). A discovery session writes exactly one new directory,
`knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/` (its task's creation day, UTC), holding `findings.md`
and, optionally, a flat `evidence/` folder (png, jpg, webp, inert svg, csv, json, mmd, d2, txt, log;
≤ 2 MB a file, 10 MB and 20 files in all), every file cited from `findings.md` as `evidence:<file>`
(K9) and nothing else; milestone 0's design task writes exactly one `knowledge-base/assessments/*.md`
file instead. Run `node lint/plan-lint.ts --kb <dir>` before pushing — rules K1–K9, K7 and K8
through Studio's verify routes — and never push a finding your own run refuses. A URL cite
(`alissa-findings/v1.1`) needs a task whose `Alissa-Sources:` is `web` or `both`, a verbatim
`quote` and, best, an `archive` taken when the page was read. The run's last line,
`Discovery-Review: none | light — <reasons>`, is the one classification of the finding for review. A merged finding is never
edited: a newer finding names it in `reverifies`. A knowledge-base PR never carries a plan, and a
plan PR never touches `knowledge-base/`.

## Non-plan changes

Tooling (the linter, schemas, fixtures, the workflow) and documentation land through ordinary
`TASK-<n>-…` branches and pull requests, never together with a plan directory: the two branch
grammars are what let devloop and revloop tell a code PR from a plan PR. A tooling change that
moves what the linter can do also moves `lint/VERSION`, the stamp Studio reads.
