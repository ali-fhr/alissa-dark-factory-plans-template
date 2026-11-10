# Security report fixtures (K19–K23)

Shared by Studio (`convex/core/securityReportData.ts`, `tests/securityReportData.test.ts`) and the
plans template's plan-lint (lane CSR-2), which copies this directory byte for byte. Design:
`docs/design/alissa-code-security-reports.md` §4.1–§4.3.

Every repository, finding, ref and id here is invented (`acme-shop/*` repositories, refs `TASK-1012` to `TASK-1099`). No customer's
finding text, file path or severity appears in any file.

- `source/view.json`, `source/review.json` — Studio's inputs: a report view and the review row.
  `clean/report-data.json` is `securityReportDataJsonOf(securityReportDataOf(view, review))`.
- `clean/` — a run directory that passes K19–K23.
- `k19-*` … `k23-*` — each is `clean/` with one change that fails exactly that rule.
  `cases.json` names each case's rule, file and change under `failing`.
- `pass-*` — variants that must still pass K19–K23 (`cases.json` `passing`): an es-MX count
  phrase whose adjective follows the noun, and a Not re-verified finding whose own title holds
  an upgrade word. `pass-title-upgrade-word/` carries its own data file (the retitled finding),
  so its `dataSha256` lines differ from `clean/`.

Finding and refuted `key`s have the security review's §5.1 form: the repository name without the
owner (`payments-api.money.refundhandler`), never `acme-shop-payments-api.…`.

`counts.bySeverity` is the view's severity table: diff entries, so a re-run's fixed and absent
findings count too and the severities can sum past `counts.findings`. K20 therefore reads a
numeral beside a severity noun against that table count **or** the open count of that severity
(the `findings` with it); a count-noun phrase's qualifier decides in either word order
("2 critical findings", "2 hallazgos críticos", "2 high-severity findings").

When a fixture changes, regenerate `report-data.json` from `source/` and update every
`dataSha256` line (the sha256 of `report-data.json`'s bytes).
