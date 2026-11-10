# A Report plan's data file (plans template only, lane CSR-2b)

`report-data.json` is `../clean/report-data.json`, copied byte for byte: the one file a Report
plan's `PLAN-` pull request adds beside its plan, at
`knowledge-base/security-reports/2026-11-09-k17acmereview0001/report-data.json` (design
`alissa-code-security-reports.md` §4.1). `lint/test/security-report.test.ts` lays it out beside
`fixtures/golden/` as a plan PR and keeps it equal to `clean/`.

This directory is the template's, not Studio's: the test that pins `fixtures/security-report/` to
Studio's tree leaves it out.
