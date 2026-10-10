---
id: 2026-09-28-rule-03-count
title: "The example services follow the shared config contract"
anchor: { kind: milestone, milestoneId: b0000000000000000000000000000001 }
program: p0000000000000000000000000000001
milestone: b0000000000000000000000000000001
sources:
  - { key: "drift:config-contract:2.0", evidence: "service-a documents and service-b reads the 1.x config keys; the contract is at 2.0" }
budget: { estimateUsd: 40, basis: "2 tasks × the median drift-fix session on the example services" }
---
# Plan: The example services follow the shared config contract
<!-- alissa-genloop:plan v1 -->

## Why now

The shared config contract moved to 2.0 and milestone M1 of the example program is open on
exactly this: every service reads the 2.x keys. service-a's contract notes still describe 1.x and
service-b still loads the 1.x keys, so M1's first criterion stays unsatisfied until both move.

## What it serves

Milestone M1 of the example program (`b0000000000000000000000000000001`), criterion c1.

## Summary
<!-- plan-summary:begin -->
- `config-contract-notes` — service-a's contract notes describe the 2.0 config keys (example-org/service-a, doc-correction)
- `extra-doc-1` — service-a's extra config page 1 describes the 2.0 keys (example-org/service-a, doc-correction)
- `extra-doc-2` — service-a's extra config page 2 describes the 2.0 keys (example-org/service-a, doc-correction)
- `extra-doc-3` — service-a's extra config page 3 describes the 2.0 keys (example-org/service-a, doc-correction)
- `extra-doc-4` — service-a's extra config page 4 describes the 2.0 keys (example-org/service-a, doc-correction)
- `extra-doc-5` — service-a's extra config page 5 describes the 2.0 keys (example-org/service-a, doc-correction)
- `extra-doc-6` — service-a's extra config page 6 describes the 2.0 keys (example-org/service-a, doc-correction)
- `extra-doc-7` — service-a's extra config page 7 describes the 2.0 keys (example-org/service-a, doc-correction)
- `service-b-config-keys` — service-b loads the 2.0 config keys (example-org/service-b, drift-fix)
<!-- plan-summary:end -->
## Dependency graph
<!-- plan-dag:begin -->
```mermaid
graph LR
  t_config_contract_notes["config-contract-notes"]
  t_extra_doc_1["extra-doc-1"]
  t_extra_doc_2["extra-doc-2"]
  t_extra_doc_3["extra-doc-3"]
  t_extra_doc_4["extra-doc-4"]
  t_extra_doc_5["extra-doc-5"]
  t_extra_doc_6["extra-doc-6"]
  t_extra_doc_7["extra-doc-7"]
  t_service_b_config_keys["service-b-config-keys"]
  x_TASK_100["TASK-100"]
  x_TASK_100 -->|soft| t_config_contract_notes
  t_config_contract_notes -->|hard| t_service_b_config_keys
```
<!-- plan-dag:end -->
## Considered and skipped

- One task for both services — skipped: two repositories, two reviews, two scopes.

## Open questions for the reviewer

- None.
