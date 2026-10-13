---
schema: alissa-findings/v1
task: TASK-1301
project: j57c0000000000000000000000000001
milestone: k97d0000000000000000000000000001
reads:
  - repo: example-org/service-b
    sha: 3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4
topics: [config, startup]
questions:
  - id: q1
    text: Where does service-b load its configuration keys, and are they validated at startup?
    status: answered
    confidence: high
    answer: >-
      loadConfig() in src/config/load.ts reads the environment once at startup and checks every
      key against the list in src/config/keys.ts; an unknown key is ignored, a missing one throws.
    cites:
      - { repo: example-org/service-b, path: src/config/load.ts, lines: "1-40", blob: 9ad0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c }
      - { repo: example-org/service-b, path: src/config/keys.ts, lines: "12-30", blob: 51be2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c }
    unblocks:
      - { decision: "Whether the config-keys task must add startup validation", impact: high }
  - id: q2
    text: Does any caller reload the configuration after startup?
    status: unanswerable
    confidence: low
    reason: The reload path is behind a feature flag whose value lives outside the repository.
    unblocks:
      - { decision: "Whether a reload test is needed", impact: medium }
risks:
  - text: Unknown keys are ignored silently, so a misspelt key falls back to its default.
    severity: medium
    cites: [{ repo: example-org/service-b, path: src/config/keys.ts, lines: "12-30", blob: 51be2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c }]
suggestedTasks:
  - title: Refuse unknown configuration keys at startup
    repo: example-org/service-b
    kind: code
    commitClass: drift-fix
    scope: [src/config/load.ts, src/config/keys.ts]
    why: q1's answer; risk 1.
---

## Summary

service-b loads its configuration once, at startup, in `loadConfig()`; every key is checked against
the list in `src/config/keys.ts`. A missing key stops the process, an unknown one is ignored. Whether
anything reloads the configuration later could not be settled from the code alone.

## q1 — Where does service-b load its configuration keys …

`loadConfig()` (src/config/load.ts, lines 1–40) is the single entry point; it reads the environment
into a plain object and walks the key list of src/config/keys.ts (lines 12–30), throwing on the first
missing required key.

## q2 — Does any caller reload the configuration …

A `reloadConfig` export exists, but its only caller is gated by a flag whose value is set by the
deployment, not by this repository.
