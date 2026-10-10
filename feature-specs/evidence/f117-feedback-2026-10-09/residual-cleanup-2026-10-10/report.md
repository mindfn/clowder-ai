# F117 residual code retirement

Authorization: operator `0001791603099297-000023-e1f693f2` asks what the placeholder and content-modification availability check mean, and explicitly asks to clean residual code. Base: published `7c87b0f8ef5fba154fb36a757798012f4e841a72`; fork #219 was already merged as `9e464952788a886a0c89aff1859d72d6bcfca155`, complete tree equivalent.

## Scope and reasons

- Remove the disconnected automatic Signal article lookup, unused InvocationContext/AssemblerInput fields and formatting bridge, D20 resolver/catalog registration, manifest/template, preview entry and generator entry. Both ordinary routing strategies had already stopped producing this context in #218. Active article lookup/read APIs and article storage remain unchanged. Existing test-only D20 firing case retires with the hook; active catalog counts adjust 46→45 and per-turn counts 24→23. No replacement hook, condition or fallback.
- Remove normal-send routing projection's always-false source-attribution input and unreachable reference emission, and orphan F293 comments. Historical routing source lookup and stored routing signals remain readable; they are not deleted.
- Remove 12 stale generated files for the deleted owner-attempt/preflight-notice/Signal lookup modules from the owned feature dist only. No runtime output or user data touched.
- Correct one stale StudyFoldArea comment that claimed the removed automatic field still supplied article context. No UI behavior change.

## Clarifications, not extra feature work

The composer placeholder picks its sentence from `messageDisposition.effective`, a sending preference. The current sentence says an append can avoid interruption without qualifying the recipient capability; real dispatch still resolves the recipient capability. The intended explanation is conditional wording, not another routing policy.

`collaborative-content/modification/target-service.ts` serves the content review modification form. It lists members/threads and preflights `authorize` and return delivery, throwing `target_denied` before requests to predicted-unavailable members. The frontend disables those choices or shows warnings. This is a separate remaining consumer, not fixed by this dead-code cleanup; no claim it should bypass genuine artifact/thread/run ownership checks. No change to that flow in this candidate.

## Validation and ownership

Shared build and API tsc passed. Eleven relevant API files: 291/291, covering resolver catalog, real registry/template assembly, prompt/transport boundary, source attribution and active article storage. Initial post-retirement run had three catalog-count assertion failures (288/291); the original log is preserved and all retired-hook counts were corrected. Biome on the 23 changed JS/TS files and git diff check passed. No live-provider, runtime-data experiment, broad gate, or unchanged Web suite rerun.

Architecture cell: prompt assembly and normal-delivery routing consumer retirement. Map delta: no new owner/writer/read path; remove orphan hook and dead assembly contracts after their producers already retired.
Canonical source: `packages/api/src/domains/prompt-hooks/resolvers/index.ts#RESOLVER_MAP`, `SystemPromptBuilder.ts#InvocationContext`, `RoutingContext` ordinary-delivery retirement as merged in #219.
Consumer evidence: repository `rg` for activeSignals/SIGNAL_ARTICLES_BLOCK/createSignalArticleLookup/hasRoutingContextProjection/D20Resolver/d20-signal in packages/api/src, packages/shared/src, assets and scripts has zero matches after retirement; no production factory caller existed before removal.
Claim guard: existing registry, segment coverage, transport boundary and prompt tests validate all surviving hooks and source-attribution owners. Preserve active Signal article-store tests.

Independent review, publication and merged-runtime uptake of this cleanup remain pending at this author cut. Earlier 709/7c87 verdict and CI do not cover this new candidate. No self-merge or restart.
