---
schema: alissa-findings/v1.3
kind: security_review
task: TASK-1323
project: j57c0000000000000000000000000001
milestone: k97d0000000000000000000000000001
reads:
  - repo: example-org/service-b
    sha: 3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4
topics: [security, config]
questions:
  - id: q1
    text: Can a signed-in user read another tenant's configuration through loadConfig?
    status: answered
    confidence: high
    answer: >-
      Yes: loadConfig() trusts the tenant id of the request and never compares it with the session's.
    cites:
      - { repo: example-org/service-b, path: src/config/load.ts, lines: "1-40", blob: 9ad0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c }
    security:
      key: service-b.authz.load-config
      severity: high
      category: authz
      consequence: security
      reachable: yes
      scenario: >-
        A signed-in user of one tenant passes another tenant's id to loadConfig() in src/config/load.ts and reads that tenant's keys, because the tenant id is taken from the request and never checked against the session.
      fix: >-
        Take the tenant id from the session, as https://github.com/example-org/service-b/blob/3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4/src/config/load.ts already does for reads; refuse a mismatch with 403.
      crossRun: new
      cwe: CWE-285
    unblocks:
      - { decision: "Whether the fix plan must change loadConfig", impact: medium }
  - id: q2
    text: Does a misspelt secret key fall back to an insecure default?
    status: answered
    confidence: medium
    answer: >-
      An unknown key is ignored, so a misspelt key leaves its default in place; the defaults hold no secret.
    cites:
      - { repo: example-org/service-b, path: src/config/keys.ts, lines: "12-30", blob: 51be2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c }
    security:
      key: service-b.secrets.unknown-keys
      severity: medium
      category: secrets
      consequence: correctness
      reachable: unknown
      scenario: >-
        An operator misspells a key in the environment; src/config/keys.ts ignores it and the default applies silently.
      fix: >-
        Refuse unknown keys at startup, as the list in src/config/keys.ts already names every admitted key.
      crossRun: still_open
    unblocks:
      - { decision: "Whether startup validation is in the fix plan", impact: low }
---

## Summary

A security review of service-b's configuration loading: one tenant-isolation finding in `loadConfig()`
and one silent fallback for misspelt keys.

## q1 — Can a signed-in user read another tenant's configuration …

`loadConfig()` (src/config/load.ts, lines 1–40) reads the tenant id from the request.

## q2 — Does a misspelt secret key fall back …

src/config/keys.ts (lines 12–30) ignores unknown keys.
