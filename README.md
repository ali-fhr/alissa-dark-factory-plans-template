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
├── plans/                                 ← one directory per plan; empty until the first plan merges
│   └── <yyyy-mm-dd>-<slug>/               ← the plan's id, on branch PLAN-<stamp>-<slug>
│       ├── plan.md                        ← the plan (frontmatter + prose, §5.2)
│       ├── tasks/
│       │   └── <id>.md                    ← one file per task, 1–8 of them (§5.2)
│       └── materialized.json              ← written by the close edge AFTER the merge (D20)
├── knowledge-base/                        ← discovery findings, append-only (see "The knowledge base" below)
│   ├── <YYYY>/<MM>/<DD>/TASK-<n>/         ← one discovery task: its creation day (UTC) and number
│   │   └── findings.md                    ← schema/findings.v1.json frontmatter + prose; nothing else
│   └── assessments/
│       └── <project-slug>-<yyyy-mm-dd>.md ← milestone 0's assessment, from its one design task
└── integration-check/                     ← integration-check reports, append-only (see "The integration check" below)
    └── <YYYY>/<MM>/<DD>/<milestone>/      ← one run: its start day (UTC); <milestone> = <project-slug>-m<n>[-r<k>]
        ├── report.md                      ← schema/integration-check.v1.json frontmatter + prose
        └── evidence/                      ← logs, routes.json, screenshots; every file cited by the report
