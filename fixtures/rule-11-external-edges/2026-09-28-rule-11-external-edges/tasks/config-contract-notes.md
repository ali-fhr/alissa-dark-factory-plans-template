---
id: config-contract-notes
title: "service-a's contract notes describe the 2.0 config keys"
repo: example-org/service-a
milestone: b0000000000000000000000000000001
priority: medium
dependsOn:
  - { task: TASK-101, type: soft }
scope:
  - docs/config/contract.md
  - README.md
commitClass: doc-correction
sources:
  - drift:config-contract:2.0
---
## Why

service-a's `docs/config/contract.md` is the page every other service copies its config keys
from, and it still lists the 1.x names (`db_url`, `cache_ttl`) that the 2.0 contract renamed
(`database.url`, `cache.ttlSeconds`). A reader who follows it today writes a service that the 2.0
loader refuses at start-up. The upstream task TASK-100 settled the contract itself; this task
only brings the notes in line with it, so the change is prose and one README pointer.

## Out of scope

The loader code of any service; the contract's own text.

## Definition of done

A pull request against example-org/service-a updates docs/config/contract.md and the README's
config pointer to the 2.0 key names, is flipped to ready-for-review, and the review loop converged.

## Criteria

- docs/config/contract.md lists every 2.0 key name and none of the 1.x names.
- The README's config section links the updated contract page.
