---
schema: alissa-security-report/v1
kind: technical
review: k17acmereview0001
lang: en
data: report-data.json
dataSha256: 08575365532b4dbf8e4349dd30730e501b1dd4898cebe14cb2bc146f667366d0
repo: acme-shop/storefront
covers: [TASK-1012#q5, TASK-1014#q1, TASK-1013#q4]
---

# Technical report — acme-shop/storefront — 2026-11-09

## TASK-1012#q5 — Uploaded receipts are served from a bucket anyone can list

Status: New · Not re-verified

Severity: high. Consequence: data, reachable. Reported by an earlier milestone and not re-checked by Verify.

### Scenario

Someone who guesses the bucket name lists it and downloads receipts.

### Fix

Make the bucket private and serve receipts through short-lived signed links.

## TASK-1014#q1 — The lockfile pins a template library two majors behind

Status: New · Not re-verified

Severity: low. Consequence: security, reachability unknown.

### Fix

Upgrade the template library and re-run the storefront's tests.

## Refuted

- TASK-1013#q4 — Search builds a query from the raw term. Refuted by TASK-1041#q1: the term is bound as a parameter.
