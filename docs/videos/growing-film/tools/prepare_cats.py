"""Cut the canon cats into film sprites that keep the canon's scale and footing.

The character canon (feat/roadmap-growing-tree @ a44356872) ships two things per pose:
a 192x208 runtime cell in dist/ whose scale and baseline are canon, and one or more
high-resolution masters from which the cell was made. The film needs the masters'
resolution but the cells' geometry, so for every pose we find the master that
reproduces the cell, and carry the cell's scale and foot point over to the master.

Output: build/cats/<cat>-<pose>[-<frame>].png plus build/cats/manifest.json holding,
per sprite, its pixel size and the foot anchor (where the canon baseline and cell
centre land inside the sprite).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

CATS = ("ragdoll", "maine", "siamese")
CELL_W, CELL_H = 192, 208
BASE_Y = 197  # lowest opaque row of a standing cell: the canon baseline
UPSCALE = 3.0  # film sprite pixels per canon cell pixel


def bbox(alpha: np.ndarray, thresh: int = 24, min_count: int = 1):
    """Bounding box of opaque pixels; rows/columns with fewer than min_count opaque
    pixels are treated as specks so stray dust cannot stretch the box."""
    m = alpha > thresh
    cols = np.nonzero(m.sum(axis=0) >= min_count)[0]
    rows = np.nonzero(m.sum(axis=1) >= min_count)[0]
    if len(cols) == 0 or len(rows) == 0:
        return None
    return cols.min(), rows.min(), cols.max() + 1, rows.max() + 1


def candidates(canon: Path, cat: str, pose: str) -> list[Path]:
    found = []
    for p in canon.rglob(f"{cat}-{pose}-master.png"):
        found.append(p)
    return sorted(set(found))


def place_error(master: Image.Image, cell: Image.Image, s: float, ox: float, oy: float) -> float:
    """Render the master into cell space at (s, ox, oy) and compare with the cell."""
    w, h = master.size
    scaled = master.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BILINEAR)
    canvas = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    canvas.alpha_composite(scaled, (int(round(ox)), int(round(oy))))
    a = np.asarray(canvas).astype(np.float32) / 255.0
    b = np.asarray(cell).astype(np.float32) / 255.0
    pa, pb = a[..., :3] * a[..., 3:], b[..., :3] * b[..., 3:]
    return float(np.abs(pa - pb).mean() + np.abs(a[..., 3] - b[..., 3]).mean())


def fit_master(master: Image.Image, cell: Image.Image):
    """Map a master onto a cell: robust bounding boxes give a first guess, then a small
    search over scale and offset minimises the rendered difference.
    Returns (scale, offset_x, offset_y, error)."""
    ma = np.asarray(master.getchannel("A"))
    ca = np.asarray(cell.getchannel("A"))
    mb, cb = bbox(ma, 128, 4), bbox(ca, 128, 2)
    if mb is None or cb is None:
        return None
    mh, ch = mb[3] - mb[1], cb[3] - cb[1]
    best = None
    for ds in np.linspace(0.9, 1.1, 11):
        s = ch / mh * ds
        # align bottoms and horizontal centres, then jitter
        bx = (cb[0] + cb[2]) / 2 - s * (mb[0] + mb[2]) / 2
        by = cb[3] - s * mb[3]
        for jx in (-3, 0, 3):
            for jy in (-3, 0, 3):
                e = place_error(master, cell, s, bx + jx, by + jy)
                if best is None or e < best[3]:
                    best = (s, bx + jx, by + jy, e)
    s0, x0, y0, _ = best
    for ds in np.linspace(0.985, 1.015, 5):
        for jx in (-1, 0, 1):
            for jy in (-1, 0, 1):
                s = s0 * ds
                e = place_error(master, cell, s, x0 + jx, y0 + jy)
                if e < best[3]:
                    best = (s, x0 + jx, y0 + jy, e)
    return best


def export(master: Image.Image, s: float, ox: float, oy: float, out: Path, anchor_cell):
    k = s * UPSCALE
    w, h = master.size
    big = master.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    a = np.asarray(big.getchannel("A"))
    b = bbox(a, 4)
    pad = 6
    x0, y0 = max(0, b[0] - pad), max(0, b[1] - pad)
    x1, y1 = min(big.width, b[2] + pad), min(big.height, b[3] + pad)
    crop = big.crop((x0, y0, x1, y1))
    crop.save(out)
    # anchor: canon cell point -> master px -> film sprite px
    ax_m = (anchor_cell[0] - ox) / s
    ay_m = (anchor_cell[1] - oy) / s
    return {
        "w": crop.width,
        "h": crop.height,
        "ax": round(ax_m * k - x0, 2),
        "ay": round(ay_m * k - y0, 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--canon",
        default="/Users/lang/workspace/github-lab/clowder-ai-roadmap-growing-tree/docs/design/assets/character-canon",
    )
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "build" / "cats"))
    args = ap.parse_args()
    canon, out = Path(args.canon), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dist = canon / "dist"
    manifest: dict = {"upscale": UPSCALE, "cell": [CELL_W, CELL_H], "baseline": BASE_Y, "sprites": {}}
    report = []
    for cat in CATS:
        for row in sorted(dist.glob(f"{cat}-*-row.png")):
            pose = row.name[len(cat) + 1 : -len("-row.png")]
            strip = Image.open(row).convert("RGBA")
            frames = strip.width // CELL_W
            meta_path = dist / f"{cat}-{pose}.json"
            contact = json.loads(meta_path.read_text()).get("contact") if meta_path.exists() else None
            for f in range(frames):
                cell = strip.crop((f * CELL_W, 0, (f + 1) * CELL_W, CELL_H))
                if frames > 1:
                    pool = sorted(canon.rglob(f"{cat}-frame-{f + 1}.png"))
                else:
                    pool = candidates(canon, cat, pose)
                best = None
                for p in pool:
                    m = Image.open(p).convert("RGBA")
                    if m.height < 2 * CELL_H:
                        continue  # a cell-sized copy is not a master; it would only blur
                    fit = fit_master(m, cell)
                    if fit and (best is None or fit[3] < best[1][3]):
                        best = (p, fit, m)
                name = f"{cat}-{pose}" + (f"-{f + 1}" if frames > 1 else "")
                if best is None:
                    # no master: fall back to the cell itself, upscaled
                    m = cell
                    fit = (1.0, 0.0, 0.0, 0.0)
                    src = str(row.relative_to(canon)) + f"#{f}"
                else:
                    p, fit, m = best
                    src = str(p.relative_to(canon))
                info = export(m, fit[0], fit[1], fit[2], out / f"{name}.png", (CELL_W / 2, BASE_Y))
                info.update({"source": src, "fitError": round(fit[3], 4)})
                if contact:
                    info["contact"] = contact
                manifest["sprites"][name] = info
                report.append((name, round(fit[3], 4), src))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    for r in sorted(report, key=lambda r: -r[1])[:12]:
        print("worst fits:", r)
    print(len(manifest["sprites"]), "sprites ->", out)


if __name__ == "__main__":
    main()
