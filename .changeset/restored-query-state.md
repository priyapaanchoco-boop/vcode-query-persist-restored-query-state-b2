---
'@tanstack/query-core': minor
'@tanstack/query-persist-client-core': patch
---

fix(persist): restore the full persisted query state instead of a fresh success

Queries restored from storage now keep their saved status, errors, update counters, timestamps and invalidation (including infinite query pages), and do not fire the cache's success callbacks. Adds `createPersisterRestoredResult` to `@tanstack/query-core`, which a persister can return to hand the restored state to the query.
