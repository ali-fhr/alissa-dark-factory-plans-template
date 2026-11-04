---
schema: alissa-findings/v1.4
kind: doc_check
task: TASK-1341
project: j57c0000000000000000000000000001
milestone: k97d0000000000000000000000000001
reads:
  - repo: example-org/service-b
    sha: 3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4
topics: [docs, config]
questions:
  - id: q1
    text: Does the README's "Run locally" section give the commands the repo actually uses?
    status: answered
    confidence: high
    answer: >-
      No: package.json has no `dev` script; the service starts with `npm start`.
    cites:
      - { repo: example-org/service-b, path: package.json, lines: "1-24", blob: 7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d }
    doc:
      key: service-b.readme.npm-run-dev
      verdict: wrong
      area: readme
      docRepo: example-org/service-b
      docPath: README.md
      anchor: run-locally
      passage: >-
        Install the dependencies with `npm install`, then start the service with `npm run dev`.
      correction: >-
        Install the dependencies with `npm install`, then start the service with `npm start`.
      fixSide: doc
      crossRun: new
    unblocks:
      - { decision: "Whether the README fix is in the fix plan", impact: medium }
  - id: q2
    text: Is the configuration-key list in src/config/keys.ts documented anywhere?
    status: answered
    confidence: medium
    answer: >-
      No: no doc names the admitted keys; src/config/keys.ts is the only list of them.
    cites:
      - { repo: example-org/service-b, path: src/config/keys.ts, lines: "12-30", blob: 51be2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c }
    doc:
      key: service-b.missing.src-config-keys
      verdict: missing
      area: readme
      docRepo: example-org/service-b
      docPath: README.md
      correction: >-
        A "Configuration" section listing every key src/config/keys.ts admits, with its default.
      fixSide: doc
      crossRun: new
    unblocks:
      - { decision: "Whether a configuration section is in the fix plan", impact: low }
---

## Summary

A documentation check of service-b's README: the "Run locally" commands name a script package.json
does not have, and the configuration keys are documented nowhere.

## q1 — Does the README's "Run locally" section give the commands …

package.json (lines 1–24) has `start` and no `dev` script.

## q2 — Is the configuration-key list documented …

src/config/keys.ts (lines 12–30) is the only list of the admitted keys.
