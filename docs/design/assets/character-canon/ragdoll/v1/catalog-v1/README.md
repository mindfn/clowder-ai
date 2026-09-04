# Ragdoll action catalog — canon v1

Status: **38-pose Ragdoll reference catalog**. The turnaround identity, look-down, and four high-occlusion probes were operator-approved before the remaining catalog was generated.

## Contract

- One neutral full-body action per static row; animation can append frames later.
- Every runtime action is a left-facing side view.
- Every row is a one-frame 192×208 RGBA strip.
- ragdoll-actions-preview-59x64.png is the real-display-size readability sheet, ordered exactly as the manifest.
- High-resolution transparent masters live in masters/; consumer rows live in the shared dist/ directory.
- Props appear only where the action would otherwise be ambiguous: climb/rub/headbutt contact surfaces, drink bowl, carry/present note, perch ledge, and the Ragdoll's notebook for work/read.

## Vocabulary

- Posture: sit, stand, lie, loaf, sprawl, curl, sleep, crouch
- Movement: walk, run, pounce, jump, land, climb
- Attention: look-down, look-up, alert, startle, flatten
- Social: rub, knead, headbutt, belly-up, tail-up
- Self-care: groom, stretch, yawn, scratch, drink
- Work: reach, carry, paw, wave, perch
- Thinking/work: work, think, present, read

The vocabulary stops when an action has a consumer mapping or an independently recognizable feline silhouette. Facial-only differences remain in the separate expression catalog.

## Generation provenance

Generator: built-in OpenAI image generation, one distinct action per call.

Common prompt contract:

> Use the operator-approved Ragdoll turnaround. Preserve the small fluffy silver-gray and cream Ragdoll, tabby markings, large blue eye, pink ears and nose, purple collar and flower pendant. Draw one complete left-facing side-view cat in 2D hand-drawn anime style with clean outlines. The silhouette must survive 59×64 display. Use transparent alpha; no scene, shadow, text, crop, duplicate cat, or fused limbs.

Each call added only the named action's anatomical pose and the minimum required prop. Generated fake checkerboards were not accepted as transparency. site/tools/prepare-character-action.mjs removes only pale low-chroma background connected to the canvas edge, crops the resulting alpha, scales without changing aspect ratio, and pads to the house cell. site/tools/build-character-contact-sheet.mjs performs the required 59×64 batch check.

## Review lineage

- Turnaround identity: operator-approved on 2026-09-04.
- look-down: operator-approved on 2026-09-04.
- knead, curl, belly-up, groom: operator approved the four-pose probe gate on 2026-09-04.
- Remaining actions were produced in the approved “probe, then complete once” lane.
