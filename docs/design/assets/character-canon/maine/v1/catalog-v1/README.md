# Maine Coon action catalog — canon v1

Thirty-eight left-facing, one-frame action rows for 砚砚. The approved Ragdoll
catalog supplies the action skeleton; the three-cat character sheet supplies the
Maine Coon identity. Each action was generated separately, then processed by
`site/tools/prepare-character-action.mjs` into a 192×208 RGBA row with a shared
baseline. `maine-actions-preview-59x64.png` is the complete readability check.

Consumer-owned support surfaces are absent from `climb`, `rub`, `headbutt`, and
`perch`. Each of those rows has a `{cat}-{pose}.json` sidecar in `dist/` declaring
the virtual wall or ledge contact in 192×208 cell pixels.

`ground` is the default contact for all remaining poses. In particular, `knead`
contains only the cat's alternating-paw motion; it does not bake in a cushion or
other consumer-owned support surface.

Identity invariants: big long-haired gray tabby body, broad bare ruff, ear tufts,
bushy striped tail, green eye, and no collar or neck pendant. The green tea cup
is a handheld semantic prop, never jewelry. These are identity signals, not a
Ragdoll palette swap.

Identity correction status: all 38 actions now meet this contract. The original
pendant-bearing rows were reissued from their action-specific sources; the four
contact actions retain their surface-free contact sidecars.
