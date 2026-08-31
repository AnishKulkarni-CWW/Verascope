// content.js — Based on the working approach: direct DOM append, absolute positioning,
// writing-mode forced inline, whiteSpace nowrap to prevent vertical text.

// Guard against being injected twice into the same page (e.g. once via
// manifest content_scripts, once via a manual chrome.scripting.executeScript
// call). Re-running this whole file a second time would try to redeclare
// `let active = ...` etc. in the same JS world and throw, which silently
// breaks all messaging. If we detect we're already loaded, do nothing.
if (!window.__altTextViewerLoaded) {
  window.__altTextViewerLoaded = true;

  let active = false;
  let overlayElements = new Map(); // img element -> overlay div
  let scrollListener, resizeListener;
  let observer;
  let updateTimer;

  function removeAllOverlays() {
    overlayElements.forEach((overlay) => overlay.remove());
    overlayElements.clear();
  }

  function repositionOverlay(img, overlay) {
    const rect = img.getBoundingClientRect();
    const top  = rect.top  + window.scrollY;
    const left = rect.right + window.scrollX - overlay.offsetWidth;
    overlay.style.top  = top  + 'px';
    overlay.style.left = left + 'px';
  }

  function refreshOverlays() {
    if (!active) return;

    const images = document.querySelectorAll('img');

    for (let img of overlayElements.keys()) {
      if (!img.isConnected) {
        overlayElements.get(img).remove();
        overlayElements.delete(img);
      }
    }

    images.forEach((img) => {
      if (overlayElements.has(img)) return;

      const rect = img.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      const alt = img.getAttribute('alt');
      const hasAlt = alt !== null && alt.trim() !== '';

      const overlay = document.createElement('div');

      if (hasAlt) {
        overlay.textContent = alt;
        overlay.style.color = '#ff0000';
        overlay.style.backgroundColor = '#00FF7F';
        overlay.style.padding = '4px 8px';
      } else {
        overlay.style.backgroundColor = '#ff0000';
        overlay.style.minWidth = '96px';
        overlay.style.width = '96px';
        overlay.style.minHeight = '24px';
        overlay.textContent = '';
      }

      overlay.style.writingMode = 'horizontal-tb';
      overlay.style.direction = 'ltr';
      overlay.style.textOrientation = 'mixed';
      overlay.style.whiteSpace = 'normal';
      overlay.style.unicodeBidi = 'isolate';

      overlay.style.position = 'absolute';
      overlay.style.zIndex = '2147483647';
      overlay.style.pointerEvents = 'none';
      overlay.style.fontSize = '14px';
      overlay.style.fontWeight = 'bold';
      overlay.style.fontFamily = 'Arial, Helvetica, sans-serif';
      overlay.style.borderRadius = '4px';
      overlay.style.boxSizing = 'border-box';
      overlay.style.lineHeight = '1.5';
      overlay.style.boxShadow = '0 2px 6px rgba(0,0,0,0.5)';
      overlay.style.maxWidth = '240px';
      overlay.style.wordBreak = 'break-word';
      overlay.style.overflowWrap = 'break-word';
      overlay.style.overflow = 'hidden';

      document.body.appendChild(overlay);
      overlayElements.set(img, overlay);

      repositionOverlay(img, overlay);

      img.addEventListener('load', () => {
        if (active && overlay.isConnected) repositionOverlay(img, overlay);
      });
    });

    overlayElements.forEach((overlay, img) => {
      repositionOverlay(img, overlay);
    });
  }

  function handleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => { if (active) refreshOverlays(); }, 100);
  }

  function enable() {
    if (active) return;
    active = true;
    refreshOverlays();

    scrollListener = () => requestAnimationFrame(handleUpdate);
    resizeListener = () => requestAnimationFrame(handleUpdate);
    window.addEventListener('scroll', scrollListener, true);
    window.addEventListener('resize', resizeListener);

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' || m.type === 'attributes') { handleUpdate(); break; }
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['alt', 'src']
    });
  }

  function disable() {
    if (!active) return;
    active = false;
    removeAllOverlays();
    if (scrollListener) window.removeEventListener('scroll', scrollListener, true);
    if (resizeListener) window.removeEventListener('resize', resizeListener);
    if (observer) observer.disconnect();
    clearTimeout(updateTimer);
  }

  // ── Report collection (for the Excel export) ──────────────────────

  // Many sites lazy-load images and keep the real URL in a data-*
  // attribute until the image scrolls into view, leaving img.src
  // empty or pointing at a tiny placeholder. Check the common
  // conventions so we still capture the real URL.
  function resolveImgSrc(img) {
    const candidates = [
      img.currentSrc,
      img.src,
      img.getAttribute('data-src'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-original-src'),
      img.getAttribute('data-srcset'),
      img.getAttribute('srcset')
    ];
    for (const c of candidates) {
      if (c && c.trim() && !c.trim().startsWith('data:image/gif')) {
        // srcset may contain multiple "url size," entries — take the first URL
        const first = c.trim().split(/\s+/)[0];
        if (first) return first;
      }
    }
    return '';
  }

  // Draws an <img> onto a canvas and reads it back out as a base64 PNG so
  // it can be embedded in the exported report. Cross-origin images without
  // permissive CORS headers taint the canvas — in that case we ask the
  // background service worker to fetch the raw bytes instead, since a
  // background fetch is not subject to the page's canvas-tainting rules.
  function drawToCanvas(sourceImg) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width  = sourceImg.naturalWidth  || sourceImg.width  || 1;
      canvas.height = sourceImg.naturalHeight || sourceImg.height || 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sourceImg, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null; // tainted canvas — CORS blocked
    }
  }

  function fetchViaBackground(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'fetchImageAsDataUrl', url }, (response) => {
        if (chrome.runtime.lastError || !response || !response.dataUrl) {
          resolve(null);
        } else {
          resolve(response.dataUrl);
        }
      });
    });
  }

  async function getImageDataUrl(img, resolvedSrc) {
    // 1) Try direct canvas draw off the live element (fast path, works
    //    for same-origin images and any image the browser already
    //    loaded permissively).
    if (img.complete && img.naturalWidth > 0) {
      const direct = drawToCanvas(img);
      if (direct) return direct;
    }

    // 2) Try loading a fresh Image() with crossOrigin='anonymous' —
    //    works if the server sends CORS headers even if the original
    //    <img> tag didn't request them.
    if (resolvedSrc) {
      const viaProxyImg = await new Promise((resolve) => {
        const proxyImg = new Image();
        proxyImg.crossOrigin = 'anonymous';
        proxyImg.onload = () => resolve(drawToCanvas(proxyImg));
        proxyImg.onerror = () => resolve(null);
        proxyImg.src = resolvedSrc;
      });
      if (viaProxyImg) return viaProxyImg;
    }

    // 3) Last resort: ask the background service worker to fetch the
    //    image bytes directly and base64-encode them. This bypasses
    //    canvas tainting entirely since no canvas is involved.
    if (resolvedSrc) {
      const viaBackground = await fetchViaBackground(resolvedSrc);
      if (viaBackground) return viaBackground;
    }

    return null;
  }

  // ── Accessible-name checks for non-<img> visual elements ──────────
  // Icon sets (social links, nav icons, etc.) are very often rendered
  // as inline <svg>, or as an empty element with a CSS background-image,
  // rather than as an <img>. These have no "alt" attribute at all — the
  // correct accessibility check for them is different:
  //   - inline <svg>: needs a <title> child, or aria-label/aria-labelledby
  //   - CSS background-image element: needs aria-label (or visually
  //     hidden text), since there is no img-level attribute possible
  // We report these separately so they aren't silently skipped, while
  // keeping the <img>/alt check exactly as before.

  function svgAccessibleName(svg) {
    const ariaLabel = svg.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = svg.getAttribute('aria-labelledby');
    if (labelledBy) {
      const el = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }

    const titleEl = svg.querySelector(':scope > title');
    if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();

    return '';
  }

  function collectInlineSvgs() {
    const svgs = Array.from(document.querySelectorAll('svg'));
    const results = [];
    for (const svg of svgs) {
      const rect = svg.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      // Skip purely decorative SVGs explicitly marked as such —
      // aria-hidden="true" means the browser already treats it as
      // decorative on purpose, so it's not a real gap.
      if (svg.getAttribute('aria-hidden') === 'true') continue;

      const name = svgAccessibleName(svg);
      results.push({ el: svg, rect, name });
    }
    return results;
  }

  function collectBackgroundImageIcons() {
    // Elements with no visible text content but a CSS background-image
    // are a common icon pattern (e.g. <a class="icon-facebook">).
    const candidates = Array.from(document.querySelectorAll('a, span, div, i, button'));
    const results = [];
    for (const el of candidates) {
      // Skip if it contains an <img> or <svg> already counted above —
      // avoid double-reporting the same visual icon.
      if (el.querySelector('img, svg')) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10 || rect.width > 200 || rect.height > 200) continue;

      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === 'none') continue;

      // Must have essentially no text content to count as an "icon"
      if (el.textContent && el.textContent.trim().length > 0) continue;

      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const name = ariaLabel.trim() || title.trim();

      results.push({ el, rect, name, bg });
    }
    return results;
  }

  // Renders a DOM element (svg or background-image icon) to a data URL
  // via SVG-foreignObject snapshotting, so it can be embedded in the
  // report the same way an <img> would be.
  function elementToDataUrl(el, width, height) {
    try {
      const clone = el.cloneNode(true);
      const svgWrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgWrapper.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgWrapper.setAttribute('width', width);
      svgWrapper.setAttribute('height', height);

      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      foreignObject.setAttribute('width', '100%');
      foreignObject.setAttribute('height', '100%');

      if (el.tagName.toLowerCase() === 'svg') {
        svgWrapper.appendChild(clone);
      } else {
        const wrapperDiv = document.createElement('div');
        const computedBg = window.getComputedStyle(el).backgroundImage;
        wrapperDiv.style.width = width + 'px';
        wrapperDiv.style.height = height + 'px';
        wrapperDiv.style.backgroundImage = computedBg;
        wrapperDiv.style.backgroundSize = window.getComputedStyle(el).backgroundSize || 'contain';
        wrapperDiv.style.backgroundRepeat = 'no-repeat';
        wrapperDiv.style.backgroundPosition = 'center';
        foreignObject.appendChild(wrapperDiv);
        svgWrapper.appendChild(foreignObject);
      }

      const svgString = new XMLSerializer().serializeToString(svgWrapper);
      const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));

      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          try {
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png'));
          } catch (e) {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = svgDataUrl;
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  async function collectImageReport() {
    const images = Array.from(document.querySelectorAll('img'));
    const rows = [];

    for (const img of images) {
      const rect = img.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      const alt = img.getAttribute('alt');
      const hasAlt = alt !== null && alt.trim() !== '';
      const resolvedSrc = resolveImgSrc(img);
      const dataUrl = await getImageDataUrl(img, resolvedSrc);

      rows.push({
        src: resolvedSrc,
        dataUrl: dataUrl,
        alt: hasAlt ? alt : '',
        status: hasAlt ? 'Present' : 'Missing',
        color: hasAlt ? '#00FF7F' : '#ff0000',       // matches on-page overlay
        textColor: hasAlt ? '#ff0000' : '#ffffff',
        pageUrl: window.location.href,
        pageTitle: document.title,
        elementType: 'img'
      });
    }

    // Inline SVG icons (e.g. social links rendered as <svg>, not <img>)
    const svgIcons = collectInlineSvgs();
    for (const { el, rect, name } of svgIcons) {
      const hasName = name && name.trim() !== '';
      const dataUrl = await elementToDataUrl(el, Math.round(rect.width), Math.round(rect.height));

      rows.push({
        src: '(inline SVG)',
        dataUrl,
        alt: hasName ? name : '',
        status: hasName ? 'Present' : 'Missing',
        color: hasName ? '#00FF7F' : '#ff0000',
        textColor: hasName ? '#ff0000' : '#ffffff',
        pageUrl: window.location.href,
        pageTitle: document.title,
        elementType: 'inline svg (needs <title>/aria-label)'
      });
    }

    // CSS background-image icon elements (no <img>/<svg> at all)
    const bgIcons = collectBackgroundImageIcons();
    for (const { el, rect, name, bg } of bgIcons) {
      const hasName = name && name.trim() !== '';
      const dataUrl = await elementToDataUrl(el, Math.round(rect.width), Math.round(rect.height));

      rows.push({
        src: bg,
        dataUrl,
        alt: hasName ? name : '',
        status: hasName ? 'Present' : 'Missing',
        color: hasName ? '#00FF7F' : '#ff0000',
        textColor: hasName ? '#ff0000' : '#ffffff',
        pageUrl: window.location.href,
        pageTitle: document.title,
        elementType: 'CSS background-image icon (needs aria-label)'
      });
    }

    return rows;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (message.action === 'toggleAltDisplay') {
      message.active ? enable() : disable();
      return;
    }

    if (message.action === 'exportReport') {
      collectImageReport().then((rows) => {
        sendResponse({ rows });
      });
      return true; // keep the message channel open for the async response
    }
  });

  // Restore state if tab was already active
  chrome.runtime.sendMessage({ action: 'getAltState' }, (response) => {
    if (response && response.active) enable();
  });
}
