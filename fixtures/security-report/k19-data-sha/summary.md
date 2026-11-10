---
schema: alissa-security-report/v1
kind: summary
review: k17acmereview0001
lang: en
data: report-data.json
dataSha256: f8575365532b4dbf8e4349dd30730e501b1dd4898cebe14cb2bc146f667366d0
links: [technical-acme-shop-payments-api.md, technical-acme-shop-storefront.md, technical-chains.md]
---

# Executive summary — security review of 2026-11-09

## At a glance

| At a glance | Count |
|---|---:|
| Findings | 5 |
| Critical | 1 |
| High | 2 |
| Medium | 1 |
| Low | 1 |
| Open critical and high | 3 |
| Not re-verified | 2 |
| Refuted | 1 |
| Couldn't verify | 2 |
| Not traced | 1 |

## What is at stake

- **Money.** A refund can be issued for more than the order was worth (TASK-1040#q2).
- **Customer data.** Uploaded receipts may be readable by anyone who finds the bucket; this one is Not re-verified (TASK-1012#q5).
- **Access.** The storefront passes a customer's session to the payments service as it is (TASK-1040#q3).

## What to do first

1. Cap every refund at the amount the order was paid — see [the payments report](technical-acme-shop-payments-api.md#task-1040-q2) (TASK-1040#q2).
2. Check the scope of a session before the payments service acts on it — see [the chains report](technical-chains.md#task-1040-q3) (TASK-1040#q3).
3. Make the receipts bucket private; Not re-verified, so confirm it first — see [the storefront report](technical-acme-shop-storefront.md#task-1012-q5) (TASK-1012#q5).

## What only you can check

- Webhook signing key rotation (TASK-1040#owner-1).
- Refund limits configured at the payment provider (TASK-1041#q6).

Tick them on the run view once you have looked.

## Repository notes

- acme-shop/storefront is public, so its fixes will be public pull requests.

## Technical reports

- [Technical report — acme-shop/payments-api](technical-acme-shop-payments-api.md)
- [Technical report — acme-shop/storefront](technical-acme-shop-storefront.md)
- [Technical report — chains across repositories](technical-chains.md)
