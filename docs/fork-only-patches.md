# Fork-only patches

Patches this fork carries that **upstream `zts212653/clowder-ai` main does not**.

Every `develop_base` rebuild onto upstream main starts from a tree without them.
If nobody re-applies them, they vanish silently.

## Truth source

`scripts/fork-only-patches.json` — machine-readable registry.
Enforced by `scripts/check-fork-only-patches.mjs`, wired into `pnpm check`.

This document explains the *why*; the registry is the *what*. Do not duplicate
the file/anchor lists here — they would drift.

## Why a guard instead of a checklist

The F192 evidence-prerequisite gate was lost **three times**:

| When | How | Noticed after |
|---|---|---|
| 2026-08-11 | develop_base rebuild | ~2 days (PR #91 recovery) |
| 2026-08-28 | develop_base rebuild | ~1 day (PR #137 recovery) |
| 2026-09-01 | commit `70d79a2f2` — a commit whose own title was *"recover fork-only development layer lost in develop_base rebuild"* | **21 days** |

Each loss let the scheduler burn one full LLM session per daily eval fire,
re-concluding a gap it could not act on.

The third loss is the decisive one: a rebuild that was *explicitly trying* to
recover fork-only code still missed this patch. Human/agent recall is not a
mechanism. A guard is.

## Upstream boundary

Pushing these patches upstream is **not** the answer, and was already decided:

> Closing — this is fork-specific harness logic that doesn't belong in upstream.
> The rebuild-loss issue should be solved by improving our fork's develop_base
> rebuild SOP (rebase fork-only patches), not by pushing internal code into the
> community repo.
>
> — `zts212653/clowder-ai#1352`, closed 2026-08-25

Upstream review of that PR also surfaced two real defects, both fixed in the
fork version rather than carried forward blindly:

1. The probe read the **scheduler process's** telemetry handle while evidence is
   fetched from the **adapter target** (`EVAL_BASE_URL`). These coincide in this
   fork's single-process deployment, but only accidentally. The probe now
   asserts co-location via `evidenceTargetIsLocal` and fails closed when it
   cannot prove it.
2. The skip notice always advised configuring `TELEMETRY_HMAC_SALT`, even when
   the detected cause was an intentional `OTEL_SDK_DISABLED=true`. The next-step
   text is now derived from the detected cause.

## Why a tree-only check is not enough

A develop_base rebuild is, quoting commit `70d79a2f2`'s own body:

> The develop_base rebuild (b739c279c) reset to origin/main + fork/optimizations
> but dropped all develop_base-only merges - 33 first-parent commits [...]
> 443 files modified by BOTH main and fork: **NOT restored**

Two things follow.

First, the shared-file edits (the `requiredAnchors` below) fall exactly in that
"modified by BOTH / not restored" bucket. The file survives, the fork's edit
inside it does not - so an existence check reads clean while the patch is gone.

Second, and worse: a check that reads its registry **from the tree** cannot
report on a rebuild that replaces the tree. The reset takes the registry and
this script along with the patches, and a guard that is not there does not go
red. That is how three losses stayed silent.

`fork/optimizations` does not solve this either. It is an orphan snapshot - 7
commits, no merge-base with upstream main, a July full-tree copy - so
"is the patch in the carrier" is not a survival predicate, and asking for
current code to be committed onto a stale unrelated history is incoherent.

## What actually survives: an immutable pre-reset commit

`git reset --hard upstream/main` replaces the working tree, so the baseline has
to come from outside it. Two sources qualify, and one that looks like it does
**not**:

| Source | Immutable? | Notes |
|---|---|---|
| `github.event.before` (push) | yes | previous branch tip, supplied by the platform; survives force-push |
| `github.event.pull_request.base.sha` | yes | the PR base |
| local `origin/develop_base` **before** pushing | yes, briefly | still names the prior tip during a manual pre-push run |
| `origin/develop_base` fetched **after** the push | **NO** | it is the tree being validated |

That last row was a real bug in this workflow's first version: CI fetched
`origin/develop_base` after the push, so the baseline *was* the accused. The
checker now refuses to compare a commit with itself and says so, instead of
reporting a cheerful green.

### The registry is a shared file too

A rebuild can **revert** `scripts/fork-only-patches.json` rather than delete it.
Both trees then look internally consistent, and a guard that only checks the
patches its *current* registry lists will confirm its own amnesia as healthy.
So the survival check compares the **claim sets**: every patch id the baseline
registered must still be registered. A claim that quietly disappeared from the
registry is a loss, not a smaller honest claim.

### Running it

```bash
# Rebuild pipeline: capture the tip BEFORE the destructive reset.
PRE=$(git rev-parse origin/develop_base)
git fetch upstream && git reset --hard upstream/main   # ... rebuild ...
node scripts/check-fork-only-patches.mjs --baseline-ref "$PRE"
```

`--no-baseline` skips the survival half and says so in the output. It exists for
the one honest case with no prior tree (branch creation) and must never be used
as a fallback when a baseline lookup failed - a guard that quietly downgrades
itself is the disease, not the cure.

## What this in-tree workflow does NOT close

`.github/workflows/fork-only-patches.yml` cannot survive its own deletion. If a
rebuild drops workflow + guard + registry together, GitHub runs the workflow
**from the pushed commit**, where it no longer exists, so nothing runs and
nothing goes red.

So, honestly scoped:

- **Closed by the workflow**: any rebuild that preserves it - the baseline is the
  immutable pre-push SHA, so dropped files, reverted anchors and dropped registry
  claims are all named before the result is deployed.
- **NOT closed by the workflow**: a rebuild that deletes the workflow itself.

The authoritative enforcement for that case lives **outside the repository**, in
branch protection, and is not configured by this PR:

> Settings -> Branches -> branch protection rule for `develop_base`
> -> **Require status checks to pass before merging**
> -> required check: **`Fork-only patch guard`**

A required check that never reports **blocks** rather than passes, which is
exactly the fail-closed behaviour the in-tree file cannot provide for its own
absence. This requires repository-admin rights; until it is configured, treat
the workflow as covering the common case only, and do not claim the full-wipe
case is mechanically prevented.

## Rebuild SOP

Run the guard as the **last step of a rebuild, before pushing**:

```bash
git fetch origin develop_base            # baseline must be present
pnpm check:fork-only-patches
```

Red output names each dropped file and anchor. Re-apply them, then re-run. Do
not push or deploy a rebuild while this check is red.

CI runs the same guard on every push and PR to `develop_base`
(`.github/workflows/fork-only-patches.yml`) - every other workflow in this repo
triggers on `main` only, which is why losses on develop_base went unseen.

## Adding a patch to the registry

Add an entry to `scripts/fork-only-patches.json` with:

- `id`, `owner`, `why` — what breaks in production if it disappears
- `upstreamStatus` — why it is not upstream (so nobody re-litigates it)
- `requiredFiles` — files that must exist
- `requiredAnchors` — files that must still *contain* given symbols, for patches
  that modify shared files rather than adding new ones (these are the ones a
  rebuild silently reverts, since the file still exists)
- `order` - call-site strings that must appear in sequence, for patches whose
  meaning is positional. Bare substrings are satisfied by an import, an
  interface field or a comment; anchor on the call site instead, so a gate
  moved after the step it must precede is caught.
