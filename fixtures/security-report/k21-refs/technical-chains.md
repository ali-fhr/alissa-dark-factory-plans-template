---
schema: alissa-security-report/v1
kind: technical
review: k17acmereview0001
lang: en
data: report-data.json
dataSha256: 08575365532b4dbf8e4349dd30730e501b1dd4898cebe14cb2bc146f667366d0
repo: chains
covers: [TASK-1040#q3]
---

# Technical report — chains across repositories — 2026-11-09

## TASK-1040#q3 — The storefront forwards the session to the payments service without checking its scope

Status: New · kept

Severity: high. Consequence: data, reachable. Repositories: acme-shop/storefront → acme-shop/payments-api.

### Scenario

A session meant for browsing is accepted by the payments service for a refund call.

### Fix

The payments service checks the session's scope before it acts.

Related: TASK-1099#q9.
