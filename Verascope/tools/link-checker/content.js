// Link Checker Pro — content script
// Collects every <a> link on the page, from the very top of the DOM
// (site nav / header) to the very bottom (footer), plus lets the
// popup highlight links live on the page.

(function () {
  'use strict';

  function collectLinks() {
    const origin = window.location.origin;
    const anchors = document.querySelectorAll('a[href]');
    const seen = new Map();
    const links = [];

    anchors.forEach((a, domIndex) => {
      const rawHref = a.getAttribute('href') || '';
      const href = a.href; // resolved absolute URL

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

      // Rough page location: which landmark region the link lives in.
      let location = 'body';
      if (a.closest('header, nav, [role="navigation"], [role="banner"]')) location = 'header/nav';
      else if (a.closest('footer, [role="contentinfo"]')) location = 'footer';
      else if (a.closest('aside, [role="complementary"]')) location = 'sidebar';
      else if (a.closest('main, article, [role="main"]')) location = 'main content';

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
      totalAnchors: anchors.length,
      links
    };
  }

  function applyHighlight(enabled) {
    document.querySelectorAll('a[href]').forEach((a) => {
      if (enabled) {
        a.classList.add('__lcp_highlight__');
      } else {
        a.classList.remove('__lcp_highlight__');
      }
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
    document.querySelectorAll('a[href]').forEach((a) => {
      if (set.has(a.href)) {
        a.classList.add('__lcp_highlight_broken__');
        a.scrollIntoView; // no-op reference, avoids tree-shaking in some bundlers
      } else {
        a.classList.remove('__lcp_highlight_broken__');
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'LCP_COLLECT_LINKS') {
      sendResponse(collectLinks());
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
      window.open(msg.url, '_blank');
      sendResponse({ ok: true });
      return true;
    }
  });
})();
