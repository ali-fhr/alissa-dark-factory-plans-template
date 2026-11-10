---
schema: alissa-security-report/v1
kind: technical
review: k17acmereview0001
lang: en
data: report-data.json
dataSha256: 602518c406e947e16a53d63a3e9c433dffde97c44809d07b6945862ba0674889
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
