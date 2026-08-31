// Link Checker Pro — content script
// Registered with all_frames:true, so this runs in the top page AND every
// same-origin iframe. Each frame collects its own links (including inside
// open shadow DOM subtrees); the top frame then asks child frames for their
// links via postMessage-free chrome messaging and merges everything.

(function () {
  'use strict';

  const isTopFrame = window.self === window.top;
  const FRAME_ID_ATTR = '__lcp_frame_marker__';

  // ── Recursively walk shadow roots to find every <a href> element ────────
  function collectAnchorsDeep(root, out) {
    const anchors = root.querySelectorAll('a[href]');
    anchors.forEach((a) => out.push(a));

    // Walk every element looking for open shadow roots.
    const all = root.querySelectorAll('*');
    all.forEach((el) => {
      if (el.shadowRoot) {
        collectAnchorsDeep(el.shadowRoot, out);
      }
    });
  }

  function collectLinksInThisFrame() {
    const origin = window.location.origin;
    const anchorEls = [];
    collectAnchorsDeep(document, anchorEls);

    const seen = new Map();
    const links = [];

    anchorEls.forEach((a, domIndex) => {
      const rawHref = a.getAttribute('href') || '';
      let href;
      try {
        href = a.href;
      } catch (e) {
        return;
      }

      if (!href || rawHref.trim() === '' || rawHref.trim().toLowerCase().startsWith('javascript:')) {
        return;
      }

      const isAnchorOnly = rawHref.trim().startsWith('#');
      const isMailto = href.toLowerCase().startsWith('mailto:');
      const isTel = href.toLowerCase().startsWith('tel:');

      let scope = 'external';
      if (isAnchorOnly) scope = 'anchor';
      else if (isMailto) scope = 'mailto';
      else if (isTel) scope = 'tel';
      else if (href.startsWith(origin)) scope = 'internal';

      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const nofollow = rel.includes('nofollow');
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140);

      let location = 'body';
      if (a.closest('header, nav, [role="navigation"], [role="banner"]')) location = 'header/nav';
      else if (a.closest('footer, [role="contentinfo"]')) location = 'footer';
      else if (a.closest('aside, [role="complementary"]')) location = 'sidebar';
      else if (a.closest('main, article, [role="main"]')) location = 'main content';

      if (!isTopFrame) location = 'iframe';

      const key = href;
      if (seen.has(key)) {
        seen.get(key).occurrences += 1;
        return;
      }

      const entry = {
        domIndex,
        href,
        rawHref,
        text: text || '(no text)',
        scope,
        rel: rel || '-',
        nofollow,
        target: a.getAttribute('target') || '-',
        location,
        occurrences: 1
      };

      seen.set(key, entry);
      links.push(entry);
    });

    return {
      pageUrl: window.location.href,
      pageTitle: document.title,
      totalAnchors: anchorEls.length,
      links
    };
  }

  // ── Highlighting ──────────────────────────────────────────────────────
  function applyHighlight(enabled) {
    const anchorEls = [];
    collectAnchorsDeep(document, anchorEls);
    anchorEls.forEach((a) => {
      if (enabled) a.classList.add('__lcp_highlight__');
      else a.classList.remove('__lcp_highlight__');
    });
  }

  function ensureHighlightStyle() {
    if (document.getElementById('__lcp_style__')) return;
    const style = document.createElement('style');
    style.id = '__lcp_style__';
    style.textContent = `
      a.__lcp_highlight__ {
        outline: 2px solid #ff5c5c !important;
        outline-offset: 2px !important;
        background: rgba(255, 92, 92, 0.12) !important;
      }
      a.__lcp_highlight_broken__ {
        outline: 2px solid #dc2626 !important;
        outline-offset: 2px !important;
        background: rgba(220, 38, 38, 0.18) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function highlightBroken(brokenHrefs) {
    ensureHighlightStyle();
    const set = new Set(brokenHrefs);
    const anchorEls = [];
    collectAnchorsDeep(document, anchorEls);
    anchorEls.forEach((a) => {
      if (set.has(a.href)) a.classList.add('__lcp_highlight_broken__');
      else a.classList.remove('__lcp_highlight_broken__');
    });
  }

  // ── Message handling ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'LCP_COLLECT_LINKS') {
      // Only the top frame responds with the merged summary shape;
      // background.js separately queries every frame and merges.
      sendResponse(collectLinksInThisFrame());
      return true;
    }
    if (msg && msg.type === 'LCP_HIGHLIGHT_ALL') {
      ensureHighlightStyle();
      applyHighlight(!!msg.enabled);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'LCP_HIGHLIGHT_BROKEN') {
      highlightBroken(msg.hrefs || []);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'LCP_OPEN_URL') {
      if (isTopFrame) window.open(msg.url, '_blank');
      sendResponse({ ok: true });
      return true;
    }
  });
})();
