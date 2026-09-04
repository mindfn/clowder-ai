# Siamese action catalog — canon v1

Thirty-eight left-facing, one-frame action rows for Fable. The approved Ragdoll
catalog supplies the action skeleton; the three-cat character sheet supplies the
Siamese identity. Each action was generated separately, then processed by
`site/tools/prepare-character-action.mjs` into a 192×208 RGBA row with a shared
baseline. `siamese-actions-preview-59x64.png` is the complete readability check.

Consumer-owned support surfaces are absent from `climb`, `rub`, `headbutt`, and
`perch`. Each of those rows has a `{cat}-{pose}.json` sidecar in `dist/` declaring
the virtual wall or ledge contact in 192×208 cell pixels. `read` uses an open
paper book, not an electronic device, to preserve the roadmap's print-era idiom.

Identity invariants: short cream coat, dark chocolate points, large triangular
ears, fine curved tail, blue eye, and blue diamond pendant collar. These are
silhouette and marking changes, not a recolor of the Ragdoll source.
