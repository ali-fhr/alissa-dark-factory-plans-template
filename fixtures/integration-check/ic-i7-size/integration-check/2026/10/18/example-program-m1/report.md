---
schema: alissa-integration-check/v1
task: TASK-3000
check: chk-3000-example-program-m1
project: p0000000000000000000000000000001
milestone: { id: q0000000000000000000000000000001, n: 1, title: "M1 — the services follow the config contract" }
run: 1
previous: null
notes: [STRIPE_TEST_KEY]
reads:
  - { repo: example-org/service-b, sha: "7c1e4b2a9d3f5e6071829a3b4c5d6e7f80912a3b" }
recipe:
  - { repo: example-org/service-b, state: confirmed, path: .alissa/verify.yml }
status: SUCCESS
couldntVerify:
  - id: u1
    kind: devices
    what: "The advanced settings screen of the native app"
    why: "No real phone or native app runs in the fleet."
    howToCheck: "Open Settings → Advanced in the app on your phone and change one key."
steps:
  - { id: build, verdict: pass, evidence: [evidence/build.log], detail: "npm ci and npm run build succeeded." }
  - { id: tests, verdict: pass, evidence: [evidence/tests.log], detail: "2 covering test files, 14 tests, all passing." }
  - { id: start, verdict: pass, evidence: [evidence/start.log], detail: "Ready at /health in 9 s." }
  - { id: routes, verdict: pass, evidence: [evidence/routes.json], detail: "3 routes exercised." }
  - { id: screens, verdict: pass, evidence: [evidence/c1-settings-1440.png, evidence/c1-settings-390.png, evidence/console.log, evidence/trace.html], detail: "1 screen at 1440 and 390 wide; no console error." }
  - { id: contracts, verdict: skipped, evidence: [], detail: "The plan declares no cross-task contract." }
criteria:
  - id: c1
    verdict: pass
    evidence: [evidence/routes.json, evidence/c1-settings-1440.png]
    detail: "GET /config answers the 2.x keys, and the settings screen shows them."
  - id: c2
    verdict: pass
    evidence: [evidence/tests.log]
    detail: "The contract test reads docs/config/contract.md and passes."
neighbours:
  - { id: n1, kind: route, target: "GET /health", verdict: pass, evidence: [evidence/routes.json], detail: "200 in 4 ms, as before." }
  - { id: n2, kind: screen, target: "Settings → Advanced (native app)", verdict: unverified, evidence: [], detail: "See u1." }
scope:
  prs: ["https://github.com/example-org/service-b/pull/42"]
  paths: [src/config/load.ts, src/config/keys.ts]
  oneHop: [src/server/routes/config.ts]
  contracts: []
  cut: []
---

## Couldn't verify

- **u1 — devices.** The advanced settings screen of the native app. No real phone or native app
  runs in the fleet. *How to check:* open Settings → Advanced in the app on your phone and change
  one key.

## Summary

**SUCCESS.** service-b built, its covering tests passed, the app started from the confirmed recipe,
and both of the milestone's criteria were verified passing against the running product. One
neighbour, the native app's advanced settings screen, could not be checked in the fleet.

## Criteria

### c1 — Every service reads the 2.x keys — pass

`GET /config` answers the 2.x keys (`evidence/routes.json`), and the settings screen shows them at
both widths (`evidence/c1-settings-1440.png`).

### c2 — The contract is documented — pass

The contract test reads `docs/config/contract.md` and passes (`evidence/tests.log`).

## Neighbours

- **n1 — `GET /health`** — pass, 200 in 4 ms (`evidence/routes.json`).
- **n2 — Settings → Advanced (native app)** — unverified; see u1.

## Steps

| Step | Verdict | Evidence |
|---|---|---|
| build | pass | `evidence/build.log` |
| tests | pass | `evidence/tests.log` |
| start | pass | `evidence/start.log` |
| routes | pass | `evidence/routes.json` |
| screens | pass | `evidence/c1-settings-1440.png`, `evidence/c1-settings-390.png`, `evidence/console.log` |
| contracts | skipped | — |
