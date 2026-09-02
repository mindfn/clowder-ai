/* Clowder AI — Roadmap page bootstrap: wires data → tree → cats → story → explorer. */
(function bootRoadmap() {
  const data = window.ClowderRoadmapTree;
  const lang = () => (document.documentElement.lang === 'zh' ? 'zh' : 'en');

  function fillLists() {
    const L = lang();
    const dotFor = (status) => {
      const dot = document.createElement('span');
      dot.className = `rt-dot rt-dot--${status}`;
      return dot;
    };
    for (const host of document.querySelectorAll('[data-rt-list]')) {
      host.textContent = '';
      const [kind, id] = host.dataset.rtList.split(':');
      if (kind === 'roots') {
        for (const root of data.roots) {
          const li = document.createElement('li');
          const b = document.createElement('strong');
          b.textContent = root.label[L];
          li.appendChild(b);
          li.appendChild(document.createTextNode(` · ${root.items.map((i) => i[L]).join(' · ')}`));
          host.appendChild(li);
        }
      } else if (kind === 'trunk') {
        for (const phase of data.trunk.phases) {
          const li = document.createElement('li');
          const b = document.createElement('strong');
          b.textContent = phase.label[L];
          li.appendChild(b);
          li.appendChild(document.createTextNode(` — ${phase.items.map((i) => i[L]).join(' · ')}`));
          host.appendChild(li);
        }
      } else if (kind === 'crown') {
        for (const outcome of data.crown) {
          const li = document.createElement('li');
          const b = document.createElement('strong');
          b.textContent = outcome.label[L];
          li.appendChild(b);
          li.appendChild(document.createTextNode(` — ${outcome.body[L]}`));
          host.appendChild(li);
        }
      } else if (kind === 'branch') {
        const branch = data.branches.find((b) => b.id === id);
        for (const limb of branch.limbs) {
          const box = document.createElement('div');
          box.className = 'rt-limb';
          const h = document.createElement('h3');
          h.textContent = limb.label[L];
          box.appendChild(h);
          const ul = document.createElement('ul');
          for (const fruit of limb.fruits) {
            const li = document.createElement('li');
            li.appendChild(dotFor(fruit.status));
            li.appendChild(document.createTextNode(fruit.label[L]));
            ul.appendChild(li);
          }
          box.appendChild(ul);
          host.appendChild(box);
        }
      }
    }
    for (const node of document.querySelectorAll('[data-rt-curated]')) node.textContent = data.curatedAt;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const svg = document.getElementById('rt-svg');
    const stage = document.getElementById('rt-stage');
    const rasterTree =
      new URLSearchParams(location.search).get('tree') === 'raster' ? 'assets/roadmap/tree/tree-wood.png' : null;
    const render = window.ClowderRoadmapRender.mount(svg, data, { lang: lang(), raster: rasterTree });
    const cats = window.ClowderRoadmapCats.mount(render.layers.cats, render.layers.scaffold, data, render.tree);
    const chapters = Array.from(document.querySelectorAll('.rt-chapter'));
    fillLists();
    const counts = window.ClowderRoadmapStory.buildExplorer(document.getElementById('rt-cards'), data, render);
    for (const [status, n] of Object.entries(counts)) {
      for (const node of document.querySelectorAll(`[data-rt-count="${status}"]`)) node.textContent = String(n);
    }
    window.ClowderRoadmapStory.init({
      stage,
      svg,
      chapters,
      rail: document.getElementById('rt-rail'),
      render,
      cats,
      tree: render.tree,
    });

    // Language toggle (main.js flips <html lang>); re-render text that lives in JS.
    document.getElementById('lang-toggle')?.addEventListener('click', () => {
      render.setLang(lang());
      fillLists();
      window.ClowderRoadmapStory.buildExplorer(document.getElementById('rt-cards'), data, render);
    });
  });
})();
