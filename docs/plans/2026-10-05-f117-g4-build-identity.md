---
feature_ids: [F117]
topics: [a2a, build, deployment, provenance]
doc_kind: implementation-plan
created: 2026-10-05
tips_exempt: "Startup provenance repair; no new UI, capability or operator procedure."
---

# F117 G4: direct-start build identity

## Authority and scope

Owner: sol (`cat-eqdvbcxw`); independent reviewer: astra.
Task: `0001791168030833-000194-f095e014`.
Implementation request: thread `thread_msr51149hym0i79f`, message
`0001791168302580-000195-c47bc3f7`; source base
`51ec83287fa4a7e7fc875baf1122ea3baf386dd3` on fork `develop_base`.

The existing roadmap records an API/Web build-stamp mismatch and
`deploymentRevision: null` after normal startup. This slice repairs the writer
in `start-dev.sh`, not the strict reader or forwarding admission policy. It is
not an A2A completion, merge, runtime-restart, human-acceptance or soak decision.
The retired Needs Me sample must not be restarted for this work.

Architecture cell: warning — no dedicated startup/build-provenance ownership
cell was identified in the current map; this is an independent-review focus.
Map delta: none (existing launcher and build-stamp contract, no new service/store).
Why: publish completed build identity where the actual build is executed;
do not infer it from the checkout at API startup or weaken admission checks.

## Consumers and existing writers

- `scripts/start-entry.mjs` invokes `start-dev.sh`; its normal `build_packages`
  builds shared, MCP and API, plus Web for production mode. This is the missing
  complete-build writer repaired here.
- `packages/web/next.config.js` embeds the revision using
  `packages/web/scripts/build-revision.cjs`. Web postbuild uses
  `packages/web/scripts/write-build-stamp.cjs`. The launcher pins both to the
  captured revision and verifies the resulting Web stamp before publication.
- `packages/api/src/config/runtime-deployment-revision.ts` accepts only two
  matching 40-character stamps. API health/home-state and Web
  `useConnectionStatus` / forwarding admission consume that revision. These
  readers and their permission semantics are unchanged.
- `scripts/runtime-worktree.sh` and `scripts/alpha-worktree.sh` also use the
  existing `scripts/lib/quickstart-freshness.sh` per-package writer. Their
  freshness/build-selection protocols are not replaced by this direct-launcher
  transaction. This change is not a global provenance-hardening claim.

No same-path implementation was found in the inspected open fork PR files or
local feature branches. That bounded inspection is not a global absence claim.

## Build transaction and acceptance criteria

1. Capture a clean, exact Git revision before any compiler runs; clear the four
   disposable old stamps before beginning. No runtime/user data is touched.
2. Run the real selected package builds, preserving their failure exit code.
   Pin Web's embedded and postbuild revision to the captured value.
3. Publish only after every selected build succeeds, inputs and HEAD still match,
   and nonempty products exist. An unchanged product is acceptable only when
   its previous stamp already proves this exact revision. A stale output plus a
   successful no-output command cannot be relabelled as the new revision.
4. Production builds publish matching API/Web stamps. Partial dev builds leave
   Web unstamped, so the strict reader remains unavailable. Quick mode never
   invents new stamps for retained products.
5. Build failure, interruption, dirty/unknown source, input changes, or a normal
   HEAD move-and-return invalidate stamps. Check source stability again after
   the small stamp set is written; stamp replacement is atomic per file, not an
   atomic multi-file snapshot for concurrent readers.
6. Retain strict failure on missing, malformed and mismatching stamps. No text
   inference, HEAD-at-startup fallback or forwarding-guard bypass is added.

