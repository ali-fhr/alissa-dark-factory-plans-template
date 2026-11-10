---
schema: alissa-security-report/v1
kind: technical
review: k17acmereview0001
lang: en
data: report-data.json
dataSha256: 08575365532b4dbf8e4349dd30730e501b1dd4898cebe14cb2bc146f667366d0
repo: acme-shop/payments-api
covers: [TASK-1040#q2, TASK-1040#q4]
---

# Technical report — acme-shop/payments-api — 2026-11-09

## TASK-1040#q2 — Refunds accept an amount the order never had

Status: New · kept

Severity: critical. Consequence: money, reachable.

### Scenario

A signed-in customer asks for a refund on a small order and sends a larger amount in the request; the handler pays out what it was sent.

### Fix

Read the refundable amount from the stored order and refuse any request above it.

Cites: `src/refunds/handler.ts` lines 40–58.

## TASK-1040#q4 — Webhook payloads are logged with the customer's email

Status: New · kept

Severity: medium (only operators read the logs). Consequence: leak, reachable.

### Scenario

Anyone with access to the log viewer reads customer emails from webhook entries.

### Fix

Log the event id and type only.
