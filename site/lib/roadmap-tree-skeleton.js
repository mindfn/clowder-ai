/* Clowder AI — Roadmap Tree: skeleton composition
 *
 * Turns the logical tree (roadmap-tree-data.js) into a botanical skeleton using
 * the primitives in roadmap-tree-geometry.js. Everything derives from a seeded
 * PRNG, so the same data always grows the same tree; adding a node grows one more
 * twig, not a new tree.
 *
 * Growth timeline (G, in "chapters"):
 *   0 seed · 1 roots · 2 trunk · 3–6 one chapter per branch · 7 crown · 8 panorama
 */
(function attachRoadmapTreeSkeleton(global) {
  const geo = global.ClowderRoadmapGeometry;
  const { VIEW, DEG, mulberry32, curve, pointAt, bboxOf, sprinkle } = geo;

  function build(data, seed) {
    const rng = mulberry32(seed || 20260902);
    const nodes = [];
    const leaves = [];
    const fruits = [];
    const push = (node) => {
      nodes.push(node);
      return node;
    };

    // Trunk: base → leader tip, slight S curve. Grows in chapter 2.
    const trunkLen = VIEW.ground - 440;
    const trunk = curve(rng, { x: VIEW.cx, y: VIEW.ground }, -90 * DEG, trunkLen, {
      steps: 10,
      w0: 66,
      w1: 26,
      bendTo: -90 * DEG,
      bend: 0.6,
      jitter: 5,
    });
    push({ id: 'trunk', kind: 'trunk', pts: trunk.pts, g0: 2.0, g1: 2.85 });

    // Seedling: the very first shoot (chapter 0).
    push({
      id: 'seedling',
      kind: 'seedling',
      pts: [
        { x: VIEW.cx, y: VIEW.ground, w: 5 },
        { x: VIEW.cx - 4, y: VIEW.ground - 34, w: 3 },
        { x: VIEW.cx + 6, y: VIEW.ground - 62, w: 2 },
      ],
      g0: 0.62,
      g1: 0.98,
    });

    // Roots: fan downward, each with rootlets. Chapter 1.
    const rootAngles = [128, 152, 28, 52];
    data.roots.forEach((root, i) => {
      const a = rootAngles[i % rootAngles.length] * DEG;
      const from = { x: VIEW.cx + Math.cos(a) * 14, y: VIEW.ground + 6 };
      const c = curve(rng, from, a, 200 + rng() * 40, {
        steps: 6,
        w0: 22,
        w1: 5,
        bendTo: 90 * DEG,
        bend: 0.25,
        jitter: 14,
      });
      const node = push({
        id: `root-${root.id}`,
        kind: 'root',
        data: root,
        pts: c.pts,
        g0: 1.05 + i * 0.08,
        g1: 1.6 + i * 0.08,
      });
      [0.42, 0.7, 0.92].forEach((k, j) => {
        const p = pointAt(c.pts, k);
        const side = j % 2 === 0 ? 1 : -1;
        const sub = curve(rng, p, p.angle + side * 40 * DEG, 60 + rng() * 30, {
          steps: 4,
          w0: p.w * 0.55,
          w1: 2,
          bendTo: 90 * DEG,
          bend: 0.3,
          jitter: 16,
        });
        push({
          id: `${node.id}-${j}`,
          kind: 'rootlet',
          parent: node.id,
          pts: sub.pts,
          g0: node.g0 + 0.3 + j * 0.12,
          g1: node.g1 + 0.35 + j * 0.1,
          item: root.items[j],
        });
      });
    });

    // Branches: four limbs leaving the trunk at rising heights, alternating sides.
    const attachK = [0.3, 0.5, 0.7, 0.86];
    data.branches.forEach((branch, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const base = pointAt(trunk.pts, attachK[i]);
      const from = { x: base.x + side * base.w * 0.35, y: base.y };
      const g = 3 + i;
      const angle = (-90 + side * (60 - i * 9)) * DEG;
      const c = curve(rng, from, angle, 270 + rng() * 50, {
        steps: 7,
        w0: base.w * 0.62,
        w1: 10,
        bendTo: -90 * DEG,
        bend: 0.3,
        jitter: 8,
      });
      const l1 = push({
        id: `b-${branch.id}`,
        kind: 'L1',
        data: branch,
        color: branch.color,
        side,
        pts: c.pts,
        tip: pointAt(c.pts, 1),
        g0: g,
        g1: g + 0.4,
      });
      const limbK = [0.42, 0.7, 0.98];
      branch.limbs.forEach((limb, j) => {
        const p = pointAt(c.pts, limbK[j]);
        const turn = j === 2 ? 0 : (j % 2 === 0 ? -1 : 1) * side * 38;
        const sub = curve(rng, p, p.angle + turn * DEG, 120 + rng() * 30, {
          steps: 5,
          w0: p.w * 0.6,
          w1: 4,
          bendTo: -90 * DEG,
          bend: 0.25,
          jitter: 12,
        });
        const l2 = push({
          id: `${l1.id}-${j}`,
          kind: 'L2',
          parent: l1.id,
          data: limb,
          color: branch.color,
          side,
          pts: sub.pts,
          g0: g + 0.28 + j * 0.06,
          g1: g + 0.6 + j * 0.05,
        });
        const twigK = [0.45, 0.78, 1];
        limb.fruits.forEach((fruit, k) => {
          const q = pointAt(sub.pts, twigK[k]);
          const tturn = k === 2 ? 0 : (k % 2 === 0 ? 1 : -1) * 34;
          const tw = curve(rng, q, q.angle + tturn * DEG, 52 + rng() * 22, {
            steps: 3,
            w0: Math.max(3, q.w * 0.55),
            w1: 2,
            bendTo: -90 * DEG,
            bend: 0.15,
            jitter: 14,
          });
          const l3 = push({
            id: `${l2.id}-${k}`,
            kind: 'L3',
            parent: l2.id,
            data: fruit,
            color: branch.color,
            pts: tw.pts,
            g0: g + 0.52 + j * 0.05 + k * 0.03,
            g1: g + 0.76 + j * 0.04 + k * 0.03,
          });
          const tip = tw.pts[tw.pts.length - 1];
          fruits.push({
            id: `${l3.id}-fruit`,
            node: l3.id,
            branch: branch.id,
            limb: j,
            index: k,
            x: tip.x + 2,
            y: tip.y + 12,
            r: 11 + rng() * 3,
            status: fruit.status,
            label: fruit.label,
            color: branch.color,
            g0: l3.g1,
            g1: l3.g1 + 0.18,
            phase: rng(),
          });
          sprinkle(rng, leaves, l3.id, tw.pts, {
            count: 4,
            from: 0.25,
            step: 0.25,
            spread: 55,
            jitter: 30,
            size: 18,
            sizeJitter: 10,
            color: branch.color,
            g0: l3.g0 + 0.12,
            g1: l3.g1 + 0.1,
          });
        });
        sprinkle(rng, leaves, l2.id, sub.pts, {
          count: 6,
          from: 0.12,
          step: 0.16,
          spread: 60,
          jitter: 30,
          size: 20,
          sizeJitter: 10,
          color: branch.color,
          g0: l2.g0 + 0.15,
          g1: l2.g1 + 0.12,
        });
      });
      sprinkle(rng, leaves, l1.id, c.pts, {
        count: 5,
        from: 0.5,
        step: 0.11,
        spread: 65,
        jitter: 25,
        size: 22,
        sizeJitter: 8,
        color: branch.color,
        g0: l1.g0 + 0.25,
        g1: l1.g1 + 0.2,
      });
      const all = nodes.filter((n) => n.id === l1.id || n.parent?.startsWith(l1.id));
      l1.bbox = bboxOf(all.flatMap((n) => n.pts).concat(fruits.filter((fr) => fr.branch === branch.id)));
    });

    // Crown: leader continues, outcomes fan out above the tip.
    const top = trunk.pts[trunk.pts.length - 1];
    const crown = [];
    data.crown.forEach((outcome, i) => {
      const a = (-90 + (i - 2) * 44) * DEG;
      const c = curve(rng, top, a, 170 + rng() * 40, {
        steps: 4,
        w0: 10,
        w1: 3,
        bendTo: -90 * DEG,
        bend: 0.1,
        jitter: 8,
      });
      push({ id: `crown-${i}`, kind: 'crown', data: outcome, pts: c.pts, g0: 7.05 + i * 0.1, g1: 7.5 + i * 0.1 });
      const tip = c.pts[c.pts.length - 1];
      crown.push({
        id: `crown-${i}-bloom`,
        above: i % 2 === 1,
        x: tip.x,
        y: tip.y,
        label: outcome.label,
        body: outcome.body,
        g0: 7.45 + i * 0.1,
        g1: 7.85 + i * 0.1,
        phase: rng(),
      });
      for (let m = 0; m < 4; m += 1) {
        const lp = pointAt(c.pts, 0.25 + m * 0.22);
        leaves.push({
          id: `crown-${i}-leaf-${m}`,
          node: `crown-${i}`,
          x: lp.x,
          y: lp.y,
          angle: lp.angle + (m % 2 === 0 ? -1 : 1) * 70 * DEG,
          size: 15 + rng() * 6,
          color: 'crown',
          g0: 7.3 + i * 0.1,
          g1: 7.7 + i * 0.1,
          phase: rng(),
        });
      }
    });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
      view: VIEW,
      nodes,
      byId,
      leaves,
      fruits,
      crown,
      trunkTop: top,
      attach: attachK.map((k) => pointAt(trunk.pts, k)),
    };
  }

  geo.build = build;
})(typeof window !== 'undefined' ? window : globalThis);
