---
feature_ids: []
topics: [roadmap, site, illustration, asset-spec]
doc_kind: design
created: 2026-09-02
---

# Roadmap Tree — illustrated asset spec & prompt pack

> Goal: the `/roadmap.html` story stage stops being a procedural SVG tree and becomes a
> layered 2D illustration in the **house canon style** (the three-cat character sheets),
> at the visual level of pear.no's chaptered scroll — but with our own cats, our own tree.

## 0. What stays, what changes

| Layer | v1 (shipped on `feat/roadmap-growing-tree`) | v2 (this spec) |
|---|---|---|
| Logical tree + maturity | `site/lib/roadmap-tree-data.js` | unchanged (single source of truth) |
| Scroll story / chapters / rail / camera | `roadmap-tree-story.js` | unchanged; camera becomes CSS transform on a raster stage |
| Tree visuals | procedural SVG polygons | **one master painting + cut layers**, revealed by masks |
| Cats | hand-drawn vector cats | **cut from the canon character sheet** (sit / walk / stand-upright) + 3 generated poses |
| Fruit | SVG circles | generated fruit sprites (ripe / green / bud) placed by data anchors |
| Scaffold | SVG lines | generated wooden scaffold module (tileable levels) |

## 1. Canon anchors (identity, do not reinvent)

Mother sheet (operator upload, 2026-09-02, thread `品牌logo图` → `packages/api/uploads/1788338891939-0a8b6209.png`):

| Cat | Look | Collar | Poses on sheet |
|---|---|---|---|
| 缅因猫 (Maine Coon) | large grey tabby, long fur, green eyes, permanent frown, one hair tuft | none (green tea mug prop) | sit, lie, stand-upright ×2, 4 faces |
| 布偶猫 (Ragdoll kitten) | small grey-and-white, blue eyes, cheerful | purple collar with star charm | sit, walk, stand-upright ×2 (one holding notebook), 4 faces |
| 暹罗猫 (Siamese) | slim cream body, dark seal points, blue eyes, sharp | blue collar with gem charm | sit (clipboard prop), walk, stand-upright ×2 (clipboard), 4 faces |

Style: **2D hand-drawn anime illustration, soft cel shading, clean visible outlines, warm cream paper tone**. Every generated asset carries this style anchor and the relevant sheet as reference image.

## 2. Assets to generate (one asset = one generation task; batch-review 2-2-3)

Canvas convention: master scene is **1600 × 1200 (4:3)**, tree centred, ground line at **y = 900**. All tree layers share this canvas so they overlay pixel-exact. Everything except the background plate is PNG with real alpha.

| # | Asset | Size | Content | Notes |
|---|---|---|---|---|
| A1 | `bg-sky-meadow.png` | 1600×1200 | soft gradient sky, gentle meadow ground with a low grass band at y≈900, no tree | light mode; dark mode = CSS overlay |
| A2 | `tree-wood.png` | 1600×1200, alpha | the full **bare** tree: thick trunk, four main limbs (lower-left, lower-right, upper-left, upper-right), fine twigs, roots hidden below ground | this silhouette is the composition anchor for everything below |
| A3 | `tree-roots.png` | 1600×1200, alpha | underground cutaway: dark soil block from y=900 down, four main roots with rootlets, matching trunk base of A2 | shown only in chapter 1 |
| A4 | `foliage-{memory,harness,capability,life}.png` ×4 | 1600×1200, alpha | leaf mass for ONE limb each, on transparent bg, same tree as A2 | tints: memory = cool blue-green, harness = fresh green, capability = warm olive, life = golden green |
| A5 | `crown-blossoms.png` | 1600×1200, alpha | five orange-gold blossom clusters at the very top | chapter 7 |
| A6 | `fruit-{ripe,green,bud}-{memory,harness,capability,life}.png` | 256×256, alpha | single fruit sprite; ripe = full colour + glow, green = smaller pale green, bud = pink closed bud | 12 sprites; placed by data anchors |
| A7 | `scaffold-level.png` + `scaffold-top.png` + `ladder-tile.png` | 512×256 / 512×160 / 128×256, alpha | wooden scaffold module (two posts, brace, plank) that tiles vertically | same wood tone as trunk |
| A8 | cat poses not on the sheet: `{cat}-carry.png` (walking with plank on back), `{cat}-reach.png` (standing upright, one paw stretched up), `{cat}-dig.png` (crouched, paw in soil) | 1024×1024 white bg → alpha | 3 cats × 3 poses = 9 | generate ONE pose per call, sheet as reference; "Everything else IDENTICAL" phrasing |
| A9 | `seed.png`, `sprout.png` | 256×256, alpha | a single seed; a two-leaf sprout | chapter 0 |

