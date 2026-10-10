### 5.1 Location

`plans/<yyyy-mm-dd>-<slug>/` in `ali-fhr/alissa-plans` (D19), one directory per plan, on branch
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

### 5.3 The frontmatter and its JSON Schema

A task file's frontmatter, filled — a drift plan of two tasks on §1.4's base-image example (the
upgrade notes in `alissa-loopwork`, then devloop's pin), the second task shown:

```yaml
id: devloop-base-image-pin
title: "devloop's leaf Dockerfile follows alissa-loopwork-base to the released VERSION"
repo: ali-fhr/alissa-dark-factory-devloop
milestone: k17ex000000000000000000000000000
priority: medium
dependsOn:
  - { id: loopwork-base-upgrade-notes, type: hard }
  - { task: TASK-1199309725, type: soft }
scope:
  - docker/Dockerfile
  - README.md
commitClass: drift-fix
sources:
  - drift:base-image:1.2.0
```

The task frontmatter's JSON Schema (draft-07; `alissa-plans:schema/task-frontmatter.v1.json`,
byte-equal to this block, L8):

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/ali-fhr/alissa-plans/schema/task-frontmatter.v1.json",
  "title": "alissa-plans task frontmatter, version 1",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "title", "repo", "milestone", "priority", "dependsOn", "scope", "commitClass"],
  "properties": {
    "id": { "$ref": "#/definitions/slug" },
    "title": { "type": "string", "minLength": 8, "maxLength": 200 },
    "repo": { "type": "string", "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    "milestone": { "$ref": "#/definitions/convexId" },
    "priority": { "type": "string", "enum": ["low", "medium", "high", "top"] },
    "dependsOn": {
      "type": "array",
      "maxItems": 8,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "type"],
            "properties": { "id": { "$ref": "#/definitions/slug" }, "type": { "$ref": "#/definitions/edgeType" } }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["task", "type"],
            "properties": { "task": { "type": "string", "pattern": "^TASK-[0-9]+$" }, "type": { "$ref": "#/definitions/edgeType" } }
          }
        ]
      }
    },
    "scope": { "type": "array", "minItems": 1, "maxItems": 12, "uniqueItems": true, "items": { "type": "string", "pattern": "^[^\\s,]+$" } },
    "commitClass": {
      "type": "string",
      "enum": ["schema-migration", "auth-secrets", "pricing-billing", "customer-promise", "product-surface", "gate-verification", "drift-fix", "flaky-test", "exhaust-followup", "doc-correction"]
    },
    "sources": { "type": "array", "maxItems": 16, "uniqueItems": true, "items": { "$ref": "#/definitions/sourceKey" } }
  },
  "definitions": {
    "slug": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,47}$" },
    "convexId": { "type": "string", "pattern": "^[a-z0-9]{32}$" },
    "edgeType": { "type": "string", "enum": ["hard", "soft"] },
    "sourceKey": { "type": "string", "pattern": "^(gate|later|minor|esc|drift|stale):[^\\s]+$" }
  }
}
```

`plan.md`'s frontmatter, filled for the same plan:

```yaml
id: 2026-09-28-drift-base-image
title: "Every leaf Dockerfile follows the loopwork base image"
anchor: { kind: exhaust, class: drift-fix }
program: m17pr000000000000000000000000000
sources:
  - { key: "drift:base-image:1.2.0", evidence: "devloop and revloop pin 1.1.0; alissa-loopwork VERSION is 1.2.0" }
budget: { estimateUsd: 30, basis: "2 tasks × the 30-day median doc-correction session on the daemon repos" }
```

and its schema (`alissa-plans:schema/plan-frontmatter.v1.json`):

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/ali-fhr/alissa-plans/schema/plan-frontmatter.v1.json",
  "title": "alissa-plans plan.md frontmatter, version 1",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "title", "anchor", "program", "sources", "budget"],
  "properties": {
    "id": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]{2,47}$" },
    "title": { "type": "string", "minLength": 8, "maxLength": 200 },
    "anchor": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["kind", "milestoneId"], "properties": { "kind": { "const": "milestone" }, "milestoneId": { "$ref": "#/definitions/convexId" } } },
        { "type": "object", "additionalProperties": false, "required": ["kind", "milestoneId", "criterionId"], "properties": { "kind": { "const": "criterion" }, "milestoneId": { "$ref": "#/definitions/convexId" }, "criterionId": { "type": "string", "minLength": 1 } } },
        { "type": "object", "additionalProperties": false, "required": ["kind", "objectiveId"], "properties": { "kind": { "const": "objective" }, "objectiveId": { "$ref": "#/definitions/convexId" } } },
        { "type": "object", "additionalProperties": false, "required": ["kind", "class"], "properties": { "kind": { "const": "exhaust" }, "class": { "type": "string", "enum": ["gate-verification", "drift-fix", "flaky-test", "exhaust-followup", "doc-correction"] } } }
      ]
    },
    "program": { "$ref": "#/definitions/convexId" },
    "milestone": { "$ref": "#/definitions/convexId" },
    "sources": {
      "type": "array",
      "maxItems": 16,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "evidence"],
        "properties": { "key": { "type": "string", "pattern": "^(gate|later|minor|esc|drift|stale):[^\\s]+$" }, "evidence": { "type": "string", "minLength": 1, "maxLength": 200 } }
      }
    },
    "budget": {
      "type": "object",
      "additionalProperties": false,
      "required": ["estimateUsd", "basis"],
      "properties": { "estimateUsd": { "type": "number", "minimum": 0 }, "basis": { "type": "string", "minLength": 1, "maxLength": 200 } }
    },
    "supersedes": { "type": "string", "pattern": "^plans/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]{2,47}$" }
  },
  "definitions": {
    "convexId": { "type": "string", "pattern": "^[a-z0-9]{32}$" }
  }
}
```

Field by field. On a task: `id` is the plan-local slug and the file's name; `repo` is the
`Autonomous-Dev:` of the task it becomes and must be a fed repository (§5.5 rule 12);
`milestone` is the Convex id of the milestone body of work the task lands in — on a milestone or
criterion anchor it equals the anchor's, on an exhaust anchor it is the program's *exhaust*
milestone BOW, created once per program by the operator and named in the steering record's
`priorities` (§10 Q3); `priority` is the task's (the fleet uses `low` to `top`, never `none`);
`dependsOn` holds the edges on the dependent (D17); `scope` is the `Autonomous-Scope:` list;
`commitClass` is one of the ten a plan may declare — `unanchored` is the refuter's alone (§4.3);
`sources` names the D6 keys this task carries, each one of `plan.md`'s. On the plan: `id` is the
directory name; `anchor` is D4's union; `program` and `milestone` are Convex ids `plan-lint`
resolves (§5.5 rule 10); `sources[]` is D6's keys with one line of evidence each; `budget` is
the session's estimate against the program's remaining figure (D10) — a number and how it was
reached, never a cap; `supersedes` names the plan this one replaces (D2). The plan's class is
not declared: it is the most severe `commitClass` of its tasks in §7.1's order, computed by the
lint and printed in the check run's summary, and the refuter's floor (D9).

