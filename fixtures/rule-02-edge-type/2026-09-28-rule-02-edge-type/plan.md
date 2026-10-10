---
id: 2026-09-28-rule-02-edge-type
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
- `service-b-config-keys` — service-b loads the 2.0 config keys (example-org/service-b, drift-fix)
<!-- plan-summary:end -->
## Dependency graph
<!-- plan-dag:begin -->
```mermaid
graph LR
  t_config_contract_notes["config-contract-notes"]
  t_service_b_config_keys["service-b-config-keys"]
  x_TASK_100["TASK-100"]
  x_TASK_100 -->|soft| t_config_contract_notes
  t_config_contract_notes -->|accept| t_service_b_config_keys
```
<!-- plan-dag:end -->
## Considered and skipped

- One task for both services — skipped: two repositories, two reviews, two scopes.

## Open questions for the reviewer

- None.
