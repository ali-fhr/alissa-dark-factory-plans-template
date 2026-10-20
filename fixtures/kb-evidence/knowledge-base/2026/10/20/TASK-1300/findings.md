---
schema: alissa-findings/v1.2
task: TASK-1300
project: j57c0000000000000000000000000001
milestone: k97d0000000000000000000000000001
reads:
  - repo: example-org/service-b
    sha: 3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4
topics: [config, settings-page]
questions:
  - id: q1
    text: Which configuration keys does service-b read at startup, and which of them are required?
    status: answered
    confidence: high
    answer: >-
      loadConfig() in src/config/load.ts reads the keys listed in src/config/keys.ts once, at startup;
      DATABASE_URL is required and LOG_LEVEL optional, as tallied in evidence:counts.csv.
    cites:
      - { repo: example-org/service-b, path: src/config/load.ts, lines: "1-40", blob: 9ad0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c }
      - { kind: evidence, file: counts.csv }
    unblocks:
      - { decision: "Whether the config-keys task must add startup validation", impact: medium }
  - id: q2
    text: Does the settings page show the configuration keys to the operator today?
    status: answered
    confidence: medium
    answer: The settings page lists no configuration keys; it shows the log level only.
    cites:
      - { kind: evidence, file: settings-1440.png }
    unblocks:
      - { decision: "Whether a settings-page task is needed", impact: low }
---

## Summary

service-b reads its configuration once, at startup, and only `DATABASE_URL` is required. The
settings page shows none of the keys today [evidence:settings-1440.png].

## q1 — Which configuration keys does service-b read at startup …

`loadConfig()` (src/config/load.ts, lines 1–40) walks the key list; the tally of required and
optional keys is in [evidence:counts.csv].

## q2 — Does the settings page show the configuration keys …

At 1440 px the page shows the log level and nothing else [evidence:settings-1440.png].
