# D20 retirement: remaining dual-path CI consumers

Accepted source: `thread_msr51149hym0i79f#0001791607259130-000220-13857b48`, revision `0001791607259130-000220-13857b48`. Peer handoff: `0001791607343110-000223-7896e07a`; queue clarification: operator222. Base: published `64d4611e3c7f18ac390e61ba44d0fab1c9eb7e27`, shared by upstream1398 and fork220.

## Failure and cause

Exact-head CI run38023710000 failed distributable-5 job114130261485 at dual-path-strict-equality.test.js:155 and distributable-6 job114130261558 at dual-path-validation.test.js:186. Both expected24 per-turn hooks; D20 automatic Signal article injection had been intentionally retired, leaving23. The prior cleanup missed these two consumer assertions. Original CI failure excerpt and local red12tests/10pass/2fail are retained. No production hook or prompt behavior is being changed to satisfy an obsolete test.

## Successor

Keep count23 and explicitly assert all surviving IDs D1-D19,D21,R1,R2,N1. Assert retiredD20 produces no trace event or prompt patch; session mailboxD21 remains registered. Existing session22, identity, governance, direct-message, teammates, serial/A2A mode, infrastructure, scope filtering, trace draining and structural trace assertions remain intact. This verifies the retired capability and surviving catalog, rather than only decrementing a number.

Correct stale comments in PipelinePromptBuilder, the manifest endpoint and manifest generator to active45/session22/per-turn23. These are comment-only changes; production executable behavior, schemas and generator entries are unchanged. Scan source/tests/shared/generator/manifests/templates for obsolete24/46 hook-count assertions and retired D20 wiring; no active matches remain. Historical feature docs and evidence remain historical rather than being rewritten.

Also confirm confirmedLocalCallbackRoutedTargets/confirmedLocalCallbackRoutingMentions/getLocalRoutingLineStartMentions have no remaining src/test matches. No new dedup layer is introduced; existing Queue source identity remains unchanged. Do not redeliver historical101/123.

## Verification and limits

Nine affected API files,13suites,110/110 pass: the two failing files plus hook-pipeline, hook-pipeline-integration, hook-resolver-registry, hook-resolvers-session, hook-resolvers-turn, hook-segment-coverage and transport-boundary-l0-equivalence. Temporary testHOME/blocked Redis/in-memory fixtures; no real provider or runtime experiment. Feature API tsc, Biome and diff-check pass. No unchanged Web/full-gate rerun. Fresh remote CI is not yet proven for the successor.

Prior approved4f04 cleanup/tips,6a8 errors and2f9623 routing scope remains intact; this successor is test assertions plus comments/evidence only. Exact successor review goes back to Astra, then normal fast-forward updates original1398/220. No new PR/tracker, runtime/config/data/process mutation, merge or restart. Operator220 says to finish before they merge220; no claim it is ready until actual review and current-head CI are accounted for.