```

The plan-lint lane (design §9 L8) adds `schema/`, `lint/`, `fixtures/`, `package.json`,
`tsconfig.json` and `.github/workflows/plan-lint.yml` beside these; a plan PR never touches them,
and neither does a knowledge-base or an integration-check PR.

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
  reading every file of `plans/**`, `knowledge-base/**` and `integration-check/**` from git objects
  as data. Any `integration-check/**` change selects the integration-check mode (below); otherwise
  any `knowledge-base/**` change selects the knowledge-base mode (below); otherwise a `plans/**`
  change is a plan, and a pull request that changes none of the three succeeds with *nothing to lint*.

**The workflow** (`.github/workflows/plan-lint.yml`) runs on every pull request, with no path
filter, as two jobs split by trust. The **offline** job (`pull_request`) runs the pull request's own
code — the type check, the tests and its linter, rules 1–9 — with no secret and a read-only token.
The **trusted** job (`pull_request_target`) checks out the base branch only, installs the base's
lockfile, fetches the pull request's commits as objects, runs the base branch's linter over them
with `ALISSA_API_TOKEN` from the `alissa-plan-lint` environment (rules 1–12), and publishes the check run
named **`plan-lint`** on the pull request's head commit — `success` with *nothing to lint* when no
`plans/**`, `knowledge-base/**` or `integration-check/**` file changed. That check run is the run of record: the one a ruleset requires and the close edge reads (§5.5 rule 13).
`lint/test/workflow.test.ts` pins this structure, and `lint/test/pr-mode.test.ts` shows that a
pull request's own linter, package scripts and git drivers never run in the trusted mode.

**The layout** of the tooling: `schema/` (the plan and task schemas, pinned by
`lint/test/design.test.ts` against the design at a named commit: the plan schema byte-equal to
§5.3, the task schema §5.3's bumped in place to **version 1.3** — v1.1's optional `kind`, optional
`new[]` and edge type widened to `acceptance`; v1.2's `kind: discovery` branch; v1.3's discovery
`sources`, and `repo` and `milestone` optional for a web task and an ask — `$id` unchanged,
with nothing else changed; `findings.v1.json`, the knowledge base's; and `integration-check.v1.json`,
an integration-check report's), `lint/` (the linter, its tests and the `VERSION` stamp), `fixtures/`
(a golden plan that passes, at least one plan per rule failing exactly that rule — `rule-<nn>[b]-<what>`,
one per schema v1.1 refusal and one for rule 5b — the Alissa and GitHub state the tests' fake APIs
serve for rules 10–12 and 5b, the knowledge-base cases `kb-golden`, `kb-golden-web`, `kb-evidence`, `kb-assessment`,
one `kb-k<n>-<what>` per K rule and one `kb-k8-<verdict>` per K8 verdict, and under `fixtures/integration-check/` the run `ic-golden` and one
`ic-i<n>-<what>` per I rule).

**Schema v1.2 — `kind: discovery`** (design `docs/design/alissa-build-discovery.md` §2.2, lane
DS-2). A discovery task reads a code repository and writes only the knowledge base, so its task
file names **no `scope`** (and no `new`) — `feed_plan` derives `knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/**`
when it creates the task — and carries **`questions`** instead, 1–12 of `{ id, text, unblocks:
[{ decision, impact: high | medium | low }] }`. Its `commitClass` is always `doc-correction`, and
its `repo` is the repository it reads (rule 12 still checks its feed). A code or design task is
unchanged: `scope` required, no `questions`.

**Schema v1.3 — web discovery and asks** (design §2.2, §4.6, lane DS-10). A discovery task's
`sources` may say what its questions read — `code`, `web` or `both`; absent reads as `code`, and a
list of source keys keeps its rule 9 meaning — and `feed_plan` renders anything but `code` as an
`Alissa-Sources:` trailer, which K6 reads. A `sources: web` task may omit **`repo`**: it reads no
repository, carries `Alissa-Reads: none`, and rule 12's feed check skips it. A project-less ask
names **`asker: TASK-<n>`**, the task the question came from, and may omit **`milestone`** — but an
ask has no plan, so rule 10 refuses a plan task without one. A code or design task carries neither
`asker` nor a `code | web | both` `sources`.

```yaml
kind: discovery
commitClass: doc-correction
questions:
  - id: q1
    text: Where does an order's total get computed, and is it recomputed on edit?
    unblocks:
      - { decision: "Whether milestone 2 must touch discount recomputation", impact: high }
```

## The knowledge base — `plan-lint`'s knowledge-base mode

A discovery task (design `alissa-build-discovery.md` §2–§4) answers its questions about one code
repository, read at a pinned SHA, and writes exactly one new directory here:
`knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/findings.md`, the date being the task's creation day
(UTC), with an optional `evidence/` folder beside it (below). Its frontmatter validates against
`schema/findings.v1.json` (`schema: alissa-findings/v1`, `alissa-findings/v1.1` or `/v1.2`, `task`, `project`, `reads` — each repository at its 40-hex SHA —
`topics`, `questions` with their `status`, `confidence`, `answer` or `reason`, `cites` and
`unblocks`, then optional `risks` and `suggestedTasks`); its body is a `## Summary` and one section
per question.

**Findings v1.1** (design §2.5, §4.6, lane DS-10) widens the same file in place, so every v1 file
validates as written:

- **The URL cite**, beside the repo cite, in questions and risks alike: `{ kind: url, url,
  retrievedAt, quote, archive? }`. `url` is `https://`, at most 2,048 characters, with no userinfo
  and no token-shaped query parameter; `retrievedAt` is RFC 3339 in UTC, not in the future and not
  before the directory's day; `quote` is 20–300 characters on one line, verbatim from the page;
  `archive`, when present, is a `web.archive.org/web/<14-digit timestamp>/…` or `archive.ph` capture.
  A repo cite may say `kind: repo`. At most 48 URL cites per file. A URL cite is admitted only on a
  task whose `Alissa-Sources:` is `web` or `both` (K6).
- **The key**: exactly one of `project` and `bodyOfWork` (a `oneOf` — both, or neither, is
  refused), and `asker: TASK-<n>` on a project-less ask.
- **`reads` may be empty** when every cite is a URL cite; a repo cite still names a read repository.

**Evidence — findings v1.2** (operator decision 2026-10-20, amending design §4.2): a finding may
carry artifacts — screenshots, diagrams, small data — the way an integration-check run carries its
`evidence/`:

- **The folder.** Beside `findings.md`, an optional `evidence/<file>`: flat (no subfolders), regular
  files only, each named `[a-z0-9][a-z0-9._-]{0,63}`, added once and never edited, like the finding.
- **The types**, by extension — and an image by its first bytes too: `png`, `jpg`/`jpeg`, `webp`,
  `svg`, `csv`, `json`, `mmd` (Mermaid), `d2`, `txt`, `log`. Anything else is refused by name. An
  svg must be inert: SVG elements only (an allowlist, so an HTML tag such as `<img>`, `<meta>` or
  `<table>` is refused), no `<script>` (namespace prefix or not), no DTD (`<!DOCTYPE`/`<!ENTITY`), no
  `<foreignObject>` or XHTML namespace, no `on…=` event handler, no `href` or `src` other than a
  `#fragment`, no `srcset` or `ping`, no animation (`animate`, `set`, …) that rewrites an `href`/`src`/`ping` or holds a URL, no
  `srcdoc`, no style that loads from outside the file (`url(…)`, `image-set(…)`, `@import`, a quoted
  function argument — in `style`, `<style>` or any presentation attribute), no backslash (CSS escape) in an attribute or style, and no character reference
  other than a well-formed `&#…;` or the five XML names — every check reads the text with its
  references decoded, as the parser does. Text evidence is UTF-8 (a UTF-8 BOM is fine; UTF-16,
  NUL bytes and invalid sequences are refused), so the svg and secret scans read what a viewer renders.
- **The caps**: at most 2 MB per file, 10 MB per folder and 20 files.
- **The cites.** `findings.md` cites a file as `evidence:<file>` — inline, anywhere in the file
  (*"the settings page today [evidence:settings-1440.png]"*), and/or in a question's or risk's
  `cites` as `{ kind: evidence, file: <file> }`, which needs `schema: alissa-findings/v1.2`. Every
  file is cited at least once and every cite names a file in the folder (K9). An evidence cite counts
  as K3's cite, and goes to no Studio route.

`fixtures/kb-evidence` is the golden finding with a cited png and csv.

The knowledge base is
**append-only**: a merged finding is never edited, and a newer one names it in `reverifies`. The
index of findings is a Studio projection, never a committed file.

Any pull request that changes a `knowledge-base/**` file is linted in the **knowledge-base mode** —
never *nothing to lint* — under the K rules, numbered apart from §5.5's:

| Rule | Name | Refuses | Reads |
|---|---|---|---|
| K1 | layout and immutability | a diff outside **one** new `knowledge-base/<YYYY>/<MM>/<DD>/TASK-<n>/` directory (a mix with `plans/**` included); a directory already on the base branch; anything in it but `findings.md` and a flat `evidence/` folder; a nested `evidence/` path, a symlink, an evidence file misnamed, of a type not admitted, an image whose bytes are not its type, text evidence that is not UTF-8, or an svg that is not inert; a date that is not a real calendar day; a change that is not an add. **The one exception:** exactly one new `knowledge-base/assessments/<project-slug>-<yyyy-mm-dd>.md` file and nothing else, from a `kind: design` task (milestone 0's assessment, §7.1) — the pull request's task is its `TASK-<n>-…` branch (`GITHUB_HEAD_REF`) or `--task` | git; Alissa for the assessment's task |
| K2 | frontmatter | frontmatter that does not split, parse or validate against `schema/findings.v1.json`; a `task` that is not the directory's; a repeated question id or `reads` repository; a cite of a repository not in `reads` | — |
| K3 | completeness | an `answered` or `partial` question with no `answer`; an `unanswerable` one with no `reason`; an `answered` one with no cite; a body with no `## Summary` | — |
| K4 | size | `findings.md` over 32 KB; more than 12 questions, 12 risks, 8 suggested tasks or 24 cites per entry; a cite spanning more than 400 lines; a `## Summary` over 1,200 characters or a question's section over 6,000; an evidence file over 2 MB, a folder over 10 MB or 20 files | — |
| K5 | hygiene | a cite of a deny-listed path, or secret-shaped text anywhere in the file (an assessment's too) or in a text evidence file (`svg`, `csv`, `json`, `mmd`, `d2`, `txt`, `log`) — the deny-list and token shapes of Studio's `convex/core/repoContextFilter.ts` (NT-2's list as widened by BC1), inlined in `lint/rules.ts` with the commit and filter version they were copied at | — |
| K6 | task | a `task` that does not resolve, is not `kind: discovery`, was created on another day (UTC) than its directory's, or whose `Alissa-Reads: <owner>/<repo>@<sha>` trailer pins another SHA than `reads` (or another repository); `Alissa-Reads: none` with a non-empty `reads`; a URL cite on a task with no `Alissa-Sources: web` or `both`; an `asker` that does not resolve, belongs to another owner, or differs from the task's `Alissa-Asker:` — `GET /v1/tasks/:id?view=full` with the lint token | Alissa |
| K7 | cites resolve | a cited path that does not exist at its `reads` SHA, whose blob differs from `blob`, or whose line range runs past the file's end — asked of Studio, never of GitHub | Studio |
| K8 | external cites hold | a URL cite whose page is `refuted` (it answers, and neither it nor the archive holds the quote), `gone` (404 or 410, and no archive holds it) or `blocked` (401, 403, 429, a paywall, or a URL Studio's fetch guard refuses, and no archive); `unavailable` (a 5xx or a timeout) is *plan-lint could not run*. `archived` — only the archive holds the quote — passes, and the projection marks the cite stale. Asked of Studio, never fetched from the runner | Studio |
| K9 | evidence cited | an `evidence/` file that `findings.md` never cites; an `evidence:<file>` cite — inline or `{ kind: evidence, file }` — naming a file that is not in the folder | — |

```sh
npm run plan-lint -- --kb knowledge-base/2026/10/14/TASK-1234             # K1–K9 (K6–K8 need ALISSA_API_TOKEN)
npm run plan-lint -- --kb knowledge-base/2026/10/14/TASK-1234 --offline   # K1–K5 and K9 only, no network
npm run plan-lint -- --kb knowledge-base/assessments/shop-2026-10-14.md --task TASK-2000
```

- **K7 goes through Studio's verify route**, so no GitHub credential ever enters this repository.
  The linter posts every distinct cite once, `POST /v1/factory/repo-files/verify` with the lint
  token and the body `{ "files": [{ "repo", "sha", "path", "blob", "lines" }] }`, and expects
  `200 { "results": [{ "ok": true } | { "ok": false, "reason": "path_missing" | "blob_mismatch" |
  "lines_out_of_range", "detail"?: "…" }] }`, one result per file in request order.
- **K8 goes through Studio's url-cites route**, which fetches each page behind DS-16's guarded fetch
  (https only, every resolved address checked, redirects re-checked, no credentials), so the trusted
  job, which holds the lint token, never fetches a URL a PR author chose. The linter posts every
  distinct URL cite once, `POST /v1/factory/url-cites/verify` with the body `{ "cites": [{ "url",
  "quote", "archive"? }] }`, and expects `200 { "results": [{ "verdict": "holds" | "archived" |
  "refuted" | "gone" | "blocked" | "unavailable", "detail"?, "guard"?, "archive"? }] }`, one result
  per cite in request order. **What K8 cannot prove** (design §3.4): that the source is right or
  current, that the quote supports the answer or is not cut from a context that reverses it, that
  the live page said it at `retrievedAt` (only an archive carries its own date), anything on a page
  rendered by script or behind a login, or the synthesis of several true quotes. That is what the
  light review is for.
- **The review line.** A finding's report — the check run's summary, and the local `--kb` run's
  output — ends with one machine-read line: `Discovery-Review: none` when every cite is a repo
  cite and no question's `unblocks` carries `impact: high`, otherwise `Discovery-Review: light —
  <reasons>`, the reasons being `external cites: <n>` and `high impact: <question ids>`, joined by
  `; ` (design §3.6). devloop, revloop and orcloop read this line, never their own reading of the
  file. Findings too malformed to classify (K2) carry no line; a reader takes a missing line as
  `light`.
- **Fail closed.** When the route is down, answers an error or an unexpected shape — or Alissa
  cannot be read for K6, or K8's route answers `unavailable` for a cite — the run reports
  **`plan-lint could not run`**: the check's conclusion is `failure` and its title starts with those
  words. It is never a pass. Without `ALISSA_API_TOKEN` the linter refuses to run rather than skip
  K6–K8.
- **The check's title says the mode**: `PASS — knowledge-base — <dir>`, `FAIL — K<n> (<name>) —
  knowledge-base — <dir>`, or `plan-lint could not run — K<n> (<name>) — <dir>`. orcloop's merge
  edge merges a discovery PR on the first of these (design §3.5).
- **`lint/VERSION`** is the template's version stamp, `key: value` lines. Studio's advisory
  readiness check `plans-repo-kb-lint` reads it (design §12 Q2): a plans repository whose stamp
  lacks `modes: … knowledge-base` gets no discovery tasks planned for it, and one whose stamp lacks
  `findings-schema: alissa-findings/v1.1` and `K8` in `kb-rules` gets no URL cites (lane DS-11); one
  whose stamp lacks `alissa-findings/v1.2` and `K9` lints no `evidence/` folder.
  `lint/test/kb.test.ts` keeps the stamp in step with the schemas and the rules.
- **Rollout.** The template changes new plans repositories only; the provisioner never overwrites
  an adopted one. Until an existing repository is upgraded — by an ordinary `TASK-` lane in that
  repository — its `knowledge-base/` pull requests still pass *nothing to lint*, which is why
  Studio reads the stamp first.

## The integration check — `plan-lint`'s integration-check mode

When a milestone's tasks are built, Studio feeds one `kind: integration_check` task into this
repository (design `alissa-build-integration-check.md` §3). Its devloop session builds and starts the
milestone's repositories at the SHAs its `Alissa-Reads:` lines pin, checks every milestone criterion
and the moving pieces around it against the running product, and writes exactly one new directory
here: `integration-check/<YYYY>/<MM>/<DD>/<milestone>/`, the date being the run's start day (UTC)
and `<milestone>` `<project-slug>-m<n>` (the project's title slugified to at most 32 characters, the
milestone's position in the chain; `-r2`, `-r3`, … for a second run the same day). It holds
`report.md` and `evidence/**` — logs, `routes.json`, screenshots — and nothing else.

`report.md`'s frontmatter validates against `schema/integration-check.v1.json` (`schema:
alissa-integration-check/v1`, `task`, `check`, `project`, `milestone: { id, n, title }`, `run`,
`previous`, `notes`, `reads`, `recipe`, `status`, `couldntVerify`, `steps`, `criteria`,
`neighbours`, `scope` — §3.4). Every `evidence` entry is a path inside the run directory,
`evidence/<file>`. The body opens with `## Couldn't verify`, then `## Summary`, `## Criteria`,
`## Neighbours` and `## Steps`. The integration check is **append-only**: a merged run is never
edited; a new run is a new directory whose report names the last one in `previous`, and the newest
run is authoritative.

The **status** is not the session's to choose. It follows from the verdicts — §4.1's `statusOf`,
which `lint/rules.ts` carries verbatim and Studio recomputes on merge:

```ts
function statusOf(r: IntegrationReport): "SUCCESS" | "UNCERTAIN" | "FAILED" {
  const verdicts = [...r.steps, ...r.criteria, ...r.neighbours].map((x) => x.verdict);
  if (verdicts.includes("fail")) return "FAILED";
  const started = r.steps.find((s) => s.id === "start")?.verdict === "pass";
  if (!started || r.criteria.some((c) => c.verdict !== "pass")) return "UNCERTAIN";
  return "SUCCESS";
}
```

Any pull request that changes an `integration-check/**` file is linted in the **integration-check
mode** — never *nothing to lint* — under the I rules, numbered apart from §5.5's and the K rules:

| Rule | Name | Refuses | Reads |
|---|---|---|---|
| I1 | layout and immutability | a diff outside **one** new `integration-check/<YYYY>/<MM>/<DD>/<milestone>/` directory (a mix with `plans/**` or `knowledge-base/**` included); a directory already on the base branch; anything in it but `report.md` and `evidence/**`; a date that is not a real calendar day; a `<milestone>` that is not `<project-slug>-m<n>[-r<k>]`; a change that is not an add | git |
| I2 | frontmatter | frontmatter that does not split, parse or validate against `schema/integration-check.v1.json`; a `task` that is not the pull request's `TASK-<n>-…` branch's (`GITHUB_HEAD_REF`, or `--task`); a `milestone.n` other than the directory's `m<n>`; a repeated id — a Couldn't verify item, a step, a criterion, a neighbour, a `reads` or `recipe` repository | — |
| I3 | every criterion has a verdict | a milestone criterion with no verdict, or with two; a verdict for a criterion the milestone does not have — the criteria are read with the lint token, `GET /v1/projects/:id`, from the milestone whose `_id` (or body of work) is `milestone.id` | Alissa |
| I4 | every verdict cites evidence that exists | a `pass` or `fail` with no evidence; an evidence path that is not a file under the run's `evidence/`; a draft recipe whose `path` is not one; an evidence file no verdict, step, item or recipe cites | — |
| I5 | every unverified item is honest | an `unverified` criterion that no Couldn't verify item names (its `unverified`, or an item's `criterion`); an `unverified` step or neighbour with an empty Couldn't verify list; an item with no `why` or no `howToCheck`; an item or criterion naming one that does not exist; a body whose first section is not `## Couldn't verify` | — |
| I6 | the status follows the rules | a `status` that is not `statusOf(report)` (§4.1); a criterion or neighbour that is `fail` with no `failure` | — |
| I7 | size and types | `report.md` over 48 KB; more than 60 evidence files or 25 MB in all; an evidence file over 2 MB; a type outside `png`, `jpg`, `webp`, `log`, `txt`, `json`, `yml` | — |
| I8 | hygiene | secret-shaped text in the report or a text evidence file (`log`, `txt`, `json`, `yml`) — K5's token shapes; a `notes` entry that is not a variable name, `^[A-Z][A-Z0-9_]{1,63}$` (§5.2: notes name variables, never values) | — |
| I9 | task | a `task` that does not resolve, is not `kind: integration_check`, or whose `Alissa-Reads: <owner>/<repo>@<sha>` lines differ from `reads`, in either direction — `GET /v1/tasks/:id?view=full` with the lint token | Alissa |

```sh
npm run plan-lint -- --ic integration-check/2026/10/18/shop-m1                    # I1–I9 (I3 and I9 need ALISSA_API_TOKEN)
npm run plan-lint -- --ic integration-check/2026/10/18/shop-m1 --offline          # I1, I2 and I4–I8, no network
npm run plan-lint -- --ic integration-check/2026/10/18/shop-m1 --task TASK-3000   # I2 also checks the report's task
```

- **The check's title says the mode**: `PASS — integration-check — <dir>`, `FAIL — I<n> (<name>) —
  integration-check — <dir>`, or `plan-lint could not run — I<n> (<name>) — <dir>`. orcloop's merge
  edge merges an integration-check PR on the first of these (design §3.6).
- **Fail closed**, as the knowledge-base mode: when Alissa cannot be read for I3 or I9 the run
  reports **`plan-lint could not run`**, a `failure`, never a pass; without `ALISSA_API_TOKEN` the
  linter refuses to run rather than skip I3 and I9.
- **What git will push.** CI reads the commit, while `--ic` reads the file system. So inside a
  git work tree, `--ic` refuses (I1) any run file that git ignores, and notes any file that is
  not tracked yet. A `*.log` ignore rule otherwise drops the run's required logs from the push.
- **The stamp.** `lint/VERSION` reads `modes: plan knowledge-base integration-check`, with
  `ic-schema: alissa-integration-check/v1` and `ic-rules: I1 I2 I3 I4 I5 I6 I7 I8 I9`. A plans
  repository whose stamp lacks the mode reads `behind` with `modesMissing: ["integration-check"]`;
  **Update plan-lint** brings it current, and until then Studio starts no check there (§3.5).
  `lint/test/ic.test.ts` keeps the stamp in step with the schema and the rules.

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
