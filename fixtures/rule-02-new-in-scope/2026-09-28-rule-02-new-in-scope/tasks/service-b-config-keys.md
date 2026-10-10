---
id: service-b-config-keys
title: "service-b loads the 2.0 config keys"
repo: example-org/service-b
milestone: b0000000000000000000000000000001
priority: high
dependsOn:
  - { id: config-contract-notes, type: hard }
scope:
  - src/config/load.ts
  - tests/config/load.test.ts
new:
  - src/config/keys.ts
commitClass: drift-fix
sources:
  - drift:config-contract:2.0
---
## Why

service-b's `src/config/load.ts` reads `db_url` and `cache_ttl`, the 1.x key names, and falls
back to defaults when they are absent — so a deployment written against the 2.0 contract starts
with the default database and a zero cache TTL instead of failing loudly. The fix is to read the
2.0 names (`database.url`, `cache.ttlSeconds`), refuse the 1.x names with an error that names the
new key, and pin both behaviours with a test. It waits on the contract notes so the error text
can link the page that documents the new names.

## Definition of done

A pull request against example-org/service-b makes the loader read the 2.0 keys and refuse the
1.x keys with a named error, with tests, flipped to ready-for-review and the review loop converged.

## Criteria

- The loader reads `database.url` and `cache.ttlSeconds`.
- A config carrying `db_url` or `cache_ttl` is refused with an error naming the 2.0 key.
- tests/config/load.test.ts covers both cases and passes.
