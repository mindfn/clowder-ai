# Common-send CI fixture correction

Source base: fd01f6fe36372a098f2a73df74008b9b6932584d. Published failing head: dc59db587f612831608cb7f88028c0e024a2c1ce. CI run38043473770; completed failing jobs114188627734 (gateway),114188627675 (control-plane failure),114188627690 (action recovery),114188627685 (multi-mention fan-out). Their original logs are retained. Other running checks are not relabeled as passing.

## Cause and scope

The common-send refactor moved drain notification into Queue admission with host-provided onAdmitted wiring. Four legacy test hosts created bare InvocationQueue instances but still expected producers to call their QueueProcessor spies directly. Production index.ts already wires onAdmitted→requestDrain; restoring producer-specific drain calls would violate the approved convergence. Wire those test hosts like production instead. A fifth source-based failure-return fixture has the same omission, independently reproduced and corrected.

The gateway fixture mocked PersistedQueueDelivery by copying input.targetCatId, assuming ConnectorRouter had already selected a default. The actual connector now omits that field for unmentioned input so shared send can resolve the default. Replace the fake delivery/store/retired trigger with the existing real connectorDeliveryHarness: PersistedQueueDelivery, InvocationQueue and MessageStore execute, with the configured common resolver. Message counts are read from persisted History including queued inputs, independently of wake-spy counts.

Only five test files and this evidence packet change. No production code, policy, authority, Queue semantics or runtime configuration is changed. Original exact fan-out hooks-before-drain, exactly-once notification, legacy recovery, failure atomicity, predecessor identity, connector default/mention, dedup, outbound adapter and visibility assertions remain. No assertions are loosened.

## Validation

- Local original fan-out/recovery reproduction:12 tests,10pass/2fail, matching the CI assertions.
- Original gateway/control reproduction:46 tests,44pass/2fail.
- Additional source failure-return fixture:5 tests,3pass/2fail, same missing admission wiring.
- Final seven dist-based API files:119/119. Covers four corrected CI files plus adjacent multi-mention/callback/cloud execution seams.
- Source-based failure-return fixture using tsx:5/5. Dist remains the feature's previously compiled unchanged production code; no independent rebuild is claimed.
- Biome five files, no fixes; git diff --check clean.

Counts are author-run evidence, not independent review. Earlier fd01 production approval remains unchanged. This correction responds to external CI findings; the new remote HEAD CI is the next gate, rather than reopening unchanged implementation review. No real provider, running instance, persistent runtime data, merge or restart was used.