## 3. Prompt pack (style anchor first, then subject, then negatives)

Common prefix (every prompt):

```
2D hand-drawn anime illustration style, soft cel-shaded coloring, clean visible outlines,
warm paper-cream palette, gentle daylight, no text, no watermark.
```

Common negative (every prompt):

```
3D, CGI, photorealistic, plastic, Pixar, blurry, extra limbs, text, logo, frame, border
```

### A2 tree-wood
```
A large old fruit tree WITHOUT leaves, centered on a transparent background, 4:3 canvas.
Thick textured trunk rising from the bottom center (ground line at 75% height), splitting into
four main limbs: lower-left, lower-right, upper-left, upper-right, each with smaller twigs.
Bark in warm brown with soft highlights. Slight natural asymmetry. Roots not visible.
```

### A3 tree-roots
```
Underground cutaway of the same tree: dark brown soil block filling the bottom quarter,
four thick main roots spreading down and sideways from the trunk base with fine rootlets,
lighter root color against darker soil. Transparent above the ground line.
```

### A4 foliage (run 4×, swap tint + limb)
```
Leaf canopy for ONLY the {lower-left} limb of the bare tree in the reference image,
transparent background, same canvas and position as the reference. Dense soft leaf clusters
in {cool blue-green} tint with lighter highlights, hand-drawn anime style. No other limb,
no trunk, no fruit.
```

### A6 fruit (run 12×)
```
A single round fruit hanging from a short stem with one small leaf, centered on a
transparent 256×256 canvas. {ripe: glossy saturated {blue} fruit with a soft glow |
green: small pale-green unripe fruit | bud: closed pink flower bud with green sepals}.
```

### A8 cat pose (run 9×, ONE pose per call, sheet as reference image)
```
The exact same {Siamese cat} from the reference sheet — same face, same fur pattern, same
{blue collar with gem charm} — now {standing upright on hind legs, stretching one front paw
straight up as if reaching for a fruit above}, full body, side view facing right, pure white
background. Only the pose changes; everything else IDENTICAL to the reference.
```

## 4. Compositing contract (engine side, owned by 布偶猫)

- Stage = `div.rt-stage` with a 1600×1200 canvas box scaled to fit; camera = CSS `transform: translate/scale` on the canvas box (replaces SVG viewBox tweening).
- Growth reveal: A2 trunk revealed with a bottom-up `clip-path: inset()`; each limb's wood + foliage revealed with a circular `clip-path` centred at the limb base whose radius follows the same `g0/g1` windows the SVG used; fruits scale in at their anchors.
- Fruit anchors: 36 normalised `(x, y)` points in `roadmap-tree-data.js` per fruit (`anchor: [0.31, 0.42]`), hand-placed once against A4 so fruit sit on real leaf mass.
- Wind: foliage layers get slow `rotate(±0.4deg)` around their limb base; fruit sprites `rotate(±3deg)` around their stem; cats `translateY` bob when walking.
- Cats: sheet cut-outs are the runtime sprites (sit / walk / stand); walk cycle = two-frame flip (walk + sit-to-walk) unless a video-extracted row exists in `visible-cafe/skins`.
- Reduced motion, keyboard rail, bilingual copy, explorer cards: unchanged from v1.

## 5. Acceptance (三道闸 + identity veto)

1. First question per asset: **"这是不是我们家那只猫 / 那棵树"** — operator veto beats any checklist.
2. Layer registration: A2/A3/A4/A5 overlay pixel-exact at 1600×1200 (checked by flipping layers in the browser).
3. Real-size check: fruit sprites legible at 28 px; cats legible at 96 px on the 390-wide mobile stage.