Source stability uses Git status, exact HEAD and source file/directory/reflog metadata,
covering workspace packages, the inherited root TypeScript configuration,
scripts and root dependency manifests.
The existing directories containing tracked inputs (and their parents within
the input roots) retain namespace epochs: creating then removing a source file
or an entire source subtree cannot disappear between the endpoint observations.
Known `dist` and `.next` directories are established before observation, and
their ignored contents are not traversed. Changes inside these output trees do
not invalidate otherwise stable source. Package roots and Web `public` contain
both inputs and generated output: one foreground Node owner watches those
directories for the entire compiler interval. Only the known generated names
(`dist`, `.next`, TypeScript build-info, PWA JavaScript/maps and `vendor`) are
accepted there. Unknown names, missing filenames, observer errors, replaced
directories or a changed namespace without an observed event invalidate identity.
The observer remains live through final publication; namespace epochs are
checked against its end snapshot before and after publication. Low-level
begin/finish without this in-process proof still rejects any mixed-directory
epoch change. There is no detached watcher or persistent observation ledger.
The workspace root is not directory-fingerprinted (it also holds unrelated logs);
its existing declared configuration files are fingerprinted individually. New
undeclared root-level compiler inputs and platform event loss/coalescing are not
a hermetic provenance claim. Unknown observed events fail closed; this is an
ordinary-change guard, not a hostile-writer/security attestation.
It detects ordinary edits including edit-and-restore and HEAD move-and-return;
it is not an exclusive writer lock, cryptographic artifact attestation, or a
hermetic build. Dependencies, toolchain/environment reproducibility and hostile
metadata manipulation are not proven by these existing commit stamps. Run one
launcher per checkout; concurrent build publication is not newly supported.

## Verification and risk alignment

Behavior: startup identity changes. Data: disposable build metadata only.
Security: fail-closed admission provenance, no permission expansion.
Contract: unchanged 40-character API/Web equality contract.
Irreversibility: none; no config/user-data changes or runtime restart.

- RED: the prior normal build path retained old stamps after success/failure;
  the initial regression run had ten failures and the quick-mode test passed.
  Added no-output and edit/HEAD-restore regressions separately failed before
  their corresponding checks were implemented. Root TypeScript config and
  workspace-dependency mutation tests also failed before expanding the input set.
  Independent review then found added-then-moved inputs were absent at both
  observations. The new temporary-source and temporary-source-directory tests
  both failed before adding directory epochs; generated-output namespace churn
  remained green. A real TypeScript compile regression now retains the emitted
  transient code and proves all stamps are invalidated after its input is moved.
  The first real rebuild of `fd4a4913d7` compiled successfully but invalidated all
  stamps because normal TypeScript/PWA generation changed mixed-directory
  epochs. This failed handshake is retained at `/tmp/f117-g4-p2-build-CbEWxV`.
  Regressions now cover root-level source/subtree and public-source transients,
  reject even unknown ignored siblings, and accept observed build-info/PWA output.
  These are deterministic compiler
  seams through the production launcher, not real compiler evidence.
- GREEN: run `node --test scripts/start-dev-build-identity.test.mjs` plus the
  existing launcher isolation and Web writer/config tests.
- Dogfood required: invoke the actual `build_packages` from this feature checkout
  with production Web, then read its real stamps through the compiled strict API
  resolver. No service launcher/main, Redis or model is needed for this path.
- Consumer regression: compiled API deployment-revision tests and focused Web
  connection/forwarding-admission tests; production Web postbuild policy checks.
- Syntax/format: Bash syntax, scoped Biome and `git diff --check`.
- Targeted checks plus the complete real package build cover this writer-to-reader
  cross-package join. No queue/Redis/persistent schema or product UI is modified;
  unrelated A2A/model matrices are not rerun. Independent review is still required.

Fallback coordinate check: missing Git/input/product/stamp evidence is uniformly
untrusted, never a substitute revision. Exception boundaries distinguish source
observation, optional prior artifact evidence and publication cleanup; none
changes an unknown revision into an accepted one.

Computer Use page verification remains a separate technical check. The operator
requested that cats perform it themselves (message
`0001791167914042-000191-17bd8b09`). At implementation time the required
`node_repl`/Computer Use runtime was not exposed; this is not a page pass or an
instruction for Landy to execute tests. Recheck tool availability before any
isolated page acceptance; do not substitute the production instance.
