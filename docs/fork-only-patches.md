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

## What actually survives: the remote-tracking ref

`git reset --hard upstream/main` replaces the working tree. It does **not** move
`origin/develop_base`. The previous tree's registry is therefore still readable
straight out of git after the rebuild has erased it from disk:

```bash
git show origin/develop_base:scripts/fork-only-patches.json
```

So the guard compares what the previous tree **claimed to protect** against what
the new tree **actually has**. It stays runnable even when the rebuild deleted
it, because it can be read from the same ref:

```bash
cd <repo>                      # the guard asks git where the repo is, from CWD
git show origin/develop_base:scripts/check-fork-only-patches.mjs > /tmp/guard.mjs
node /tmp/guard.mjs            # or: node /tmp/guard.mjs --repo-root <repo>
```

The rescued copy resolves the repo from the working directory, not from where
the file happens to sit, and it detects direct invocation by **real** path -
running it from a symlinked location (macOS `/tmp`) must not make it exit 0
having checked nothing.

## Two checks, both required

```bash
pnpm check:fork-only-patches
```

1. **Tree check** - is each registered patch here right now? Answers
   "is production broken".
2. **Rebuild-survival check** - is everything `baselineRef` claimed still
   present? Answers "did this rebuild drop something", **before** the result is
   pushed or deployed.

Both fail closed: a missing registry, an unreachable baseline, a hollow patch
entry, or an anchor that moved after the step it must precede are all red. A
guard that cannot see its input must not report clean. The one deliberate
exception is a baseline that carried no registry at all - an absent prior claim
is not an unverifiable one.

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
