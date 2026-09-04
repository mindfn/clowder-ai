# Ragdoll look-down — canon v1

Status: **identity and action approved by the operator on 2026-09-04**. This asset is not runtime-wired yet.

## Asset roles

- `ragdoll-look-down-master.png`: transparent high-resolution pose master.
- `ragdoll-look-down-row.png`: one-frame 192×208 row strip, strict left profile.
- `ragdoll-look-down-preview-59x64.png`: real display-size preview.
- `ragdoll-stand-vs-look-down-preview.png`: approved `stand` followed by candidate `look-down`, each displayed at 59×64, for world-scale comparison.

The processed opaque bounding box is `140×145` at `(26,53)` and ends at `y=197`, matching canon `stand`; candidate `anchorOffsetY=10`.

## Action contract

- State: `look-down`
- View: side, facing left
- Expression: neutral
- Behavior: seated on haunches with forepaws grounded; neck flexed; chin, muzzle, nose, and visible eye directed about 45° below horizontal toward an imaginary ground point immediately before the forepaws
- No target object, seed, ground, shadow, particles, or other consumer-specific scene content

## Generation provenance

Generator: built-in OpenAI image generation tool.

Identity reference: `../../ragdoll-stand-turnaround-master.png`, approved by the operator on 2026-09-04.

Prompt summary:

> Draw exactly one complete strict-left-profile view of the approved Ragdoll cat in a neutral seated `look-down` pose. Both forepaws rest on the implied ground; the neck visibly flexes, chin lowers, muzzle and nose point diagonally down, and the visible blue eye focuses on an imaginary spot just before the paws. Preserve the approved proportions, silver-gray tabby markings, cream chest, blue eye, purple collar, and flower pendant. Use genuine transparency and include no target, floor, shadow, prop, scenery, text, effects, duplicate limbs, crop, three-quarter face, or horizontal/upward gaze.

Deterministic processing: opaque bbox crop → 140×145 scale → transparent pad to 192×208 with shared baseline → 59×64 previews.

## Gate checklist

- [x] PNG RGBA with real alpha
- [x] Strict left profile
- [x] Downward head angle and eye direction are legible
- [x] Shared baseline and smaller seated world height
- [x] 59×64 readability preview
- [x] Operator: “this is still our Ragdoll / 宪宪”
- [x] Operator: reads as “looking at the ground”, not merely sitting
- [x] Operator: approve as the `look-down` basis for the other cats
