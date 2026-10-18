---
schema: alissa-findings/v1.1
task: TASK-1240
bodyOfWork: b57c0000000000000000000000000001
asker: TASK-1200
reads:
  - repo: example-org/service-b
    sha: 3f9c2a1e5b7d4c6e8f0a1b2c3d4e5f60718293a4
topics: [webhooks, vendor-docs]
questions:
  - id: q1
    text: How long does the payments vendor retry a webhook delivery that service-b fails to accept?
    status: answered
    confidence: medium
    answer: >-
      Up to three days, with exponential backoff; after that the vendor drops the event, so a
      delivery service-b misses for longer is lost unless it is fetched again.
    cites:
      - kind: url
        url: https://docs.example.com/webhooks/retries
        retrievedAt: "2026-10-14T10:02:11Z"
        quote: "Failed deliveries are retried with exponential backoff for up to three days."
        archive: https://web.archive.org/web/20261014100230/https://docs.example.com/webhooks/retries
    unblocks:
      - { decision: "Whether service-b needs its own webhook retry queue", impact: medium }
  - id: q2
    text: Does service-b validate its configuration keys at startup?
    status: answered
    confidence: high
    answer: >-
      Yes: loadConfig() in src/config/load.ts checks every key against src/config/keys.ts once, at
      startup, and throws on a missing one.
    cites:
      - { kind: repo, repo: example-org/service-b, path: src/config/load.ts, lines: "1-40", blob: 9ad0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c }
    unblocks:
      - { decision: "Whether the webhook secret needs a startup check of its own", impact: low }
risks:
  - text: The vendor's delivery has been degraded before; a long outage on its side looks like silence on ours.
    severity: low
    cites:
      - kind: url
        url: https://status.example.com/history
        retrievedAt: "2026-10-14T10:05:00Z"
        quote: "Webhook delivery was degraded for 41 minutes on 2026-09-30."
---

## Summary

The payments vendor retries a failed webhook delivery for up to three days, with exponential
backoff, then drops it. service-b validates its configuration once, at startup. A retry queue of its
own is therefore needed only for outages longer than the vendor's window.

## q1 — How long does the payments vendor retry a webhook delivery …

The vendor's webhook guide states the window and the backoff in one sentence (cited, with an
archived copy taken at the time of reading). Nothing on the page says whether the window is
configurable per account.

## q2 — Does service-b validate its configuration keys at startup?

`loadConfig()` (src/config/load.ts, lines 1–40) walks the key list and throws on the first missing
required key.
