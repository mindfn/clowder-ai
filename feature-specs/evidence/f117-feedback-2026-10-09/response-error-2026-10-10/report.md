# Response error display — operator feedback 100 / 111

Accepted source: `thread_msr51149hym0i79f#0001791604239991-000111-b1752ff1` (same immutable revision). Original feedback: `0001791604122490-000100-3c8bea8b`.

Operator clarified that the two Opus failures came from two distinct requests. This delta only removes duplicate error presentation; no retry, response grouping, provider, queue or persistence behavior changes.

## Cause and change

Serial and parallel routes already accumulate the complete provider error in the named response body. ChatMessage additionally projected CLI/timeout diagnostics below that same response, repeating its failure as a banner, hint and folded excerpt. Delete the response footer projection and its unused response-only banner switches. The body remains the error surface; persisted `extra` diagnostics remain available. Standalone system failures with no admitted response still use their existing panel. Historic empty terminal responses keep their single lifecycle notice. The list/export diagnostics projection excludes responses, matching the actual rendered surface.

Old response-panel assertions are replaced with the final contract: complete body, no duplicate panels, retained diagnostic metadata, empty historic outcomes and two independent response bodies/anchors. Standalone classification, timeout, excerpt safety and dedup behavior remain covered.

## Verification

- Red: real ChatMessage ownership test, 3 failures / 1 pass against pre-change code, reproducing classified CLI, unknown CLI and timeout duplicates.
- Green: 7 related Web files, 64/64, including real ChatMessage, lifecycle renderability, visibility, list dedup and export dedup.
- Standalone CLI panel tests: 15/15 after removing the unused response-only presentation mode.
- Biome check passes (existing warnings); git diff --check passes.
- Headless Chromium loaded `file:///tmp/f117-error-preview/index.html`, built from this worktree's actual ChatMessage with inert fixture data/fetch, at 1440×600 and 390×600. Author inspected both screenshots. Each DOM receipt confirms one original error, zero duplicate panels and unchanged diagnostic payload. This is an isolated component preview, not a full shell/provider/runtime/soak acceptance. No service port, runtime data or process touched.

## Continuity and limits

4f04c36a4b99acf19a747b74bc3d687d501d4f9d cleanup/tips approval remains bound to tree 352e4d56f5254b1963861a3d9256ac064c9ea441 and reviewer message 0001791604181900-000105-4a948a51. It does not approve this new error delta. This delta requires its own exact-head peer verdict before publication.

Operator121 optional retry inquiry was independently checked by Astra (message 0001791604492036-000126-659bced1): no generic failed-response manual retry endpoint exists. Per operator's conditional scope, no button or new backend is added. No API/full gate rerun for this frontend-only delta; prior API evidence remains scoped to the earlier cleanup. Overall F117/#1398 operator soak remains open.
