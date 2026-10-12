# F202 C1 browser-service activation continuation

Original Host owner and worktree, continuing the accepted host-wire-freeze-v1 agreement in `/Users/lang/workspace/github-lab/f202-handoff/collective-module-sol/host-c2-pairing/`. No new public contract, package writer, release or production authority.

## Current evidence

Host base e4a8a643bc088b19e84e7ba8672946482cb38c75, TREE e77d0d0bb20ec75852b8100f82e19b75a2234f1a. Owner-local directory policy approved in thread message 0001791732216546-000131-16ec0849. Current-policy isolated browser install passed 13 checkpoints. Neither establishes activation.

`browser-service-activation-red-r2` independently executed once by Codex, message 0001791767783768-000010-d55d37df. Raw execution says expectedRed=true / unchanged=true. Actual installed module fails its first `!context.browserServices` guard at dist/plugin-entrypoint.js:58:15. Runtime shutdown, empty materialized children, durable reread and zero network attempts verified. r1 remains a diagnostic failure; its harness mistakes are not silently reclassified.

## Implementation sequence within the frozen transport scope

1. Carrier owns an optional browser resource session obtained before package start. The session receives exact instance, package record, effective grants, activation signal and currentness assertion. It returns the Host port, publication and stop operations. Resource allocation must clean up its own partial failure; a returned session is always closed on module start/admission/publication failure, even if no module disposer was returned. Disable aborts first, closes session before module stop, then releases package; failed cleanup remains retryable.
2. Before reservation, validate declaration ownership/grants and reject collisions with other contribution/configuration methods. Capture declared own HTTP handlers; remove every declared browser method from ordinary action lookup. Publish only after handler and predicate admission. The concrete transport must invoke the captured handler with the frozen HTTP-only third argument, suppress parent authority and deny nested browser/verifier/local reentry, including stale async descendants.
3. Implement the actual Host-owned endpoint/asset provider, persisted stable origin, owner enable/currentness fences and retained asset digest. Do not wire a fixture provider into runtime-composition. Rebuild retained client from tracked source; ignored dist is not authoritative. Endpoint reservation must serve unavailable until publish and release serving on rollback/disable without deleting durable identity.
4. Enforce route/origin/cookie/base64/header/size/timeout/concurrency/effect rules exactly as frozen. Underlying unsettled handlers retain their slots after timeout. No transport replay, arbitrary URL, inherited native/owner authority or package listener.
5. Wire production composition, validate real activation with owned isolated ports, then current-HEAD browser service/disable journeys and independent review. Existing installation evidence stays scoped; full controls/plugin matrix, human acceptance and soak remain outstanding.

## First carrier regression slice

`packages/api/test/f202-c1-browser-service-session.test.js` covers no-session ordinary modules, prepare/start/publish ordering, start failure without disposer, publish rollback, ordinary invocation denial, configuration method collision before reservation, missing handler rollback, and retry of failed session stop without repeating completed cleanup.

The test session is an explicitly non-serving carrier test port. Its getBinding/dispatchLocal throw; it never claims real activation, provides a fabricated origin or changes the production composition. The actual-module RED remains the integration target until the concrete endpoint and assets are wired. No implementation or GREEN claimed at this checkpoint.

## Carrier implementation checkpoint

Carrier RED r1 observed 1 pass / 7 fail. Six failures accurately showed missing session/cleanup/publication/private admission. The seventh was a fixture error: the contract already rejects configuration-method collision. The wrapper also expected TAP while Node emitted spec; its `expectedRed:false` is preserved. Author diagnosis records these limits. No equivalent rerun: six existing behavioral failures are the RED; collision regression now checks the existing contract refusal and GREEN explicitly selects TAP.

Implementation adds the Host-owned session port and carrier lifecycle, captures browser handlers privately and excludes them from ordinary action lookup. Missing concrete transport now fails closed before package start. Startup rollback also retains failed cleanup steps for retry. Production runtime-composition is intentionally not wired to a fixture; actual endpoint/assets/local-dispatch implementation remains required.

Carrier GREEN r1 passed: API/shared build, 8/8 carrier regressions, 55/55 affected module/predicate/data-directory regressions, zero fail/skip/cancel, Biome (one start-method complexity warning), diff. Exactly 16 compiled files changed within the four intended source families; source/runner/scope continuous. No claim that the concrete provider or real activation passed. Evidence: `f202-acceptance/collective-host-93fee434/browser-service-carrier-green-r1/`.
