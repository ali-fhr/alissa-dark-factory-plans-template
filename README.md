# Alissa Dark Factory — plans repository template

The template every Alissa Dark Factory fleet's **plans repository** is created from. In a fleet's
copy, every plan the fleet's judgment seat (genloop) proposes is one pull request, every accepted
plan is one directory under `plans/`, and the repository's `git log` is the fleet's history of
proposals — accepted and refused. No code lives here; the plans are the product.

This template holds the tooling only — the linter, the schemas, the fixtures and the `plan-lint`
workflow — and no plan. Alissa's provisioner creates a fleet's plans repository from it and then
configures the seats' access, the `alissa-plan-lint` environment, its secret and the ruleset
(see *Identities and setup* below). The contract is Alissa's genloop design, v0.2 (D2, D3, D19,
D20 and §5).

## The repository's name is per-fleet configuration

A fleet's plans repository is **configured per fleet, never a literal**: its default name is
`your-org/alissa-dark-factory-plans`, consistent with the seat repositories' prefix. Every daemon,
skill and session that reads or writes plans takes the name from the fleet's configuration, and
nothing in this repository names it.

## Layout

```
.
├── README.md                              ← this file
├── CLAUDE.md                              ← operating notes for the fleet's sessions here
├── .gitignore
└── plans/                                 ← one directory per plan; empty until the first plan merges
    └── <yyyy-mm-dd>-<slug>/               ← the plan's id, on branch PLAN-<stamp>-<slug>
        ├── plan.md                        ← the plan (frontmatter + prose, §5.2)
        ├── tasks/
        │   └── <id>.md                    ← one file per task, 1–8 of them (§5.2)
        └── materialized.json              ← written by the close edge AFTER the merge (D20)
```

The plan-lint lane (design §9 L8) adds `schema/`, `lint/`, `fixtures/`, `package.json`,
`tsconfig.json` and `.github/workflows/plan-lint.yml` beside these; a plan PR never touches them.

The two sections below are quoted from the design (§5.1 and §5.2 of v0.2) **without drift** —
the plan-lint lane pins them with a test — with the single substitution of the plans repository's name.
The D-, §- and rule references inside them point into the design document.

## The plan — location and files (design §5.1, §5.2)

### 5.1 Location

`plans/<yyyy-mm-dd>-<slug>/` in `your-org/alissa-dark-factory-plans` (D19), one directory per plan, on branch
`PLAN-<stamp>-<slug>` (D2); the date is the pass's UTC day, the slug `[a-z0-9-]{3,48}`, and the
directory name is the plan's `id`. The directory holds `plan.md`, `tasks/<id>.md` for each task
(D16) and — after the merge, written by the close edge — `materialized.json` (D20); nothing else,
and a plan PR's diff touches nothing outside its own new directory (§5.5 rule 1). The layout is
fixed: there is no per-repository override, because there is one repository. A plan that spans
several target repositories is one plan — each task's `repo` says where it lands, and the
cross-repo edge is an ordinary `dependsOn` entry (D17); a plan that supersedes another names it
(`supersedes: plans/<dir>`) and both stay.

### 5.2 The files

`plan.md`:

~~~markdown
---
id: <yyyy-mm-dd>-<slug>
title: <title>
anchor: { kind: <milestone|criterion|objective|exhaust>, … }
program: <projectId>
milestone: <bodyOfWorkId>                # absent only on an exhaust anchor (§10 Q3)
sources:
  - { key: <source key>, evidence: <one line> }
budget: { estimateUsd: <n>, basis: <one line> }
supersedes: plans/<dir>                  # when one
---
# Plan: <title>
<!-- alissa-genloop:plan v1 -->

## Why now
## What it serves
## Summary
<!-- plan-summary:begin -->
- `<id>` — <task title> (<repo>, <commitClass>)
<!-- plan-summary:end -->
## Dependency graph
<!-- plan-dag:begin -->
```mermaid
graph LR
  <id> -->|hard| <id>
```
<!-- plan-dag:end -->
## Considered and skipped
## Open questions for the reviewer
~~~

`tasks/<id>.md`:

