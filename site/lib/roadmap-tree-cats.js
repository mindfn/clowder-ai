/* Clowder AI — Roadmap Tree: the three cats and their scaffolds
 *
 * Cats are vector drawings (no bitmap atlas) so they stay crisp at any zoom and
 * match the site palette. Choreography is a pure function of (chapter, t) so
 * scrolling back and forth replays the same scene.
 */
(function attachRoadmapTreeCats(global) {
  const NS = 'http://www.w3.org/2000/svg';
  const geo = global.ClowderRoadmapGeometry;
  const V = geo.VIEW;
  const fmt = (n) => Math.round(n * 10) / 10;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const seg = (t, a, b) => geo.clamp01((t - a) / (b - a));

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function drawCat(cat, parent) {
    const g = el('g', { class: `rt-cat rt-cat--${cat.id}`, 'data-id': cat.id }, parent);
    const body = el('g', { class: 'rt-cat-body' }, g);
    el('path', { d: 'M-24 -20 C-44 -24 -48 -46 -34 -58', class: 'rt-cat-tail', stroke: cat.point }, body);
    el(
      'rect',
      { x: -22, y: -16, width: 9, height: 17, rx: 4, fill: cat.fur, class: 'rt-cat-leg rt-cat-leg--back' },
      body,
    );
    el(
      'rect',
      { x: -10, y: -16, width: 9, height: 17, rx: 4, fill: cat.point, class: 'rt-cat-leg rt-cat-leg--back' },
      body,
    );
    el('ellipse', { cx: -4, cy: -26, rx: 26, ry: 17, fill: cat.fur }, body);
    if (cat.id !== 'ragdoll') {
      for (const x of [-14, -4, 6])
        el('path', { d: `M${x} -40 q 2 6 0 12`, stroke: cat.point, class: 'rt-cat-stripe' }, body);
    }
    el(
      'rect',
      { x: 6, y: -16, width: 9, height: 17, rx: 4, fill: cat.point, class: 'rt-cat-leg rt-cat-leg--front' },
      body,
    );
    const arm = el('g', { class: 'rt-cat-arm' }, body);
    el('rect', { x: 14, y: -18, width: 9, height: 19, rx: 4, fill: cat.fur }, arm);
    const plank = el('rect', { x: -30, y: -50, width: 56, height: 6, rx: 2, class: 'rt-cat-plank' }, body);
    const head = el('g', { class: 'rt-cat-head' }, body);
    el('path', { d: 'M8 -52 L4 -70 L18 -58 Z', fill: cat.point }, head);
    el('path', { d: 'M30 -52 L38 -70 L24 -58 Z', fill: cat.point }, head);
    el('circle', { cx: 20, cy: -46, r: 16, fill: cat.fur }, head);
    if (cat.id === 'ragdoll')
      el('path', { d: 'M6 -50 C 10 -60 30 -60 34 -50 C 30 -46 10 -46 6 -50 Z', fill: cat.point, opacity: 0.55 }, head);
    el('ellipse', { cx: 15, cy: -48, rx: 2.2, ry: 3, class: 'rt-cat-eye' }, head);
    el('ellipse', { cx: 27, cy: -48, rx: 2.2, ry: 3, class: 'rt-cat-eye' }, head);
    el('path', { d: 'M21 -42 l-2 2 l4 0 Z', class: 'rt-cat-nose' }, head);
    el('path', { d: 'M30 -42 l10 -2 M30 -40 l10 2 M12 -42 l-10 -2 M12 -40 l-10 2', class: 'rt-cat-whisker' }, head);
    el('path', { d: 'M8 -36 Q 20 -28 32 -36', stroke: cat.collar, class: 'rt-cat-collar' }, head);
    return { el: g, plank };
  }

  function drawScaffold(spec, parent) {
    const g = el('g', { class: 'rt-scaffold', 'data-branch': spec.branch }, parent);
    const x0 = spec.x - spec.half;
    const x1 = spec.x + spec.half;
    const levels = [];
    for (let i = 0; i < spec.levels; i += 1) {
      const y = V.ground - (i + 1) * spec.step;
      const level = el('g', { class: 'rt-scaffold-level' }, g);
      el('line', { x1: x0, y1: y + spec.step, x2: x0, y2: y, class: 'rt-post' }, level);
      el('line', { x1: x1, y1: y + spec.step, x2: x1, y2: y, class: 'rt-post' }, level);
      el('line', { x1: x0, y1: y + spec.step, x2: x1, y2: y, class: 'rt-brace' }, level);
      el('rect', { x: x0 - 8, y: y - 3, width: spec.half * 2 + 16, height: 6, rx: 2, class: 'rt-plank' }, level);
      level.style.transformOrigin = `${fmt(spec.x)}px ${fmt(y + spec.step)}px`;
      levels.push(level);
    }
    const ladderX = spec.side > 0 ? x0 - 22 : x1 + 22;
    const ladder = el('g', { class: 'rt-ladder' }, g);
    el('line', { x1: ladderX - 6, y1: V.ground, x2: ladderX - 6, y2: spec.top, class: 'rt-post' }, ladder);
    el('line', { x1: ladderX + 6, y1: V.ground, x2: ladderX + 6, y2: spec.top, class: 'rt-post' }, ladder);
    for (let y = V.ground - 14; y > spec.top; y -= 16)
      el('line', { x1: ladderX - 6, y1: y, x2: ladderX + 6, y2: y, class: 'rt-rung' }, ladder);
    g.style.display = 'none';
    return { el: g, levels, ladder, spec };
  }

  function scaffoldSpecFor(node) {
    const q = geo.pointAt(node.pts, 0.58);
    const top = q.y + 34;
    const step = 64;
    const levels = Math.max(2, Math.round((V.ground - top) / step));
    return {
      branch: node.data.id,
      x: q.x,
      top: V.ground - levels * step,
      half: 46,
      step,
      levels,
      side: node.side,
      fruitY: q.y,
    };
  }

  function mount(catsLayer, scaffoldLayer, data, tree) {
    const cats = data.cats.map((c) => ({ ...c, ...drawCat(c, catsLayer) }));
    const branches = tree.nodes.filter((n) => n.kind === 'L1');
    const scaffolds = branches.map((n) => drawScaffold(scaffoldSpecFor(n), scaffoldLayer));

    const REST = [
      { x: V.cx - 90, dir: 1, pose: 'sit' },
      { x: V.cx + 96, dir: -1, pose: 'sit' },
      { x: V.cx - 180, dir: 1, pose: 'sit' },
    ];
    const OFFSTAGE = [
      { x: -80, dir: 1 },
      { x: V.w + 80, dir: -1 },
      { x: -140, dir: 1 },
    ];

    function seedScene(t) {
      return cats.map((_, i) => {
        const from = OFFSTAGE[i];
        const to = [V.cx - 70, V.cx + 70, V.cx - 150][i];
        const walk = ease(seg(t, 0.02 + i * 0.05, 0.42 + i * 0.05));
        const x = geo.lerp(from.x, to, walk);
        if (walk < 1) return { x, y: V.ground, dir: from.dir, pose: 'walk' };
        if (i === 0 && t < 0.62) return { x, y: V.ground, dir: 1, pose: 'dig' };
        return { x, y: V.ground, dir: i === 1 ? -1 : 1, pose: t > 0.62 ? 'sit' : 'stand' };
      });
    }

    function restScene(t, lookUp) {
      return cats.map((_, i) => ({
        x: REST[i].x,
        y: V.ground,
        dir: REST[i].dir,
        pose: lookUp && t > 0.3 ? 'look' : 'sit',
      }));
    }

    function branchScene(index, t, prev) {
      const sc = scaffolds[index];
      const spec = sc.spec;
      const inner = spec.x - spec.side * (spec.half + 60);
      const arrive = [
        { x: spec.x - spec.side * 20, dir: spec.side },
        { x: inner, dir: spec.side },
        { x: spec.x + spec.side * (spec.half + 40), dir: -spec.side },
      ];
      return cats.map((_, i) => {
        const p = prev[i];
        const walk = ease(seg(t, 0.02 + i * 0.06, 0.3 + i * 0.06));
        const x = geo.lerp(p.x, arrive[i].x, walk);
        if (walk < 1) return { x, y: V.ground, dir: arrive[i].x > p.x ? 1 : -1, pose: 'carry' };
        if (t < 0.62) return { x, y: V.ground, dir: arrive[i].dir, pose: i === 2 ? 'stand' : 'build' };
        const climb = ease(seg(t, 0.62, 0.86));
        if (i === 0) {
          const y = geo.lerp(V.ground, spec.top, climb);
          return { x: spec.x - spec.side * 12, y, dir: spec.side, pose: climb < 1 ? 'climb' : 'reach' };
        }
        if (i === 1) {
          const y = geo.lerp(V.ground, V.ground - spec.step * Math.max(1, spec.levels - 1), climb);
          return { x: spec.x + spec.side * 14, y, dir: -spec.side, pose: climb < 1 ? 'climb' : 'look' };
        }
        return { x, y: V.ground, dir: spec.side, pose: 'look' };
      });
    }

    function sceneFor(chapter, t, prev) {
      if (chapter === 0) return seedScene(t);
      if (chapter === 1) return restScene(t, false);
      if (chapter === 2) return restScene(t, true);
      if (chapter >= 3 && chapter <= 6) return branchScene(chapter - 3, t, prev);
      if (chapter === 7) return restScene(t, true);
      return cats.map((_, i) => ({ ...REST[i], y: V.ground, pose: i === 2 && t > 0.4 ? 'wave' : 'sit' }));
    }

    function endOf(chapter) {
      if (chapter < 0) return OFFSTAGE.map((o) => ({ ...o, y: V.ground, pose: 'walk' }));
      return sceneFor(chapter, 1, endOf(chapter - 1));
    }

    const POSES = ['walk', 'carry', 'dig', 'stand', 'sit', 'look', 'build', 'climb', 'reach', 'wave'];

    function applyCat(cat, s) {
      cat.el.setAttribute('transform', `translate(${fmt(s.x)} ${fmt(s.y)}) scale(${s.dir} 1)`);
      for (const p of POSES) cat.el.classList.toggle(`is-${p}`, s.pose === p);
    }

    function applyScaffold(index, chapter, t) {
      scaffolds.forEach((sc, i) => {
        const active = i === index;
        const done = i < index || (chapter > 6 && i <= 3);
        let p = 0;
        if (active) p = seg(t, 0.18, 0.66);
        else if (done) p = 1;
        const fade = chapter >= 7 ? 1 - seg(chapter - 7 + t, 0.1, 0.5) : 1;
        sc.el.style.display = p > 0 && fade > 0 ? '' : 'none';
        sc.el.style.opacity = fade.toFixed(2);
        const n = sc.levels.length;
        sc.levels.forEach((level, j) => {
          const local = geo.clamp01(p * n - j);
          level.style.display = local > 0 ? '' : 'none';
          level.style.transform = `scaleY(${ease(local).toFixed(3)})`;
        });
        sc.ladder.style.display = p > 0.5 ? '' : 'none';
      });
    }

    let pokedFruit = null;
    function pokeFruit(index, chapter, t) {
      const spec = index >= 0 ? scaffolds[index].spec : null;
      const want = spec && chapter >= 3 && chapter <= 6 && t > 0.86;
      if (!want) {
        if (pokedFruit) pokedFruit.classList.remove('is-poked');
        pokedFruit = null;
        return;
      }
      if (pokedFruit) return;
      const ripe = tree.fruits.filter((f) => f.branch === spec.branch && f.status === 'ripe');
      const pool = ripe.length ? ripe : tree.fruits.filter((f) => f.branch === spec.branch);
      const nearest = pool.reduce(
        (best, f) =>
          Math.hypot(f.x - spec.x, f.y - spec.top) < Math.hypot(best.x - spec.x, best.y - spec.top) ? f : best,
        pool[0],
      );
      pokedFruit = nearest.el.parentNode;
      pokedFruit.classList.add('is-poked');
    }

    function update(scene) {
      const { chapter, t } = scene;
      const prev = endOf(chapter - 1);
      const states = sceneFor(chapter, t, prev);
      cats.forEach((cat, i) => {
        applyCat(cat, states[i]);
      });
      const idx = chapter >= 3 && chapter <= 6 ? chapter - 3 : -1;
      applyScaffold(idx, chapter, t);
      pokeFruit(idx, chapter, t);
    }

    return { update, cats, scaffolds };
  }

  global.ClowderRoadmapCats = { mount, scaffoldSpecFor };
})(typeof window !== 'undefined' ? window : globalThis);
