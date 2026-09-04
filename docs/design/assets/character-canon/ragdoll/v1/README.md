# Ragdoll stand turnaround — canon v1

Status: **identity approved by the operator on 2026-09-04**. None of these files are runtime-wired yet.

## Asset roles

- `ragdoll-stand-turnaround-master.png`: transparent high-resolution identity master containing front, exact left profile, and back views.
- `ragdoll-stand-front-cell.png`: 192×208 front-view identity reference cell.
- `ragdoll-stand-row.png`: 192×208, one-frame, left-profile `stand` row-strip candidate for consumers.
- `ragdoll-stand-back-cell.png`: 192×208 back-view identity reference cell.
- `ragdoll-stand-turnaround-row.png`: 576×208 three-cell identity contact sheet. It is **not** a three-frame animation.
- `ragdoll-stand-preview-59x64.png`: the three views reduced to the real 59×64-per-view display scale.

All three cells have their lowest opaque pixel at `y=197`, so the candidate `anchorOffsetY` is `10` in a 208-pixel cell.

## Identity contract

- Breed: Ragdoll
- Family: opus
- Neutral upright `stand` pose
- Silver-gray tabby markings, pale cream chest and belly
- Large blue eyes where visible
- Purple collar and purple flower pendant
- Front / exact left profile / back share one scale and baseline

The versioned source anchor is `../../source/three-cats-character-sheet.png`. The Ragdoll is the silver-gray cat in the center panels. The source was copied from the previously gitignored upload location so this candidate does not depend on runtime uploads for reproducibility.

## Generation provenance

Generator: built-in OpenAI image generation tool, identity-preserving generation followed by a background-extraction edit.

Initial prompt:

> Create one clean orthographic turnaround strip containing exactly three full-body views of the same Ragdoll cat: front, exact left profile, and back. Use only the silver-gray Ragdoll in the center panels of the reference sheet. Preserve the fluffy compact body, pale cream chest and belly, silver-gray tabby markings, huge round blue eyes where visible, pink inner ears and nose, purple collar, and purple flower pendant. Use one neutral upright standing pose, identical apparent height and head size, one shared baseline, 2D hand-drawn anime styling, flat cel shading, clean dark outlines, and no perspective. Include no text, grid, floor, shadow, props, scenery, extra cats, duplicate limbs, or cropped anatomy.

Transparency correction:

> Remove only the baked checkerboard background and replace it with genuine transparent alpha. Preserve all three figures, views, poses, proportions, markings, accessories, spacing, and anatomy.

Deterministic processing: `ffmpeg` fixed-panel crop → aspect-preserving scale → transparent pad to 192×208 → horizontal contact sheet. No generative changes were made during cell processing.

## Gate checklist

- [x] PNG RGBA with real alpha
- [x] Exactly three complete views
- [x] One scale and one baseline
- [x] 192×208 consumer cells
- [x] 59×64-per-view readability preview
- [x] Operator: “this is our Ragdoll / 宪宪”
- [x] Operator: front, side, and back read as one character
- [x] Operator: approve as the identity basis for later actions and expressions
