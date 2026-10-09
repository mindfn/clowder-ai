---
topics: [harness-eval, publication, fork]
doc_kind: note
created: 2026-10-09
updated: 2026-10-09
---

# Ordinary fork integration and the verdict publication guard

An ordinary PR from the A2A integration branch to `mindfn/clowder-ai:develop_base`
was refused as a new verdict publication. Its only protected path was
`docs/harness-feedback/registry/measurement-bundles.yaml`, already published on
main with mode `100644` and blob `6eff868134d26b5747d6631965bf1d136cd1a315`.
The old classifier used changed path names alone and demanded the separate
verdict repository and an absent checker.

## Scope and history

This maintenance starts from `develop_base@d35f3b8e54b689fb9c4b04ff4a6ec9e655d56d10`.
It does not import the A2A candidate, change running files/configuration, or
restore Git verdict publication. The A2A public candidate remains
`028a63af71bc3ae6f9ebf9fcf8bd542c0e02d40b`; the fork candidate remains
`00a513906e2a30248e603b9fe079c9643e2cfcd1`.

History is not evidence of an available checker. `5fb169c6c1` and `2bf188edff`
retired Git verdict publication in favor of durable artifacts;
`96e79e3936` introduced fail-closed census bootstrap, and `69c699bc11` retained
that direction. Later source-sync snapshots again contain GitPublisher and the
old guard. Current consumers still request `check-verdict-publish-contract.mjs`,
but neither available Git history nor the workspace contains its implementation.
That contradiction is not repaired by inventing a success-only checker.
The scope decision is recorded at
`thread_msr51149hym0i79f#0001791532694141-000012-bad52c07`.

## Classifier contract

Only protected paths that are exact objects inherited from published main may
be removed from the path-trigger classification:

- The declared origin is a GitHub repository matching every explicit PR target;
  a different host or repository does not receive the exemption.
- Before computing any diff, the exact local head and cached origin/base must
  match freshly advertised remote head/base commits in that repository. Diverged,
  missing or stale coordinates refuse publication. An explicit base is required;
  the guard does not guess the CLI's configured merge base or default branch.
- Cached origin/main equals the current advertised remote main commit, and that
  commit is an ancestor of the exact candidate.
- Every exempted path has the same nonempty NUL-delimited tree entry, including
  mode, object type, blob ID and literal path. A deletion cannot be exempted.
- Explicit `--head` resolves the branch itself, not the current checkout or a
  same-name tag. Owner-qualified remote heads are conservatively refused because
  this local guard cannot prove their candidate.
- A default head must already exist remotely and match the current branch. The
  delegated command receives that verified explicit `--head`, skipping the CLI's
  automatic push/fork selection and preventing a different tracking branch from
  becoming the publication candidate. Push the branch normally before retrying.
- Explicit verdict title/head/branch/commit intent still enables the original
  target and publication-contract checks. Any unexempted protected path does too.

Git query failures refuse publication; they cannot become empty diffs. Missing
checker is a named `verdict_publish_guard_unavailable` refusal. No checker,
permission bypass, remote retargeting, new polling or runtime activation is added.

## Validation and delivery

Owned temporary repositories and a recording CLI/checker fixture test both the
ordinary sync and the refusal paths without any real PR publication. Regressions
cover changed/new verdicts, bundles, census, NUL/newline paths, mode/symlink
changes, deletion, unpublished main, missing ancestry, wrong target/host, missing
checker, contract failure/success, invalid base, explicit head and same-name tags.
The initial production baseline failed four of fifteen tests; the red log is
retained. The final candidate also runs environment registry/example checks,
syntax, formatting and whitespace checks. Exact logs and hashes accompany review.
The first maintenance review found that fresh main alone did not bind PR head
and base: a divergent remote head and an ahead-of-server base cache both escaped
the contract. Those independent failures and a default-head automatic-push
counterexample are retained as red evidence; the successor verifies all remote
publication coordinates before even the empty-diff fast path. Fixtures now
publish positive candidates explicitly; negative cases retain mismatched or
missing remote refs.

Independent review precedes the maintenance PR. Normal merge/pull delivery must
activate the reviewed guard before the original A2A fork PR is retried through
the canonical CLI. This branch does not edit the running guard or merge itself.
