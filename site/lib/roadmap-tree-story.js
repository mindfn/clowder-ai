/* Clowder AI — Roadmap Tree: scroll story engine
 *
 * Scroll position → global growth G (chapter index + local progress). The sticky
 * stage grows the tree, moves the cats, and eases the camera (viewBox) toward the
 * active chapter. Nothing hijacks scrolling; keyboard and rail navigation just
 * scroll the matching chapter into view.
 */
(function attachRoadmapTreeStory(global) {
  const geo = global.ClowderRoadmapGeometry;
  const V = geo.VIEW;
  const fmt = (n) => Math.round(n * 10) / 10;

  function cameraFor(chapter, tree, aspect) {
    let box;
    if (chapter === 0) box = { x: 250, y: 560, w: 500, h: 380 };
    else if (chapter === 1) box = { x: 190, y: 720, w: 620, h: 470 };
    else if (chapter === 2) box = { x: 180, y: 260, w: 640, h: 700 };
    else if (chapter >= 3 && chapter <= 6) {
      const node = tree.nodes.filter((n) => n.kind === 'L1')[chapter - 3];
      const b = node.bbox;
      const pad = 70;
      box = { x: b.x0 - pad, y: b.y0 - pad - 20, w: b.x1 - b.x0 + pad * 2, h: b.y1 - b.y0 + pad * 2 + 20 };
      box.h = Math.max(box.h, 420);
      box.w = Math.max(box.w, 420);
    } else if (chapter === 7) box = { x: 170, y: 90, w: 660, h: 560 };
    else box = { x: 0, y: 40, w: V.w, h: V.h - 110 };
    // Fit the stage aspect so the subject fills the viewport instead of floating.
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    if (box.w / box.h < aspect) box.w = box.h * aspect;
    else box.h = box.w / aspect;
    return { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
  }

  function init(config) {
    const { stage, svg, chapters, rail, render, cats, tree } = config;
    const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) stage.classList.add('rt-reduced');

    let G = 0;
    let camera = cameraFor(0, tree, 1);
    let target = camera;
    let rafPending = false;
    let lastChapter = -1;

    function stageAspect() {
      const r = stage.getBoundingClientRect();
      return r.height > 0 ? r.width / r.height : 1;
    }

    function measure() {
      const focus = global.innerHeight * 0.55;
      let chapter = 0;
      let t = 0;
      let found = false;
      chapters.forEach((elm, i) => {
        const r = elm.getBoundingClientRect();
        if (found) return;
        if (r.top <= focus && r.bottom > focus) {
          chapter = i;
          t = geo.clamp01((focus - r.top) / r.height);
          found = true;
        } else if (r.top > focus && i === 0) {
          chapter = 0;
          t = 0;
          found = true;
        }
      });
      if (!found) {
        chapter = chapters.length - 1;
        t = 1;
      }
      return { chapter, t };
    }

    function applyCamera() {
      svg.setAttribute('viewBox', `${fmt(camera.x)} ${fmt(camera.y)} ${fmt(camera.w)} ${fmt(camera.h)}`);
    }

    function tick() {
      rafPending = false;
      const k = reduced ? 1 : 0.11;
      const next = {
        x: geo.lerp(camera.x, target.x, k),
        y: geo.lerp(camera.y, target.y, k),
        w: geo.lerp(camera.w, target.w, k),
        h: geo.lerp(camera.h, target.h, k),
      };
      const moving = Math.abs(next.x - target.x) + Math.abs(next.y - target.y) + Math.abs(next.w - target.w) > 0.4;
      camera = moving ? next : target;
      applyCamera();
      if (moving) schedule();
    }

    function schedule() {
      if (rafPending) return;
      rafPending = true;
      global.requestAnimationFrame(tick);
    }

    function onScroll() {
      const { chapter, t } = measure();
      const gt = reduced ? (t > 0.05 ? 1 : 0) : t;
      G = Math.min(chapters.length - 0.001, chapter + gt);
      render.update(G);
      cats.update({ chapter, t: reduced ? 1 : t, G });
      if (chapter !== lastChapter) {
        lastChapter = chapter;
        target = cameraFor(chapter, tree, stageAspect());
        stage.dataset.chapter = String(chapter);
        for (const b of rail?.querySelectorAll('[data-go]') || []) {
          b.classList.toggle('is-on', Number(b.dataset.go) === chapter);
        }
        chapters.forEach((c, i) => {
          c.classList.toggle('is-active', i === chapter);
        });
        render.highlight(
          chapter >= 3 && chapter <= 6 ? tree.nodes.filter((n) => n.kind === 'L1')[chapter - 3].id : null,
        );
      }
      schedule();
    }

    function onResize() {
      target = cameraFor(lastChapter < 0 ? 0 : lastChapter, tree, stageAspect());
      camera = target;
      applyCamera();
      onScroll();
    }

    rail?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-go]');
      if (!btn) return;
      chapters[Number(btn.dataset.go)]?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });
    global.addEventListener('keydown', (ev) => {
      if (ev.target !== document.body) return;
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const next = Math.max(0, Math.min(chapters.length - 1, lastChapter + (ev.key === 'ArrowRight' ? 1 : -1)));
      chapters[next].scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });

    global.addEventListener('scroll', onScroll, { passive: true });
    global.addEventListener('resize', onResize);
    onResize();
    return {
      get G() {
        return G;
      },
      refresh: onScroll,
    };
  }

  /** Explorer: the same taxonomy as a readable, hoverable list under the story. */
  function buildExplorer(container, data, render) {
    const lang = () => (document.documentElement.lang === 'zh' ? 'zh' : 'en');
    const STATUS_TEXT = {
      ripe: { en: 'Shipped', zh: '已上线' },
      green: { en: 'Growing', zh: '生长中' },
      bud: { en: 'Planned', zh: '规划中' },
    };
    container.textContent = '';
    for (const branch of data.branches) {
      const card = document.createElement('article');
      card.className = `rt-card rt-card--${branch.color}`;
      card.dataset.branch = `b-${branch.id}`;
      const h = document.createElement('h3');
      h.className = 'rt-card-title';
      h.textContent = branch.label[lang()];
      card.appendChild(h);
      const tag = document.createElement('p');
      tag.className = 'rt-card-tag';
      tag.textContent = branch.tagline[lang()];
      card.appendChild(tag);
      for (const limb of branch.limbs) {
        const h4 = document.createElement('h4');
        h4.className = 'rt-card-limb';
        h4.textContent = limb.label[lang()];
        card.appendChild(h4);
        const ul = document.createElement('ul');
        ul.className = 'rt-card-list';
        for (const fruit of limb.fruits) {
          const li = document.createElement('li');
          li.className = `rt-card-item rt-card-item--${fruit.status}`;
          const dot = document.createElement('span');
          dot.className = 'rt-dot';
          dot.title = STATUS_TEXT[fruit.status][lang()];
          li.appendChild(dot);
          li.appendChild(document.createTextNode(fruit.label[lang()]));
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }
      card.addEventListener('pointerenter', () => render.highlight(card.dataset.branch));
      card.addEventListener('pointerleave', () => render.highlight(null));
      container.appendChild(card);
    }
    const counts = { ripe: 0, green: 0, bud: 0 };
    for (const b of data.branches) for (const l of b.limbs) for (const f of l.fruits) counts[f.status] += 1;
    return counts;
  }

  global.ClowderRoadmapStory = { init, buildExplorer, cameraFor };
})(typeof window !== 'undefined' ? window : globalThis);
