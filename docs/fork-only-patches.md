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

## Rebuild SOP

After any `develop_base` rebuild onto upstream main:

```bash
pnpm check:fork-only-patches
```

Red output names the exact missing files and anchors. Re-apply them, then
re-run. Do not merge a rebuild while this check is red.

## Adding a patch to the registry

Add an entry to `scripts/fork-only-patches.json` with:

- `id`, `owner`, `why` — what breaks in production if it disappears
- `upstreamStatus` — why it is not upstream (so nobody re-litigates it)
- `requiredFiles` — files that must exist
- `requiredAnchors` — files that must still *contain* given symbols, for patches
  that modify shared files rather than adding new ones (these are the ones a
  rebuild silently reverts, since the file still exists)
