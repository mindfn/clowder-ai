/* Clowder AI — Roadmap Tree: bind foliage to the painted tree
 *
 * The procedural skeleton (roadmap-tree-skeleton.js) decides *what* grows and
 * *when* — one fruit per roadmap item, on the chapter timeline. The painted
 * artwork decides *where* the branches actually are. This module moves each
 * limb's fruit and leaves onto that limb's real twig tips (extracted offline by
 * site/tools/extract-tree-anchors.mjs), so nothing floats off the wood.
 *
 * It only rewrites positions: status, labels and growth timings are untouched.
 */
(function attachRoadmapTreeCanopy(global) {
  const geo = global.ClowderRoadmapGeometry;
  const TIP_LEAVES = 7; // leaves clustered at a twig end
  const SPRIG_LEAVES = 5; // leaves flanking a mid-twig anchor

  /** Greedy farthest-point sampling: `count` tips that stay as far apart as possible. */
  function spread(tips, count) {
    if (tips.length <= count) return tips.slice();
    const picked = [tips[0]];
    while (picked.length < count) {
      let best = null;
      for (const tip of tips) {
        if (picked.includes(tip)) continue;
        const near = Math.min(...picked.map((p) => Math.hypot(p.x - tip.x, p.y - tip.y)));
        if (!best || near > best.near) best = { tip, near };
      }
      picked.push(best.tip);
    }
    return picked;
  }

  /**
   * @param tree     skeleton from geo.build()
   * @param anchors  tree-anchors.json
   * @param toView   (imgX, imgY) => ({ x, y }) placement of the artwork in the viewBox
   */
  function bindToPainted(tree, anchors, toView) {
    const rng = geo.mulberry32(0x5eed7ee);
    const scale = () => {
      const a = toView(0, 0);
      const b = toView(100, 0);
      return (b.x - a.x) / 100;
    };
    const s = scale();
    for (const limb of anchors.limbs) {
      const tips = limb.tips.map((t) => ({ ...toView(t.x, t.y), ux: t.ux, uy: t.uy, d: t.d }));
      if (!tips.length) continue;
      const l1 = tree.nodes.find((n) => n.kind === 'L1' && n.data.id === limb.id);
      if (!l1) continue;
      const seed = toView(limb.seed[0], limb.seed[1]);
      l1.pivot = seed;
      const outer = tips[0];
      l1.tip = { x: outer.x, y: outer.y, angle: Math.atan2(outer.uy, outer.ux) };
      // The chapter camera and the cats' scaffold both follow the painted limb, not the skeleton.
      l1.bbox = geo.bboxOf(tips);
      const low = tips.reduce((a, b) => (a.y >= b.y ? a : b));
      l1.rasterAnchor = { x: tips.reduce((sum, t) => sum + t.x, 0) / tips.length, y: low.y };

      const fruits = tree.fruits.filter((f) => f.branch === limb.id);
      const hosts = spread(tips, fruits.length);
      fruits.forEach((fruit, i) => {
        const tip = hosts[i % hosts.length];
        // Painted twigs are far finer than the procedural ones, so the fruit shrinks to match.
        fruit.r *= 0.7;
        fruit.x = tip.x + tip.ux * 6 * s;
        fruit.y = tip.y + tip.uy * 6 * s + fruit.r * 0.9;
      });

      // A bare limb with one leaf per twig reads as a sapling. Every twig tip *and* every
      // mid-twig anchor carries a small cluster, so the limb fills out into a canopy.
      const sprigs = (limb.sprigs || []).map((p) => ({ ...toView(p.x, p.y), ux: p.nx, uy: p.ny, sprig: true }));
      const spots = tips.concat(sprigs);
      const template = tree.leaves.filter((l) => l.node === l1.id || l.node.startsWith(`${l1.id}-`));
      const leaves = [];
      spots.forEach((spot, i) => {
        const src0 = template[(i * 5) % template.length];
        leaves.push({
          ...src0,
          id: `${src0.id}-clump${i}`,
          clump: true,
          x: spot.x + spot.ux * 7 * s,
          y: spot.y + spot.uy * 7 * s,
          angle: rng() * Math.PI,
          size: (spot.sprig ? 17 : 24) + rng() * 8,
          phase: rng(),
        });
        for (let k = 0; k < (spot.sprig ? SPRIG_LEAVES : TIP_LEAVES); k += 1) {
          const src = template[(i * 7 + k * 3) % template.length];
          const used = leaves.filter((l) => !l.clump).length;
          const leaf = used < template.length ? template[used] : { ...src, id: `${src.id}-x${i}-${k}`, clump: false };
          // Tips fan outward from the twig end; sprigs sit to either side of the branch.
          const along = spot.sprig ? (k % 2 ? 1 : -1) * (3 + rng() * 13) : 2 + rng() * 12;
          const across = (rng() - 0.5) * (spot.sprig ? 12 : 20);
          leaf.x = spot.x + (spot.ux * along + -spot.uy * across) * s;
          leaf.y = spot.y + (spot.uy * along + spot.ux * across) * s;
          leaf.angle = Math.atan2(spot.uy * along, spot.ux * along) + (rng() - 0.5) * 1.8;
          leaf.size = 11 + rng() * 7;
          leaf.phase = rng();
          leaves.push(leaf);
        }
      });
      for (const leaf of leaves) if (!tree.leaves.includes(leaf)) tree.leaves.push(leaf);
      for (const leaf of template) if (!leaves.includes(leaf)) leaf.size = 0;
    }
    // Draw every soft mass first so no clump paints over a neighbour limb's leaves.
    tree.leaves.sort((a, b) => (a.clump ? 0 : 1) - (b.clump ? 0 : 1));

    // Crown blooms are outcomes, not twigs: hang them on the highest painted tips so they read
    // as the tree's own crown rather than stickers floating in the sky.
    const skyline = anchors.limbs
      .flatMap((limb) => limb.tips.map((t) => ({ ...toView(t.x, t.y), ux: t.ux, uy: t.uy })))
      .sort((a, b) => a.y - b.y)
      .slice(0, Math.max(6, tree.crown.length * 2));
    const perch = spread(skyline, tree.crown.length).sort((a, b) => a.x - b.x);
    tree.crown
      .slice()
      .sort((a, b) => a.x - b.x)
      .forEach((bloom, i) => {
        const tip = perch[i % perch.length];
        bloom.x = tip.x + tip.ux * 4 * s;
        bloom.y = tip.y + tip.uy * 4 * s;
      });
    for (const leaf of tree.leaves) {
      if (leaf.node.startsWith('crown-')) leaf.size = 0;
    }
  }

  geo.bindToPainted = bindToPainted;
})(typeof window !== 'undefined' ? window : globalThis);
