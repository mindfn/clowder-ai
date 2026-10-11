---
feature_ids: [F202]
doc_kind: plan
topics: [plugin-framework, local-directory, dependency-integrity]
architecture-cell: plugin
tips_exempt: "Internal preparation and admission checkpoint. Existing Manager install workflow remains under C1 acceptance; no new command or independently usable UI is delivered by this checkpoint."
---

# C1 local source directory preparation

Original requirement: operator094/096 in thread_mu8dg6h7l2x4ohsk requests removal of plugin business from Host, independent plugin packages, and installation by selecting the actual plugin repository directory in a feature worktree. Authority remains the original C1 Host chain and [C1 contract](../docs/plans/2026-09-21-f202-c1-contract.md). This is an internal review checkpoint, not completion of any of those three whole-feature requirements.

Architecture cell: plugin. Map delta: extend existing local admission, archive staging and content-addressed package storage. Why: copying every node_modules member imported development dependencies, exceeded limits, and did not establish a reproducible runtime closure. No second dependency store, activation authority, plugin-specific route or public installation source type is added.

## Implemented boundary

- Preserve `{kind: "local-directory", path}` and existing immutable archive publication, locator, grant and inventory path.
- For package.json sources, inspect source-owned pnpm v9 importer/snapshots and actual dependency resolution before publication. Missing/unsupported lock or unsupported protocols fail explicitly. SemVer uses a direct locked semver 7.7.4 dependency with normal prerelease semantics.
- Registry nodes require an existing original compressed archive in the Host content-addressed package cache. Verify lock SHA-512, bounded shared preflight and canonical publication members against the physical source. Missing canonical bytes are an error; CAFS/index or a locally repacked archive is not registry proof. No network fallback or environment override.
- Workspace/local nodes bind their declared importer and physical root, then use npm pack --ignore-scripts --offline publication semantics on private snapshots. No source build/install scripts. No package ID special cases or deletion of declaration files to fit budgets.
- Preserve runtime versions, peers, cycles and optional absence during relocation. A source-absent optional dependency that would become visible from an installed ancestor is rejected rather than silently changing runtime semantics.
- Recheck source members, metadata, resolution, lock and registry originals; bind topology and provenance in the immutable candidate receipt. Registry SRI and owner-local content digest remain distinct. Final archive passes the shared budget/preflight; failures precede grant and inventory writes.
- Existing standalone local directories without package.json retain their existing bounded copy path.
- Consume the exact reviewed local contract beta.36 archive, update Manager capability enumeration for browser-service and use the existing shipped closure runtime path. This does not implement or activate browser-service.

## Evidence and risk

Latest exact product validation:
`/Users/lang/workspace/github-lab/f202-acceptance/collective-host-93fee434/directory-topology-green-r1/`.
Before/after product source digest: `34756f78e18cb6716462050bcb91af065eb7168c23b6bc9a06dec15b98f9bc14` (before this documentation/commit only).
API/shared build passed; registry/topology 11/11, source admission 6/6, affected admission/materializer/catalog 37/37, zero failures/skips/cancellations. Diff check passed. Prior observed topology RED was 10/11 with the exact missing optional-resolution rejection, while cycle and multiversion positives passed.

Dogfood: actual `clowder-ai-plugins-collective-sol/packages/collective-connector` through production LocalPluginPackageAdmission, seven exact original archives seeded into a batch-only cache, ten-node receipt (seven registry and three local), immutable archive integrity, and installed entrypoint passive import. All six checkpoints passed. Source reads, writes, child/worker creation denied in the passive child; zero network/listener attempts; create/start not called. Memory inventory observes disabled/stopped. This is real-source offline admission, not a real authenticated Manager/browser session.

The prior archive-preflight 21 cases and original archive census remain evidence for its unchanged parser; package-staging factoring is additionally covered by affected admission regressions and the actual directory probe. Beta.36's exact archive pin is sha256 `578d0a2fbdf3b308ad8b7b1b0f56be5ba2fd40593df0a71b67021cc6e7d0b186`; no registry substitute for the unpublished artifact.

Risk axes: behavior=dependency/member selection; data=immutable candidate and failure-before-inventory; security=hostile files/archives, lock/SRI/currentness, scripts and relocation; contract=existing source shape plus exact beta.36 consumption; irreversible=no release, merge, runtime or production-data mutation.

## Open C1 work, retained by original owners

Host owner retains production canonical archive acquisition, durable authenticated Manager/browser directory journey, activation/browser-service/private connector/control wiring and full Host cleanup acceptance. Package owner retains mismatched pins, missing assets and plugin-specific migration gaps. No ordinary offline source install is promised for a registry graph whose original archives are absent. This checkpoint does not make the operator seed a test cache as the final product flow.

Independent review and mechanical quality checks are pending at the time of writing. Existing directory UI WIP is excluded from this review target and still needs real browser interaction. Human acceptance, fork soak, merge/release and full C1 are not approved. Full requirement completion cannot be inferred from this checkpoint's test counts.

## Directory lifetime review correction (040 → 042)

Independent review of e2e5b29e returned changes_requested: source inspection ran before the 30-second deadline, did not consume caller cancellation, and bounded individual nodes but not total graph work. The standalone directory copy path had the same lifetime gap. The observed directory-lifetime RED is 10 tests / 6 pass / 4 fail. Its dense-graph failure returned npm sentinel exit code 71, proving npm was reached; it must not be described as a pre-npm rejection.

The correction creates one internal operation before the first source read and carries it through read-set verification, graph construction, registry/member attestation, packing and the standalone path. It limits declared edges to 4,096 per candidate and direct filesystem/traversal work to 262,144 steps; streamed directory enumeration also consumes that budget. Existing per-file, metadata, package-instance and shared archive limits remain in force. Delegated archive staging retains its own bounded preflight and consumes the same cancellation signal. Cursor traversal and enqueue deduplication avoid repeated queue shifts; the shared metadata read set is checked at deliberate phase boundaries and once after final member verification, not once per node.

Cancellation stops scheduling new operations. An already-running filesystem syscall is awaited before releasing its handle/staging; no abandoned Promise race or false claim of forcibly cancelling an OS syscall. Cleanup runs even after cancellation. The directory-lifetime-green-r1 batch passed build, source10/10, registry/topology11/11, affected admission37/37, and all six real-directory checkpoints, with zero failures/skips/cancellations. The tested source digest is 812b803b97fea7eae2e4257d08b56abccd82320e66e2cfeb1afde1536ca38f52, including the then-pending evidence wording in this document. Source and exact package inputs were unchanged during execution; the author read the complete logs and verified current source/input/dist hashes. The reviewer’s successor verdict is still pending; this correction does not close the original C1 acceptance gaps.