~~~markdown
---
id: <slug>
title: <title>
repo: <owner>/<repo>
milestone: <bodyOfWorkId>
priority: <low|medium|high|top>
dependsOn:
  - { id: <slug>, type: <hard|soft> }
  - { task: TASK-<n>, type: <hard|soft> }
scope:
  - <glob>
commitClass: <one of §7.1, never unanchored>
sources:
  - <source key>
---
## Why
## Definition of done
## Criteria
- <criterion>
~~~

The prose is for people and the refuter; the frontmatter is for the linter and the seats. The
order is fixed so the rendered PR body (the seat copies `plan.md`'s header lines, *Why now* and
*Summary* into it) reads the same on every plan. The *Summary* and *Dependency graph* sections
are generated (`plan-lint --write`, D17) and checked (§5.5 rule 8); everything else is the
session's. In a task file, everything above `## Definition of done` is the task's `description`
(the author may add sections — *What*, *Out of scope*, *Contracts* — after *Why*), the
*Definition of done* section is its `definitionOfDone`, and each list item under *Criteria* is
one `validationCriteria` entry, `c1…cN` in order, `type: manual` (D15). The close edge appends
`Alissa-Source:` (one line per `sources` entry), `Alissa-Plan:` and `Autonomous-Scope:` as the
description's last lines (§5.6).

## How a plan is proposed

1. **A pass writes a plan.** genloop's pass — one judgment session under the genloop seat's own
   GitHub and Alissa identities (D12) — reads the operator's direction and the fleet's exhaust,
   and writes one new directory `plans/<yyyy-mm-dd>-<slug>/`: `plan.md` and one task file per
   task, full task data in the frontmatter (D15, D16), 1–8 tasks (D7).
2. **It lints before it pushes.** The session runs `plan-lint` on the directory (rules 1–12 of
   §5.5, and rule 5b) and `plan-lint --write` renders the generated *Summary* and *Dependency graph* sections
   of `plan.md` from the task files (D17). A plan the session's run refuses is never pushed.
3. **It opens a pull request.** The directory goes on branch `PLAN-<stamp>-<slug>` (the stamp is
   the pass's `%Y%m%dT%H%M%SZ`), opened as a PR by the genloop login requesting `alissa-app`
   (D2). The PR body is a rendering — the seat copies `plan.md`'s header lines, *Why now* and
   *Summary* into it — and the files are the truth. A plan PR's diff touches nothing outside its
   own new directory (§5.5 rule 1).
4. **CI lints it.** The `plan-lint` check run is the run of record (D18); every review round
   waits behind a green check.
5. **A fresh refuter reviews it.** The reviewer seat (revloop) spawns a fresh session that
   attacks the plan against the six judgment questions of the plan review directive (§6.2),
   reads the target code the plan names with `gh` under the reviewer login (never a clone), and
   closes its review with a `Commit-Readiness` trailer (§6.3). The PR thread is the operator's
   channel back to the generator: a rejection with a reason becomes a `proposalRules` row (D13).
6. **The operator, or the policy, decides.** A classed approve plus the fleet's commit policy
   (`ALISSA_ORC_COMMIT_POLICY strict|standard|yolo`, §7) decides whether the plan is merged by
   the merge edge or waits for the operator. A refused plan is a closed PR, never merged; its
   reasons stay on the thread.

## What merging does

**Merging the plan is committing it** (D3). orcloop's plan close edge enumerates merged plan PRs,
reads the plan directory **from the merge commit**, requires the `plan-lint` check on the PR's
head to have concluded `success`, re-runs only the checks time can change (§5.5 rules 13–16 —
spent sources, budgets, the park switch), and then **materializes** the tasks in dependency
order (§5.6): each task file becomes one Alissa task created with the file's own data, owned by
the fleet actor, chained with the declared `dependsOn` edges, attached to the milestone body of
work it names and to its `repo`'s `autodev:` feed, and set `committed` — from there the release
edge treats it like any other task. Every created task's description ends with
`Alissa-Plan: your-org/alissa-dark-factory-plans#<pr>/<id>` above its `Autonomous-Scope:` line,
so the task and the plan find each other.

The close edge records the result beside the plan as `plans/<dir>/materialized.json` —
`{ version, plan, pr, mergeSha, materializedAt, tasks: { <id>: { task, id } } }` — in one commit
on the default branch under the orcloop login: the only commit to a plan directory that is not a
plan PR. Materialization is idempotent: a re-run reads that file first and creates nothing it
names; before the file exists, the PR-comment record and a title read-back are the fallback, so
no crash point creates a task twice. The edge never deletes or cancels a task it created — an
operator who wants a materialized plan undone cancels the tasks in Studio, and the directory
stays as the record.

## A merged plan is never edited

**A merged plan is immutable (D20): `plan-lint` refuses any PR whose diff touches a plan
directory already on the default branch, so a change to a committed plan goes through a new plan
PR (`supersedes: plans/<dir>`, both directories stay) or through ordinary task edits in Studio —
the plan is the record of what was committed, and the tasks are the live work.**

## plan-lint — usage

`plan-lint` is the linter of design §5.5 (lane L8): TypeScript on Node ≥ 22.18, run straight from
source (Node strips the types), YAML through `yaml`, the two JSON Schemas of §5.3 under `schema/`
through `ajv`. Install once with `npm ci`, then:

```sh
npm run plan-lint -- plans/<yyyy-mm-dd>-<slug>            # rules 1–12 and 5b (10–12 need ALISSA_API_TOKEN)
npm run plan-lint -- --offline plans/<yyyy-mm-dd>-<slug>  # rules 1–9 only, no network
npm run plan-lint -- --write plans/<yyyy-mm-dd>-<slug>    # render Summary + Dependency graph, then lint
npm run check                                             # type check + the test suite
```

The rules — §5.5's twelve, plus rule 5b of the operator-surface design (`docs/design/loop-operator-surface.md`
§2.12, lane L12) — in verdict order:

