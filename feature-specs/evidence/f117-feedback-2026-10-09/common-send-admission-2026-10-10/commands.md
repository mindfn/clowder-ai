# Commands and reproducibility

Worktree: `/Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback`.

Build from root: `pnpm --dir packages/api exec tsc`.
API from `packages/api`: `bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test` followed by the exact list in `api-files.json`.
Formatting from root: `pnpm exec biome check --diagnostic-level=error` on all changed API source/tests plus the two new tests. Warnings are not claimed absent.

Typed check from `packages/api`: same wrapper, `node --import tsx --import ./test/helpers/setup-cat-registry.js --test --test-timeout=15000` on the Live and persisted-delivery copies in `fixtures/`. Those copies preserve assertions and substitute only source import paths/extensions with the feature's built dist imports. Decompress the verbatim `.gz` archives and restore them to their original `.f117-common-send-*` basenames under `packages/api/test` to replay. They are archived here rather than left as temporary runnable files in the test discovery directory.

Collective/reconsideration seam copies are similarly derived from this worktree's current tests with `../src/` → `../dist/` and `.ts` → `.js` import substitutions only. Run with the ordinary wrapper and `--test-timeout=15000`. The reconsideration typed checks ran the actual `f290-communication-reconsideration.test.ts` and `f290-communication-reconsideration-queue-refusal.test.ts` via tsx, with retained owned Host/Service stores.

Owned Redis: ordinary wrapper, `node --import ./test/helpers/setup-cat-registry.js --test test/1398-send-policy-redis.test.js`. Its child listens on a Unix socket only, retains all storage, then performs a clean shutdown of that child. It never uses inherited runtime Redis.

Reviewer scripts: original copies and adapted copies are in `reproducers/`. Adapted scripts reference this exact feature dist; run with the ordinary wrapper and `--test-timeout=15000`. Original scripts/logs are preserved as historical red evidence, not presented as final unchanged reruns. Scripts and consistent copies are compressed verbatim so the repository formatter does not rewrite independent evidence; decompress before execution.

`manifest.json` binds the review base, packet files and all changed production/test source hashes. The manifest excludes itself. Exact candidate commit/tree is supplied only after committing the frozen packet.
