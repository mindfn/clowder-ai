# CI query credential continuity

Base: `d867ace33a56128d161b4f91680e2b34743643fe`; predecessor review remains changes_requested. Exact finding: `thread_msr51149hym0i79f#0001791613641818-000433-c401c133`. Continue original task300/#1398; no new source branch or PR.

## Finding and correction

The split CI work items inherited cancellation but not the plugin-configured GitHub credential. index supplied the configured token only inside a batch-reader closure; per-PR default detail/exact readers therefore used the CLI auth store and another request-budget credential key. The earlier 87 targeted tests missed this production DI chain.

index now passes its existing `getGitHubToken` resolver into the GitHub schedule factory. The factory forwards it to the CI spec; default batch, failure enrichment and exact-PR queries each resolve the current configured credential while retaining their own gate or item AbortSignal. The reader override seam remains separate; `fetchPrStatus` is not wired to bypass batching. No token is stored in the work-item snapshot, no global environment or runtime config is mutated, and the existing no-configured-token CLI semantics remain.

Architecture cell: index plugin credential owner → schedule factory → shared batch and per-PR CI query readers.
Map delta: the same existing resolver now reaches all three reader paths instead of only the batch closure. No auth/role/persistent schema or request-budget policy changes.
Why: splitting query ownership must preserve its credential owner as well as cancellation, without freezing a token or silently switching accounts.

## Validation

- Five owned subprocess-boundary scenarios before the correction: **1 passed / 4 failed**. Failure details and pagination had a configured batch control but lost the token in per-PR commands; production default batching and cancellation-path continuity also failed. The corrected fixture uses asynchronous child close after cancellation so it models execFile ownership correctly; an initial synchronous-close fixture hung and its isolated runner was stopped. It is not a production failure or a runtime process.
- After correction: **10 files / 18 suites / 146 passed**, zero failed/skipped. Includes the 87 prior CI lifecycle/isolation checks, GitHub schedule factories and five new credential scenarios.
- The five new scenarios exercise the real factory → gate → execute → credential budget → child-process path with a fictional token and a fully intercepted subprocess boundary: failure details, full pagination, production default batch + credential rotation, per-item cancellation, and no configured token. Admission remains one GraphQL read. No network, real gh/auth-store access, or configured token appears in logs.
- Feature API compilation, changed-file Biome error-level checks and diff-check passed. No real provider/runtime/browser/full-gate/soak claim. No re-registration, runtime update or restart.
- Independent Astra's original two red fixtures establish the predecessor defect; this report does not claim to have run an unchanged reviewer script against the new DI contract. Independent successor review is still required.

The prior #220 published `7b78bfca` full-green result remains bound to that revision. This unpublished successor needs exact review and fresh remote CI before readiness is claimed for it.