| Rule | Name | Refuses | Reads |
|---|---|---|---|
| 1 | layout and immutability | anything in the plan directory but `plan.md` and `tasks/<id>.md`; a bad directory name; a plan directory already on the default branch; a PR diff outside its one new plan directory | git |
| 2 | frontmatter | frontmatter that does not split, parse or validate against `schema/` — including, from task schema v1.1, a `kind` other than `code`/`design`, a dependency `type` other than `hard`/`soft`/`acceptance`, and a `new` entry that is not also in `scope`; a plan `id` or task file name that is not its directory's or `id`'s | — |
| 3 | count | fewer than 1 or more than 8 task files | — |
| 4 | graph | a `dependsOn.id` that names no task of the plan, a self-edge, a duplicate, a cycle, more than one external `TASK-<n>` | — |
| 5 | scope | a scope entry that leaves the repository, is a bare wildcard or a top-level directory glob | — |
| **5b** | **scope paths** | **a non-glob scope entry that does not exist at its `repo`'s default branch and is not declared in `new` (`scope_path_missing`). A repository or path the linter cannot read is `scope_path_unknown` — printed as a warning, never a pass and never a refusal (D12). Globs are not checked.** | **GitHub** |
| 6 | class | a missing or unknown `commitClass` (`unanchored` is the refuter's alone) | — |
| 7 | body | `## Why`, `## Definition of done`, `## Criteria` missing or out of order; the §5.4 sizes | — |
| 8 | generated sections | a Summary or Dependency graph that is not what `--write` renders | — |
| 9 | sources | a task source not in `plan.md`'s; an exhaust anchor's sources of the wrong class | — |
| 10 | anchor | a program, milestone, criterion or objective that does not resolve or is closed | Alissa |
| 11 | external edges | an external `TASK-<n>` that does not resolve or is not `pending_validation`/`validated` | Alissa |
| 12 | repositories and off-limits | a `repo` with no `autodev:` feed; a scope entry under the steering record's `offLimits` | Alissa |

Rule 5b runs with the online rules (10–12): it reads `GET /repos/<repo>` for the default branch
and one `contents` read per non-glob path at that branch, with `GITHUB_TOKEN` (or `GH_TOKEN`)
when set and anonymously otherwise — which reaches public repositories only, so a private
target without a token warns rather than refuses. `GITHUB_API_URL` overrides
`https://api.github.com`. A path the task will create goes in `new` (each entry also in `scope`):

```yaml
scope:
  - src/config/load.ts
  - src/config/keys.ts
new:
  - src/config/keys.ts
kind: code            # optional, code | design (default code)
```

- **The verdict names the rule.** Every rule runs; the first failure, in rule order, is the
  verdict (`plan-lint: FAIL rule <n> (<name>) — <file>: …`), every other finding follows it, and
  the header line carries the task count and the **plan's class** — the most severe `commitClass`
  of its tasks in §7.1's order. Exit status: `0` passed, `1` refused, `2` a usage or read error.
- **`--write` is idempotent.** It rewrites only the text between the `plan-summary` and `plan-dag`
  markers of `plan.md` (inserting the markers under `## Summary` and `## Dependency graph` when
  they are missing), from the task files alone; a second run changes nothing. Commit what it wrote —
  rule 8 fails on any drift.
- **Rule 1's immutability half** is checked against `origin/HEAD` when it resolves (`--base <ref>`
  names another branch, `--no-base` skips it). In CI it is checked against the pull request's base.
