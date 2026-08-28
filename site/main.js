/* Clowder AI — Site Interactivity */

// Theme toggle
function initTheme() {
  const saved = localStorage.getItem('clowder-theme');
  if (saved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  updateThemeIcon();
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem('clowder-theme', isDark ? 'dark' : 'light');
  updateThemeIcon();
}

function updateThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.innerHTML = isDark
      ? '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    return;
  }
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// Language toggle (EN / 中文)
const I18N = {
  en: {
    'hero.tagline': 'Open Source Multi-Model AI Platform',
    'hero.title': 'AI Teams That<br>Grow With You',
    'hero.subtitle':
      'Not just agents — a team that learns, evolves, and grows alongside you.<br class="hidden sm:block">Plugins, self-awareness, self-evolution. All in the open.',
    'hero.slogan': 'Grow Together. Build Forever.',
  },
  zh: {
    'hero.tagline': '开源多模型 AI 团队平台',
    'hero.title': '与你一同成长的<br>AI 团队',
    'hero.subtitle':
      '不只是 Agent — 一支能学习、进化、与你共同成长的团队。<br class="hidden sm:block">插件系统、自感知、自进化。全部开源。',
    'hero.slogan': '共同成长，持续构建。',
  },
};

function initLang() {
  // Only apply language state on pages with the lang-toggle button
  // (only index.html has actual translations; other pages are English-only)
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  const saved = localStorage.getItem('clowder-lang') || 'en';
  document.documentElement.lang = saved;
  btn.textContent = saved === 'en' ? 'EN' : '中';
  applyLang(saved);
}

function toggleLang() {
  const current = document.documentElement.lang || 'en';
  const next = current === 'en' ? 'zh' : 'en';
  document.documentElement.lang = next;
  localStorage.setItem('clowder-lang', next);
  const btn = document.getElementById('lang-toggle');
  if (btn) btn.textContent = next === 'en' ? 'EN' : '中';
  applyLang(next);
}

function applyLang(lang) {
  const dict = I18N[lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) el.innerHTML = dict[key];
  });
}

// Feature tabs
function switchFeature(tabId) {
  document.querySelectorAll('.feature-tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.feature-panel').forEach((p) => p.classList.remove('active'));
  const tab = document.querySelector(`[data-tab="${tabId}"]`);
  const panel = document.getElementById(`feature-${tabId}`);
  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('active');
}

// Install tabs
function switchInstall(method) {
  document.querySelectorAll('.install-tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.install-panel').forEach((p) => p.classList.remove('active'));
  const tab = document.querySelector(`[data-install="${method}"]`);
  const panel = document.getElementById(`install-${method}`);
  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('active');
}

// Copy code to clipboard
function copyCode(btn) {
  const code = btn.closest('.code-container').querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent.trim()).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = orig;
    }, 1500);
  });
}

// Smooth scroll for anchor links
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.querySelector(a.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const menu = document.getElementById('mobile-menu');
        if (menu) menu.classList.add('hidden');
      }
    });
  });
}

// Mobile menu
function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('hidden');
}

// Roadmap (swimlane layout — no JS needed, purely CSS/Tailwind)
function initTimeline() {
  // Swimlane layout is static; kept as stub for DOMContentLoaded chain.
}

// Nav background on scroll
function initNavScroll() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  window.addEventListener('scroll', () => {
    nav.classList.toggle('shadow-md', window.scrollY > 20);
  });
}

// Floating TOC — shows on scroll, highlights active section
function initFloatingToc() {
  const toc = document.getElementById('floating-toc');
  if (!toc) return;

  const sections = ['features', 'scenarios', 'quickstart', 'first-steps', 'roadmap'];
  const sectionEls = sections.map((id) => document.getElementById(id)).filter(Boolean);
  const tocLinks = toc.querySelectorAll('.toc-link');

  // Show/hide TOC based on scroll position
  const heroEnd = document.querySelector('#features');
  if (!heroEnd) return;

  const showThreshold = heroEnd.offsetTop - 200;
  let tocVisible = false;

  function updateTocVisibility() {
    const shouldShow = window.scrollY > showThreshold;
    if (shouldShow !== tocVisible) {
      tocVisible = shouldShow;
      toc.style.opacity = shouldShow ? '1' : '0';
      toc.style.pointerEvents = shouldShow ? 'auto' : 'none';
    }
  }

  // Highlight active section via IntersectionObserver
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          tocLinks.forEach((l) => {
            const isActive = l.dataset.section === entry.target.id;
            l.classList.toggle('text-terracotta', isActive);
            l.classList.toggle('font-semibold', isActive);
            l.classList.toggle('bg-terracotta/5', isActive);
          });
        }
      });
    },
    { rootMargin: '-30% 0px -60% 0px' },
  );

  sectionEls.forEach((el) => observer.observe(el));
  window.addEventListener('scroll', updateTocVisibility, { passive: true });
  updateTocVisibility();
}

// GIF-like walkthrough videos: autoplay normally, hold on the first frame
// for people who request reduced motion.
function initWalkthroughVideos() {
  const videos = document.querySelectorAll('#first-steps video');
  if (!videos.length) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncPlayback = () => {
    videos.forEach((video) => {
      if (reducedMotion.matches) {
        video.pause();
        video.currentTime = 0;
      } else {
        video.play().catch(() => {});
      }
    });
  };

  syncPlayback();
  reducedMotion.addEventListener?.('change', syncPlayback);
}

// ===== Auto-fetch latest release for download buttons =====
async function initReleaseLinks() {
  try {
    const res = await fetch('https://api.github.com/repos/zts212653/clowder-ai/releases/latest');
    if (!res.ok) return;
    const release = await res.json();
    const ver = release.tag_name || release.name || '';
    const assets = release.assets || [];

    // Find Windows and Mac assets by extension
    const winAsset = assets.find((a) => /\.exe$/i.test(a.name) || /windows/i.test(a.name));
    const macAsset = assets.find((a) => /\.dmg$/i.test(a.name) || /macos|darwin/i.test(a.name));

    const winBtn = document.getElementById('dl-windows');
    const macBtn = document.getElementById('dl-mac');
    const winVer = document.getElementById('dl-windows-version');
    const macVer = document.getElementById('dl-mac-version');

    if (winBtn && winAsset) {
      winBtn.href = winAsset.browser_download_url;
      winBtn.textContent = `Download for Windows (${winAsset.name})`;
    }
    if (macBtn && macAsset) {
      macBtn.href = macAsset.browser_download_url;
      macBtn.textContent = `Download for macOS (${macAsset.name})`;
    }
    if (winVer) winVer.textContent = ver ? `Latest: ${ver}` : '';
    if (macVer) macVer.textContent = ver ? `Latest: ${ver}` : '';
  } catch (_) {
    // Silently fall back to /releases/latest links
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLang();
  initSmoothScroll();
  initTimeline();
  initNavScroll();
  initWalkthroughVideos();
  initFloatingToc();
  initReleaseLinks();
});
