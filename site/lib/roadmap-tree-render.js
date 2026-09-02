/* Clowder AI — Roadmap Tree: SVG renderer
 *
 * Mounts the geometry into an <svg> and exposes update(G) to grow it along the
 * chapter timeline. Wood grows via stroke-dashoffset per tapered segment; leaves
 * and fruits scale in once their twig exists; wind is CSS-driven so the browser
 * composites it without JS per frame.
 */
(function attachRoadmapTreeRender(global) {
  const NS = 'http://www.w3.org/2000/svg';
  const geo = global.ClowderRoadmapGeometry;

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  const fmt = (n) => Math.round(n * 10) / 10;

  /** Tapered outline polygon for a branch: left edge forward, right edge back. */
  function woodOutline(pts) {
    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      const h = pts[i].w / 2;
      left.push(`${fmt(pts[i].x + nx * h)} ${fmt(pts[i].y + ny * h)}`);
      right.push(`${fmt(pts[i].x - nx * h)} ${fmt(pts[i].y - ny * h)}`);
    }
    const tip = pts[pts.length - 1];
    return `M${left.join(' L')} Q${fmt(tip.x)} ${fmt(tip.y)} ${right[right.length - 1]} L${right.reverse().join(' L')} Z`;
  }

  let clipSeq = 0;
  function woodShape(node, parent, defs) {
    const base = node.pts[0];
    const tip = node.pts[node.pts.length - 1];
    const reach = Math.hypot(tip.x - base.x, tip.y - base.y) + tip.w + 4;
    clipSeq += 1;
    const id = `rt-clip-${clipSeq}`;
    const clip = el('clipPath', { id }, defs);
    node.clipCircle = el('circle', { cx: fmt(base.x), cy: fmt(base.y), r: 0 }, clip);
    node.reach = reach;
    el('path', { d: woodOutline(node.pts), class: 'rt-wood-shape', 'clip-path': `url(#${id})` }, parent);
    if (['trunk', 'L1', 'L2', 'root'].includes(node.kind)) {
      const inner = node.pts.map((p) => ({ x: p.x - p.w * 0.18, y: p.y, w: p.w * 0.28 }));
      el('path', { d: woodOutline(inner), class: 'rt-wood-hi', 'clip-path': `url(#${id})` }, parent);
    }
  }

  function leafShape(leaf, parent) {
    const s = leaf.size / 20;
    const outer = el('g', { class: `rt-leaf rt-leaf--${leaf.color}`, 'data-id': leaf.id }, parent);
    outer.style.transformOrigin = `${fmt(leaf.x)}px ${fmt(leaf.y)}px`;
    outer.style.setProperty('--ph', `${(-leaf.phase * 4).toFixed(2)}s`);
    outer.style.setProperty('--dur', `${(3.2 + leaf.phase * 2.4).toFixed(2)}s`);
    const inner = el('g', { class: 'rt-leaf-in' }, outer);
    el('path', { d: 'M0 0 C4 -7 14 -8 20 0 C14 8 4 7 0 0 Z' }, inner);
    el('path', { d: 'M1 0 L17 0', class: 'rt-vein' }, inner);
    leaf.el = inner;
    leaf.base = `translate(${fmt(leaf.x)} ${fmt(leaf.y)}) rotate(${fmt(leaf.angle * (180 / Math.PI))}) scale(${fmt(s)})`;
    return outer;
  }

  function fruitShape(fruit, parent) {
    const outer = el(
      'g',
      {
        class: `rt-fruit rt-fruit--${fruit.status} rt-fruit--${fruit.color}`,
        'data-id': fruit.id,
        'data-node': fruit.node,
        tabindex: -1,
      },
      parent,
    );
    outer.style.transformOrigin = `${fmt(fruit.x)}px ${fmt(fruit.y - fruit.r - 8)}px`;
    outer.style.setProperty('--ph', `${(-fruit.phase * 5).toFixed(2)}s`);
    outer.style.setProperty('--dur', `${(4 + fruit.phase * 3).toFixed(2)}s`);
    const inner = el('g', { class: 'rt-fruit-in' }, outer);
    el('title', {}, inner).textContent = fruit.label.en;
    el('path', { d: `M0 ${-fruit.r - 9} L0 ${-fruit.r + 2}`, class: 'rt-stem' }, inner);
    if (fruit.status === 'bud') {
      el(
        'path',
        {
          d: `M0 ${-fruit.r + 1} C ${fruit.r * 0.75} ${-fruit.r * 0.6}, ${fruit.r * 0.55} ${fruit.r * 0.5}, 0 ${fruit.r * 0.75} C ${-fruit.r * 0.55} ${fruit.r * 0.5}, ${-fruit.r * 0.75} ${-fruit.r * 0.6}, 0 ${-fruit.r + 1} Z`,
          class: 'rt-bud',
        },
        inner,
      );
      el('path', { d: `M0 ${-fruit.r + 1} L0 ${fruit.r * 0.5}`, class: 'rt-bud-seam' }, inner);
    } else {
      const r = fruit.status === 'green' ? fruit.r * 0.78 : fruit.r;
      if (fruit.status === 'ripe') el('circle', { r: r + 6, class: 'rt-glow' }, inner);
      el(
        'circle',
        { r, class: 'rt-body', fill: `url(#rt-grad-${fruit.status === 'ripe' ? fruit.color : 'green'})` },
        inner,
      );
      el('ellipse', { cx: -r * 0.35, cy: -r * 0.4, rx: r * 0.28, ry: r * 0.18, class: 'rt-shine' }, inner);
    }
    el(
      'path',
      {
        d: 'M0 -9 C 3 -14 9 -15 12 -10 C 8 -8 4 -7 0 -9 Z',
        class: 'rt-fruit-leaf',
        transform: `translate(0 ${-fruit.r})`,
      },
      inner,
    );
    fruit.el = inner;
    fruit.base = `translate(${fmt(fruit.x)} ${fmt(fruit.y)})`;
    return outer;
  }

  function bloomShape(bloom, parent) {
    const outer = el('g', { class: 'rt-bloom', 'data-id': bloom.id }, parent);
    outer.style.transformOrigin = `${fmt(bloom.x)}px ${fmt(bloom.y)}px`;
    outer.style.setProperty('--ph', `${(-bloom.phase * 5).toFixed(2)}s`);
    const inner = el('g', { class: 'rt-bloom-in' }, outer);
    el('circle', { r: 26, class: 'rt-bloom-halo' }, inner);
    for (let i = 0; i < 5; i += 1) {
      el('ellipse', { rx: 6.5, ry: 12, cy: -9, class: 'rt-petal', transform: `rotate(${i * 72})` }, inner);
    }
    el('circle', { r: 5, class: 'rt-bloom-core' }, inner);
    const text = el('text', { class: 'rt-bloom-label', y: bloom.above ? -36 : 44, 'text-anchor': 'middle' }, inner);
    bloom.textEl = text;
    bloom.el = inner;
    bloom.base = `translate(${fmt(bloom.x)} ${fmt(bloom.y)})`;
    return outer;
  }

  function pinShape(node, parent) {
    const t0 = node.tip;
    const tip = { x: t0.x + Math.cos(t0.angle) * 30, y: t0.y + Math.sin(t0.angle) * 30 };
    const dx = node.side * 18;
    const g = el('g', { class: `rt-pin rt-pin--${node.color}`, 'data-id': node.id }, parent);
    el('line', { x1: fmt(tip.x), y1: fmt(tip.y), x2: fmt(tip.x + dx), y2: fmt(tip.y - 26), class: 'rt-pin-line' }, g);
    const text = el(
      'text',
      {
        x: fmt(tip.x + dx + node.side * 6),
        y: fmt(tip.y - 30),
        'text-anchor': node.side > 0 ? 'start' : 'end',
        class: 'rt-pin-text',
      },
      g,
    );
    node.pinEl = g;
    node.pinText = text;
    return g;
  }

  function buildDefs(svg, data) {
    const defs = el('defs', {}, svg);
    const grads = [...data.branches.map((b) => b.color), 'green'];
    for (const name of grads) {
      const grad = el('radialGradient', { id: `rt-grad-${name}`, cx: '38%', cy: '35%', r: '70%' }, defs);
      el('stop', { offset: '0%', class: `rt-stop-hi rt-stop--${name}` }, grad);
      el('stop', { offset: '100%', class: `rt-stop-lo rt-stop--${name}` }, grad);
    }
    const soil = el('linearGradient', { id: 'rt-grad-soil', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', class: 'rt-soil-hi' }, soil);
    el('stop', { offset: '100%', class: 'rt-soil-lo' }, soil);
    const glow = el('filter', { id: 'rt-blur', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: 6 }, glow);
    return defs;
  }

  function mount(svg, data, opts) {
    const options = opts || {};
    const tree = geo.build(data, options.seed);
    const V = geo.VIEW;
    svg.setAttribute('viewBox', `0 0 ${V.w} ${V.h}`);
    svg.classList.add('rt-svg');
    const defs = buildDefs(svg, data);

    const layers = {};
    for (const name of ['soil', 'roots', 'ground', 'raster', 'wood', 'scaffold', 'canopy', 'crown', 'labels', 'cats']) {
      layers[name] = el('g', { class: `rt-layer rt-layer--${name}` }, svg);
    }
    el(
      'rect',
      { x: 0, y: V.ground, width: V.w, height: V.h - V.ground, fill: 'url(#rt-grad-soil)', class: 'rt-soil' },
      layers.soil,
    );
    el(
      'path',
      { d: `M0 ${V.ground} Q ${V.cx} ${V.ground - 10} ${V.w} ${V.ground}`, class: 'rt-ground-line' },
      layers.ground,
    );
    el('ellipse', { cx: V.cx, cy: V.ground + 4, rx: 150, ry: 12, class: 'rt-shadow' }, layers.ground);
    const seed = el('g', { class: 'rt-seed' }, layers.ground);
    el('ellipse', { cx: V.cx, cy: V.ground + 1, rx: 26, ry: 7, class: 'rt-mound' }, seed);
    el('ellipse', { cx: V.cx, cy: V.ground - 3, rx: 5, ry: 3.5, class: 'rt-seed-body' }, seed);
    seed.style.transformOrigin = `${V.cx}px ${V.ground}px`;
    seed.style.display = 'none';

    const branchGroups = new Map();
    for (const node of tree.nodes) {
      let host = layers.wood;
      if (node.kind === 'root' || node.kind === 'rootlet') host = layers.roots;
      if (node.kind === 'crown') host = layers.crown;
      if (node.kind === 'L1') {
        const group = el('g', { class: `rt-branch rt-branch--${node.color}`, 'data-id': node.id }, layers.canopy);
        const sway = el('g', { class: 'rt-sway' }, group);
        sway.style.transformOrigin = `${fmt(node.pts[0].x)}px ${fmt(node.pts[0].y)}px`;
        sway.style.setProperty('--ph', `${(-node.pts[0].y / 120).toFixed(2)}s`);
        const wood = el('g', { class: 'rt-branch-wood' }, sway);
        const foliage = el('g', { class: 'rt-branch-foliage' }, sway);
        branchGroups.set(node.id, { wood, foliage });
        host = wood;
      } else if (node.kind === 'L2' || node.kind === 'L3') {
        const rootId = node.id.split('-').slice(0, 2).join('-');
        host = branchGroups.get(rootId).wood;
      }
      node.group = el('g', { class: `rt-wood rt-wood--${node.kind}`, 'data-id': node.id }, host);
      woodShape(node, node.group, defs);
      node.group.style.display = 'none';
      if (node.kind === 'L1') pinShape(node, layers.labels);
    }
    for (const leaf of tree.leaves) {
      const rootId = leaf.node.split('-').slice(0, 2).join('-');
      const host = branchGroups.get(rootId)?.foliage || layers.crown;
      leafShape(leaf, host).style.display = 'none';
    }
    for (const fruit of tree.fruits) {
      const rootId = fruit.node.split('-').slice(0, 2).join('-');
      fruitShape(fruit, branchGroups.get(rootId).foliage).style.display = 'none';
    }
    for (const bloom of tree.crown) bloomShape(bloom, layers.crown).style.display = 'none';

    let lang = options.lang || 'en';
    function setLang(next) {
      lang = next;
      for (const node of tree.nodes) if (node.pinText) node.pinText.textContent = node.data.label[lang];
      for (const bloom of tree.crown) bloom.textEl.textContent = bloom.label[lang];
      for (const fruit of tree.fruits) fruit.el.querySelector('title').textContent = fruit.label[lang];
    }
    setLang(lang);

    function growWood(node, p) {
      if (node._p === p) return;
      node._p = p;
      node.group.style.display = p > 0 ? '' : 'none';
      node.clipCircle.setAttribute('r', fmt(node.reach * (1 - (1 - p) ** 2)));
      if (node.pinEl) node.pinEl.classList.toggle('is-on', p > 0.96);
    }

    function growSprout(item, p, ease) {
      if (item._p === p) return;
      item._p = p;
      const outer = item.el.parentNode;
      outer.style.display = p > 0 ? '' : 'none';
      const s = ease ? 1 - (1 - p) ** 3 : p;
      item.el.setAttribute('transform', `${item.base} scale(${fmt(s)})`);
    }

    // Illustrated-tree preview (?tree=raster): the painted wood layer replaces the SVG wood so the
    // composition can be judged in place. 1600x1200 art, trunk base sits on the ground line.
    let raster = null;
    if (options.raster) {
      svg.classList.add('rt-raster');
      const w = 1000;
      const h = (w * 1200) / 1600;
      const clip = el('clipPath', { id: 'rt-clip-raster' }, svg.querySelector('defs'));
      const circle = el('circle', { cx: V.cx, cy: V.ground, r: 0 }, clip);
      const img = el(
        'image',
        {
          href: options.raster,
          x: V.cx - w / 2,
          y: V.ground - h,
          width: w,
          height: h,
          'clip-path': 'url(#rt-clip-raster)',
          class: 'rt-raster-wood',
        },
        layers.raster,
      );
      raster = { img, circle, reach: Math.hypot(w / 2, h) + 20 };
    }

    function update(G) {
      if (raster) raster.circle.setAttribute('r', fmt(raster.reach * geo.clamp01((G - 2) / 5)));
      for (const node of tree.nodes) growWood(node, geo.progress(node, G));
      for (const leaf of tree.leaves) growSprout(leaf, geo.progress(leaf, G), true);
      for (const fruit of tree.fruits) growSprout(fruit, geo.progress(fruit, G), true);
      for (const bloom of tree.crown) growSprout(bloom, geo.progress(bloom, G), true);
      svg.classList.toggle('rt-underground', G > 0.95 && G < 2.05);
      const seedP = geo.clamp01((G - 0.48) / 0.1) * (G > 2.05 ? geo.clamp01(1 - (G - 2.05) / 0.3) : 1);
      seed.style.display = seedP > 0 ? '' : 'none';
      seed.style.transform = `scale(${fmt(seedP)})`;
      const seedling = tree.byId.get('seedling');
      seedling.group.style.opacity = G > 2.05 ? String(geo.clamp01(1 - (G - 2.05) / 0.3)) : '1';
    }

    function highlight(branchId) {
      svg.classList.toggle('rt-focus', Boolean(branchId));
      for (const [id, group] of branchGroups)
        group.wood.parentNode.parentNode.classList.toggle('is-focus', id === branchId);
    }

    return { svg, tree, layers, update, setLang, highlight };
  }

  global.ClowderRoadmapRender = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
