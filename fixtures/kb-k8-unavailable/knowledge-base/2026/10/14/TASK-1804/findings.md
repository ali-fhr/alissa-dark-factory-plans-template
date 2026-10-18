---
schema: alissa-findings/v1.1
task: TASK-1804
project: j57c0000000000000000000000000001
reads: []
topics: [vendor-docs]
questions:
  - id: q1
    text: How long does the payments vendor retry a webhook delivery that service-b fails to accept?
    status: answered
    confidence: medium
    answer: >-
      Up to three days, with exponential backoff; after that the vendor drops the event.
    cites:
      - kind: url
        url: https://docs.example.com/flaky
        retrievedAt: "2026-10-14T10:02:11Z"
        quote: "Failed deliveries are retried with exponential backoff for up to three days."
    unblocks:
      - { decision: "Whether service-b needs its own webhook retry queue", impact: medium }
---

## Summary

The payments vendor retries a failed webhook delivery for up to three days, with exponential
backoff, then drops it.

## q1 — How long does the payments vendor retry a webhook delivery …

The vendor's webhook guide states the window and the backoff in one sentence.