- **Online rules fail closed.** Without `ALISSA_API_TOKEN` the linter refuses to run rather than
  skip rules 10–12; an Alissa read that errors fails its rule. Rule 5b's unreadable GitHub reads
  are warnings by design (D12), listed under the verdict and counted in the check's title. `ALISSA_BASE` overrides
  `https://api.alissa.app`.
- **`--pr --base <rev> --head <rev>`** is the CI mode: it lints what the pull request changed,
  reading every file of `plans/**` from git objects as data, and succeeds with *nothing to lint*
  when no `plans/**` file changed.

**The workflow** (`.github/workflows/plan-lint.yml`) runs on every pull request, with no path
filter, as two jobs split by trust. The **offline** job (`pull_request`) runs the pull request's own
code — the type check, the tests and its linter, rules 1–9 — with no secret and a read-only token.
The **trusted** job (`pull_request_target`) checks out the base branch only, installs the base's
lockfile, fetches the pull request's commits as objects, runs the base branch's linter over them
with `ALISSA_API_TOKEN` from the `alissa-plan-lint` environment (rules 1–12), and publishes the check run
named **`plan-lint`** on the pull request's head commit — `success` with *nothing to lint* when no
`plans/**` file changed. That check run is the run of record: the one a ruleset requires and the close edge reads (§5.5 rule 13).
`lint/test/workflow.test.ts` pins this structure, and `lint/test/pr-mode.test.ts` shows that a
pull request's own linter, package scripts and git drivers never run in the trusted mode.

**The layout** of the tooling: `schema/` (the two schemas, pinned by `lint/test/design.test.ts`
against the design at a named commit: the plan schema byte-equal to §5.3, the task schema §5.3's
bumped in place to **version 1.1** — optional `kind`, optional `new[]`, edge type widened to
`acceptance`, `$id` unchanged — with nothing else changed), `lint/` (the linter and its tests),
`fixtures/` (a golden plan that passes, at least one plan per rule failing exactly that rule —
`rule-<nn>[b]-<what>`, one per schema v1.1 refusal and one for rule 5b — and the Alissa and GitHub
state the tests' fake APIs serve for rules 10–12 and 5b).

## Identities and setup

Set up by Alissa's provisioner (or by hand, following the same list):

- The fleet's developer seat login — `write`; the reviewer seat login — `read`; the orchestrator
  login — `maintain` when it is a separate login (it writes `materialized.json` past the ruleset);
  the genloop login — `write`, once that login exists.
- The feed body of work `autodev: <owner>/<this repository>`, owned by the fleet's actor, and the
  three loop labels `alissa:develop`, `alissa:maintain`, `alissa:revert`.
- The default-branch ruleset — pull requests only, the `plan-lint` check required from the GitHub
  Actions integration, deletion and force-push blocked, and the `maintain` role on the bypass list
  only when the orchestrator has its own login — and the `ALISSA_API_TOKEN` secret for
  `plan-lint`'s online rules (§5.5 rules 10–12). The secret belongs to the environment
  `alissa-plan-lint`, whose deployment branches are limited to the default branch — never at
  repository level, where a pull request's own workflow file could read it.

Operating notes for sessions working in this repository are in [`CLAUDE.md`](CLAUDE.md).
